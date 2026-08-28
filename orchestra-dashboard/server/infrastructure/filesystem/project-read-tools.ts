import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { redactSecrets } from '../../application/agents/agent-data-utils.js';

export interface ProjectReadTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const EXCLUDED = new Set([
  '.agents',
  '.codex',
  '.git',
  '.gradle',
  '.idea',
  '.next',
  '.orchestra',
  '.turbo',
  '.cache',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
]);

// Matches files containing sensitive credentials, keys, or secrets (e.g. .env, credentials.json, .secrets/config.json, credentials-prod.json, secrets.yaml, *.pem, *.key, id_rsa)
// Does NOT match standard application code paths like src/auth.ts, src/token.ts, or auth/
const SENSITIVE = /(^|[\\/])(?:\.env(?:\..*)?|\.?(?:[\w.-]*[-_])?(?:credentials?|secrets?)(?:[-_][\w.-]*)?(?:\.[^\\/]+)?|.*(?:client_secret|private_key|service[-_]account).*\.[^\\/]+|local\.properties|.*\.(?:pfx|p12|jks|keystore|pem|key|p8)|id_[dr]sa.*|id_ed25519.*)(?:[\\/]|$)/i;

const TEXT = new Set([
  '.astro', '.c', '.cc', '.cpp', '.cs', '.csproj', '.css', '.dart', '.erl',
  '.ex', '.exs', '.fsproj', '.go', '.gql', '.gradle', '.graphql', '.h',
  '.hpp', '.html', '.java', '.jl', '.js', '.json', '.json5', '.jsonc',
  '.jsx', '.kt', '.kts', '.lua', '.md', '.mdx', '.mjs', '.nim', '.php',
  '.props', '.proto', '.ps1', '.py', '.r', '.rb', '.rs', '.scala', '.sh',
  '.sln', '.sql', '.svelte', '.swift', '.targets', '.toml', '.ts', '.tsx',
  '.txt', '.vbproj', '.vue', '.xml', '.yaml', '.yml', '.zig',
]);

function isAllowedTextFile(filePath: string): boolean {
  const name = basename(filePath).toLowerCase();
  return TEXT.has(extname(name)) || /^(?:readme(?:\.[^.]+)?|license(?:\.[^.]+)?|dockerfile(?:\.[^.]+)?|makefile|go\.(?:mod|sum|work)|gemfile(?:\.lock)?|pipfile(?:\.lock)?|poetry\.lock|cargo\.lock)$/i.test(name);
}

export function getProjectReadTools(): ProjectReadTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'project_list_files',
        description: 'List files under the selected project root using an optional relative directory.',
        parameters: {
          type: 'object',
          properties: { directory: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'project_read_file',
        description: 'Read one non-sensitive text file under the selected project root.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'project_search_text',
        description: 'Search non-sensitive project text files for a literal string.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
  ];
}

export function callProjectReadTool(rootInput: string, name: string, args: Record<string, unknown>) {
  const root = realpathSync.native(resolve(rootInput));
  if (name === 'project_list_files') return JSON.stringify(listFiles(root, optionalString(args.directory)));
  if (name === 'project_read_file') {
    const path = safeFile(root, requiredString(args.path, 'path'));
    if (!isAllowedTextFile(path)) {
      throw new Error('Only recognized project text files can be read.');
    }
    const stat = lstatSync(path);
    if (stat.size > 750_000) throw new Error('The requested project file exceeds the 750 KB read limit.');
    const content = readFileSync(path, 'utf8');
    if (content.includes('\0')) throw new Error('Binary project files cannot be read through this tool.');
    const redacted = redactSecrets(content);
    const MAX_CHAR_LIMIT = 40_000;
    if (redacted.length > MAX_CHAR_LIMIT) {
      return `${redacted.slice(0, MAX_CHAR_LIMIT)}\n\n[TRUNCATED: File exceeds 40,000 characters (${redacted.length} characters total). Use project_search_text to locate specific content.]`;
    }
    return redacted;
  }
  if (name === 'project_search_text') {
    const query = requiredString(args.query, 'query');
    if (query.length > 200) throw new Error('Search query must be 200 characters or fewer.');
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let totalBytesRead = 0;
    const MAX_TOTAL_BYTES = 4_000_000; // 4 MB budget
    for (const path of listFiles(root, '', 300, isAllowedTextFile)) {
      if (matches.length >= 50 || totalBytesRead >= MAX_TOTAL_BYTES) break;
      const fullPath = join(root, path);
      try {
        const stat = lstatSync(fullPath);
        if (stat.isSymbolicLink() || stat.size > 200_000) continue;
        if (totalBytesRead + stat.size > MAX_TOTAL_BYTES) break;
        totalBytesRead += stat.size;
        const content = readFileSync(fullPath, 'utf8');
        if (content.includes('\0')) continue;
        for (const [index, line] of content.split(/\r?\n/).entries()) {
          if (line.toLowerCase().includes(query.toLowerCase())) {
            matches.push({ path, line: index + 1, text: redactSecrets(line.trim()).slice(0, 300) });
            if (matches.length >= 50) break;
          }
        }
      } catch { continue; }
    }
    return JSON.stringify(matches);
  }
  throw new Error(`Unknown project read tool: ${name}`);
}

export function buildProjectOverview(rootInput: string) {
  const root = realpathSync.native(resolve(rootInput));
  const files = listFiles(root, '', 300);
  const preferred = files.filter((path) => !path.includes('/') && /^(?:readme(?:\.[^.]+)?|package\.json|pyproject\.toml|cargo\.toml|build\.gradle(?:\.kts)?|pom\.xml|requirements\.txt|go\.mod)$/i.test(path)).slice(0, 4);
  const sections = [`Project file inventory:\n${JSON.stringify(files).slice(0, 6_000)}`];
  for (const path of preferred) {
    try { sections.push(`${path}:\n${callProjectReadTool(root, 'project_read_file', { path }).slice(0, 6_000)}`); }
    catch { /* A disappearing optional overview file does not invalidate the inventory. */ }
  }
  return sections.join('\n\n').slice(0, 12_000);
}

function listFiles(root: string, relativeDirectory = '', limit = 500, filter?: (path: string) => boolean) {
  const start = safeDirectory(root, relativeDirectory);
  const output: string[] = [];
  let visitedDirs = 0;
  const MAX_VISITED_DIRS = 200;
  const MAX_DEPTH = 8;
  const visit = (directory: string, depth: number) => {
    if (output.length >= limit || visitedDirs >= MAX_VISITED_DIRS || depth > MAX_DEPTH) return;
    visitedDirs += 1;
    let children;
    try { children = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    const visible = children.filter((child) => !child.isSymbolicLink() && !EXCLUDED.has(child.name.toLowerCase()));
    for (const child of visible.filter((entry) => entry.isFile())) {
      if (output.length >= limit) return;
      const absolute = join(directory, child.name);
      const rel = relative(root, absolute).replaceAll('\\', '/');
      if (!rel || rel.startsWith('../') || SENSITIVE.test(rel)) continue;
      if (filter && !filter(rel)) continue;
      output.push(rel);
    }
    for (const child of visible.filter((entry) => entry.isDirectory())) {
      if (output.length >= limit || visitedDirs >= MAX_VISITED_DIRS || depth >= MAX_DEPTH) return;
      visit(join(directory, child.name), depth + 1);
    }
  };
  visit(start, 0);
  return output;
}

function safeDirectory(root: string, value: string) {
  const normalized = (value || '').replaceAll('\\', '/').trim();
  if (!normalized || normalized === '.' || normalized === './') return root;
  const candidate = containedPath(root, value);
  if (!lstatSync(candidate).isDirectory()) throw new Error('Requested project path is not a directory.');
  return candidate;
}

function safeFile(root: string, value: string) {
  const candidate = containedPath(root, value);
  if (!lstatSync(candidate).isFile()) throw new Error('Requested project path is not a file.');
  return candidate;
}

function containedPath(root: string, value: string) {
  if (!value || value.includes('\0')) throw new Error('The requested project path is not allowed.');
  const normalized = value.replaceAll('\\', '/').trim();
  if (normalized === '.' || normalized === './') return root;
  const rawCandidate = resolve(root, value);
  const rawRel = relative(root, rawCandidate).replaceAll('\\', '/');
  if (!rawRel || rawRel === '.' || rawRel === '') return root;
  if (rawRel.startsWith('..') || resolve(root, rawRel) !== rawCandidate) {
    throw new Error('The requested path is outside the selected project root.');
  }
  if (SENSITIVE.test(rawRel)) {
    throw new Error('The requested project path is not allowed.');
  }
  // Check that no component along the path from root to rawCandidate is a symbolic link
  let current = rawCandidate;
  while (current.length >= root.length) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error('Symbolic links are not permitted in project tools.');
      }
    } catch (e: any) {
      if (e.message?.includes('Symbolic links')) throw e;
      throw e;
    }
    if (current === root) break;
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  const realCandidate = realpathSync.native(rawCandidate);
  const realRel = relative(root, realCandidate).replaceAll('\\', '/');
  if (!realRel || realRel === '.' || realRel === '') return root;
  if (realRel.startsWith('..') || resolve(root, realRel) !== realCandidate) {
    throw new Error('The requested path is outside the selected project root.');
  }
  if (SENSITIVE.test(realRel)) {
    throw new Error('The requested project path is not allowed.');
  }
  return realCandidate;
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}
function optionalString(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }

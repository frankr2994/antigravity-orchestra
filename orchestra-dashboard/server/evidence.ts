import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import type { GitStatus } from './git.js';

export interface RepositoryEvidence {
  root: string;
  text: string;
  files: string[];
  includedFiles: string[];
  characterCount: number;
  estimatedTokens: number;
  truncated: boolean;
}

const EXCLUDED_DIRECTORIES = new Set(['.git', '.gradle', '.idea', '.orchestra', '.cache', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor']);
const SENSITIVE_NAMES = /(^|\/)(\.env(?:\..*)?|local\.properties|credentials?|secrets?|.*\.keystore|.*\.jks|.*\.pfx|.*\.p12|id_[dr]sa)(\/|$)/i;
const TEXT_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cs', '.css', '.go', '.gradle', '.h', '.hpp', '.html', '.java', '.js', '.json', '.kt', '.kts', '.md', '.mjs', '.ps1', '.py', '.rs', '.sh', '.sql', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml']);
const IMPORTANT_NAMES = /^(readme(?:\..*)?|roadmap(?:\..*)?|contributing(?:\..*)?|package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|cmakelists\.txt|makefile)$/i;

export function collectRepositoryEvidence(rootInput: string, prompt: string, git?: GitStatus, maxChars = 120_000): RepositoryEvidence {
  const root = realpathSync.native(resolve(rootInput));
  const entries: Array<{ path: string; size: number; score: number }> = [];
  const allFiles: string[] = [];
  const promptTerms = [...new Set(prompt.toLowerCase().match(/[a-z0-9_.-]{4,}/g) || [])].slice(0, 24);
  const asksAboutAgentMetadata = /\b(?:agents?|workflow|orchestra|codex|antigravity)\b/i.test(prompt);
  let visited = 0;

  const visit = (directory: string, depth: number) => {
    if (depth > 9 || visited >= 5000) return;
    let children;
    try { children = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      if (visited++ >= 5000 || child.isSymbolicLink()) continue;
      if (child.isDirectory() && EXCLUDED_DIRECTORIES.has(child.name.toLowerCase())) continue;
      const absolute = join(directory, child.name);
      const path = relative(root, absolute).replaceAll('\\', '/');
      if (!path || path.startsWith('../') || SENSITIVE_NAMES.test(path)) continue;
      if (child.isDirectory()) { visit(absolute, depth + 1); continue; }
      if (!child.isFile()) continue;
      let size = 0;
      try { size = lstatSync(absolute).size; } catch { continue; }
      allFiles.push(path);
      const extension = extname(child.name).toLowerCase();
      if ((!TEXT_EXTENSIONS.has(extension) && !IMPORTANT_NAMES.test(child.name)) || size > 750_000) continue;
      const lower = path.toLowerCase();
      let score = IMPORTANT_NAMES.test(child.name) ? 100 : lower.startsWith('docs/') ? 55 : lower.includes('/src/') ? 30 : 15;
      if (!path.includes('/')) score += 30;
      if (!asksAboutAgentMetadata && (lower === 'agents.md' || lower.startsWith('.agents/') || lower.startsWith('.codex/'))) score -= 80;
      for (const term of promptTerms) if (lower.includes(term)) score += 18;
      entries.push({ path, size, score });
    }
  };
  visit(root, 0);
  entries.sort((a, b) => b.score - a.score || a.size - b.size || a.path.localeCompare(b.path));

  allFiles.sort((a, b) => a.localeCompare(b));
  const treeLimit = Math.min(2000, allFiles.length);
  const sections = [
    `# Repository evidence\nAuthoritative root: ${root}`,
    git ? `## Git snapshot\nRepository: ${git.isGit}\nBranch: ${git.branch || 'unknown'}\nHEAD: ${git.head || 'unknown'}\nDirty: ${git.dirty}\nChanged paths: ${git.files.slice(0, 80).map((file) => file.path).join(', ') || 'none'}` : '',
    `## File inventory (${allFiles.length}${visited >= 5000 ? '+' : ''} files discovered; content is included only for ranked text files)\n${allFiles.slice(0, treeLimit).join('\n')}`,
  ].filter(Boolean);
  const includedFiles: string[] = [];
  let used = sections.join('\n\n').length;
  let truncated = treeLimit < allFiles.length || visited >= 5000;
  for (const entry of entries.slice(0, 28)) {
    if (used >= maxChars) { truncated = true; break; }
    const allowance = Math.min(24_000, maxChars - used - 100);
    if (allowance < 1000) { truncated = true; break; }
    let content: string;
    try { content = readFileSync(join(root, entry.path), 'utf8'); } catch { continue; }
    if (content.includes('\0')) continue;
    const redacted = redactEvidence(content).slice(0, allowance);
    sections.push(`## File: ${entry.path}\n${redacted}`);
    includedFiles.push(entry.path);
    used += redacted.length + entry.path.length + 20;
    if (redacted.length < content.length) truncated = true;
  }
  const text = sections.join('\n\n').slice(0, maxChars);
  return { root, text, files: allFiles, includedFiles, characterCount: text.length, estimatedTokens: Math.ceil(text.length / 4), truncated };
}

function redactEvidence(value: string) {
  return value
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"']+/gi, '$1=[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED_TOKEN]')
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}

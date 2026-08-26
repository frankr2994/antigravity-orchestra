import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactHeadAndTail } from '../gemma/context-budget.js';
import { redactSecrets } from '../agents/agent-data-utils.js';

export function codexShellGuidance(platform = process.platform) {
  return platform === 'win32'
    ? '\nThis host is Windows. Use PowerShell-compatible commands, one command per tool call. Quote ripgrep alternation patterns with double quotes, do not use cmd/findstr fallbacks, and prefer Rider semantic reads when shell quoting would be fragile.'
    : '';
}

export function attachTrustedLocalArtifacts(prompt: string, trustedRoot = resolve(process.env.USERPROFILE || '', '.gemini', 'antigravity-cli', 'brain')) {
  if (!trustedRoot || !existsSync(trustedRoot)) return prompt;
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync.native(trustedRoot); } catch { return prompt; }
  const attachments: string[] = [];
  const seen = new Set<string>();
  for (const match of prompt.matchAll(/\[[^\]]+\]\((file:\/\/\/[^)]+\.(?:md|txt))\)/gi)) {
    if (attachments.length >= 3) break;
    try {
      const path = realpathSync.native(fileURLToPath(match[1]));
      const rel = relative(canonicalRoot, path);
      if (!rel || rel.startsWith('..') || resolve(canonicalRoot, rel) !== path || seen.has(path)) continue;
      if (!['.md', '.txt'].includes(extname(path).toLowerCase()) || statSync(path).size > 100_000) continue;
      seen.add(path);
      const content = compactHeadAndTail(redactSecrets(readFileSync(path, 'utf8')), 40_000, `local artifact ${rel}`);
      attachments.push(`### ${rel.replaceAll('\\', '/')}\n\n${content}`);
    } catch { /* An unavailable or unsafe local link remains a plain reference. */ }
  }
  return attachments.length ? `${prompt}\n\n## Attached local artifact snapshots\n\n${attachments.join('\n\n')}` : prompt;
}

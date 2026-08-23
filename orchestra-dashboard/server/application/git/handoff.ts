import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function appendHandoff(root: string, summary: string, title: string) {
  const path = join(root, 'docs', 'HANDOFF.md');
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, 'utf8').trimEnd() : '# Project Handoff';
  const entry = `\n\n## [${new Date().toISOString()}] ${title}\n\n${summary.trim()}\n`;
  writeFileSync(path, `${existing}${entry}`, 'utf8');
}

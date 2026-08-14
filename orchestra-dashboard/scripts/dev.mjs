import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const checkOnly = process.argv.includes('--check');
const tsx = resolve('node_modules/tsx/dist/cli.mjs');
const vite = resolve('node_modules/vite/bin/vite.js');
const children = [
  spawn(process.execPath, checkOnly ? [tsx, '--version'] : [tsx, 'watch', 'server/index.ts'], { stdio: 'inherit', shell: false }),
  spawn(process.execPath, checkOnly ? [vite, '--version'] : [vite], { stdio: 'inherit', shell: false }),
];

let stopping = false;
let completed = 0;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 250).unref();
}

for (const child of children) {
  child.on('exit', (code) => {
    if (stopping) return;
    if (code) stop(code);
    else if (checkOnly && ++completed === children.length) stop(0);
  });
  child.on('error', (error) => {
    console.error(error);
    stop(1);
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

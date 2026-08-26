import { dirname, relative, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { callGemma, type JsonSchema } from '../../providers/lmstudio/chat-client.js';
import { parseJson } from '../agents/agent-data-utils.js';

const GEMMA_MICRO_TASK_SCHEMA: JsonSchema = { name: 'gemma_micro_task_execution', schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, action: { type: 'string', enum: ['overwrite', 'create'] }, content: { type: 'string' } }, required: ['path', 'action', 'content'], additionalProperties: false } }, explanation: { type: 'string' } }, required: ['files', 'explanation'], additionalProperties: false } };

export async function executeGemmaMicroTask(input: {
  root: string;
  prompt: string;
  signal: AbortSignal;
  onOutput?: (chunk: string) => void;
  onUsage?: (usage: Record<string, number>) => void;
}): Promise<{ success: boolean; result: string; changedFiles: string[] }> {
  const text = await callGemma([
    {
      role: 'system',
      content: 'You are a precise coding assistant for targeted micro-tasks (under 30 lines changed). Generate the complete file content for target files. Return JSON: {"files": [{"path": "relative/path", "action": "overwrite"|"create", "content": "full file content"}], "explanation": "what was done"}',
    },
    {
      role: 'user',
      content: `Directory: ${input.root}\n\nTask:\n${input.prompt}`,
    },
  ], 2000, 60_000, GEMMA_MICRO_TASK_SCHEMA, false, undefined, input.onUsage);

  const parsed = parseJson(text) as { files?: Array<{ path: string; action: string; content: string }>; explanation?: string };
  if (!Array.isArray(parsed.files) || !parsed.files.length) {
    throw new Error('Gemma did not produce any micro-task file operations.');
  }

  const changedFiles: string[] = [];
  for (const file of parsed.files) {
    const fullPath = resolve(input.root, file.path);
    const child = relative(resolve(input.root), fullPath);
    if (!child || child.startsWith('..') || resolve(input.root, child) !== fullPath) {
      throw new Error(`Gemma proposed an unsafe project path '${file.path}'.`);
    }
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, 'utf8');
    changedFiles.push(file.path);
    input.onOutput?.(`Gemma applied micro-edit to ${file.path}\n`);
  }

  return {
    success: true,
    result: parsed.explanation || 'Applied local micro-task changes with Gemma.',
    changedFiles,
  };
}


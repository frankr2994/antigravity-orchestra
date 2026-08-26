import { config } from '../../config.js';
import type { RepositoryEvidence } from '../../evidence.js';
import { getActiveLmStudioModel } from '../../lmstudio.js';
import { GemmaDirectChatProtocolError, validateGemmaDirectChatResponse } from '../../application/gemma/direct-chat-contract.js';

export async function runGemmaDirectChat(input: {
  root: string;
  prompt: string;
  model?: string | null;
  evidence?: RepositoryEvidence;
  sessionContext?: string;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
  onToolActivity?: (activity: { tool: string; status: 'started' | 'completed' | 'failed'; detail?: string }) => void;
  onUsage?: (usage: Record<string, number>) => void;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const model = input.model || await getActiveLmStudioModel();
  const system = `You are Gemma, the local AI software engineering assistant in Antigravity Orchestra. You are in a direct 1-on-1 consultation with the developer.
The authoritative active repository is: ${input.root}.

This chat mode does not provide Bash, shell, terminal, filesystem, or other executable tools. Never emit tool-call syntax, function-call envelopes, special control tokens, or pretend that a command ran. Answer in ordinary user-facing Markdown. If the supplied evidence cannot establish the answer, state what is missing.${input.evidence ? `

Below is the repository evidence, including Git status, recent commit history, and the full contents of key project files:

${input.evidence.text}

Instructions:
- Use the repository evidence above to directly review files, analyze architecture, explain commits, and answer questions.
- Never claim you lack access to the project files or ask the user to paste files that are present in the evidence.
- Answer thoroughly and helpfully in GitHub-flavored Markdown with concrete code blocks.` : ''}`;

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: system },
    ...(input.sessionContext ? [{ role: 'system', content: `Session context:\n${input.sessionContext}` }] : []),
    { role: 'user', content: input.prompt },
  ];
  const fetchFn = input.fetchFn || fetch;
  const signal = input.signal || AbortSignal.timeout(180_000);
  let firstFailure: unknown;
  try {
    const response = await fetchFn(`${config.lmStudioBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 4000,
        stream: true,
      }),
      signal,
    });
    if (!response.ok) throw new Error(`LM Studio HTTP ${response.status}: ${await readLmStudioError(response)}`);
    const answer = response.headers.get('content-type')?.includes('application/json')
      ? await readGemmaDirectJson(response, input.onUsage)
      : await readGemmaDirectStream(response, input.onUsage);
    input.onOutput?.(answer);
    return answer;
  } catch (error) {
    if (input.signal?.aborted) throw error;
    firstFailure = error;
  }

  try {
    const repairMessages = [
      ...messages,
      { role: 'system', content: 'The prior response was unusable. Return one direct answer in ordinary Markdown only. Do not request or describe a tool call, do not emit control tokens, and do not claim that any command ran.' },
    ];
    const response = await fetchFn(`${config.lmStudioBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: repairMessages, temperature: 0.2, max_tokens: 4000, stream: false }),
      signal,
    });
    if (!response.ok) throw new Error(`LM Studio HTTP ${response.status}: ${await readLmStudioError(response)}`);
    const answer = await readGemmaDirectJson(response, input.onUsage);
    input.onOutput?.(answer);
    return answer;
  } catch (repairFailure) {
    const decisiveFailure = repairFailure instanceof GemmaDirectChatProtocolError
      ? repairFailure
      : firstFailure instanceof GemmaDirectChatProtocolError ? firstFailure : repairFailure;
    if (decisiveFailure instanceof GemmaDirectChatProtocolError) throw decisiveFailure;
    throw new Error(`Direct Gemma chat error: ${decisiveFailure instanceof Error ? decisiveFailure.message : String(decisiveFailure)}`);
  }
}

async function readGemmaDirectStream(response: Response, onUsage?: (usage: Record<string, number>) => void): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('LM Studio returned a streaming response without a body.');
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let sawData = false;

  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':') || /^(?:event|id|retry):/i.test(trimmed)) return;
    if (!trimmed.startsWith('data:')) throw new Error('LM Studio returned malformed streaming data.');
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') return;
    sawData = true;
    let value: unknown;
    try { value = JSON.parse(payload); }
    catch { throw new Error('LM Studio returned malformed streaming JSON.'); }
    const usage = lmStudioUsage(value);
    if (usage) onUsage?.(usage);
    accumulated += directContentFromPayload(value);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) consume(line);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  if (!sawData) throw new Error('LM Studio returned no streaming response data.');
  return validateGemmaDirectChatResponse(accumulated);
}

async function readGemmaDirectJson(response: Response, onUsage?: (usage: Record<string, number>) => void): Promise<string> {
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new Error('LM Studio returned malformed response JSON.'); }
  const usage = lmStudioUsage(value);
  if (usage) onUsage?.(usage);
  return validateGemmaDirectChatResponse(directContentFromPayload(value));
}

export function lmStudioUsage(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = (value as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const result = Object.fromEntries(Object.entries(usage).flatMap(([key, raw]) => Number.isSafeInteger(Number(raw)) && Number(raw) >= 0 ? [[key, Number(raw)]] : []));
  return Object.keys(result).length ? result : null;
}

function directContentFromPayload(value: unknown): string {
  const root = asRecord(value, 'LM Studio response');
  const choices = root.choices;
  if (choices !== undefined && !Array.isArray(choices)) throw new Error('LM Studio response choices must be an array.');
  const choice = Array.isArray(choices) && choices.length ? asRecord(choices[0], 'LM Studio response choice') : null;
  const delta = choice?.delta === undefined || choice.delta === null ? null : asRecord(choice.delta, 'LM Studio response delta');
  const message = choice?.message === undefined || choice.message === null ? null : asRecord(choice.message, 'LM Studio response message');
  if (hasToolRequest(delta) || hasToolRequest(message) || choice?.finish_reason === 'tool_calls') throw new GemmaDirectChatProtocolError();
  const candidates = [delta?.content, choice?.text, message?.content, root.response];
  const content = candidates.find((candidate) => typeof candidate === 'string');
  return typeof content === 'string' ? content : '';
}

function hasToolRequest(value: Record<string, unknown> | null): boolean {
  if (!value) return false;
  if (value.function_call !== undefined && value.function_call !== null) return true;
  if (value.tool_calls === undefined || value.tool_calls === null) return false;
  if (!Array.isArray(value.tool_calls)) throw new Error('LM Studio tool_calls must be an array.');
  return value.tool_calls.length > 0;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

async function readLmStudioError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const value = asRecord(JSON.parse(text), 'LM Studio error');
    if (typeof value.error === 'string') return value.error.slice(0, 300);
    const nested = value.error && typeof value.error === 'object' && !Array.isArray(value.error) ? value.error as Record<string, unknown> : null;
    if (typeof nested?.message === 'string') return nested.message.slice(0, 300);
  } catch { /* Use bounded response text below. */ }
  return text.slice(0, 300);
}


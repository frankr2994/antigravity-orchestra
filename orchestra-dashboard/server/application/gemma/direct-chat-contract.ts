import type { GitStatus } from '../../git.js';

export class GemmaDirectChatProtocolError extends Error {
  readonly code = 'GEMMA_UNSUPPORTED_TOOL_OUTPUT';

  constructor() {
    super('Gemma returned an unsupported tool request instead of a chat answer. No command was executed. Retry the question or select a conversational local model in Gemma Solo.');
    this.name = 'GemmaDirectChatProtocolError';
  }
}

const rawToolInvocationPatterns = [
  /^\s*<\|tool_call(?:\|>|>)/i,
  /<\|tool_call(?:\|>|>)[\s\S]{0,240}(?:call:|["']?(?:name|command|arguments)["']?\s*:)/i,
  /<tool_call>[\s\S]{0,500}(?:call:|["']?(?:name|command|arguments)["']?\s*:)/i,
  /^\s*call:[A-Za-z_][\w.-]*\s*\{[\s\S]{0,240}(?:command|arguments)\s*:/i,
];

const internalControlTokenPattern = /<\|(?:channel|message|start|end|im_start|im_end)(?:\|>|>)|<(?:channel|message)\|>/i;

export interface TextToolCall {
  name: string;
  args: Record<string, unknown>;
}

export function parseTextToolCalls(content: string): TextToolCall[] {
  if (typeof content !== 'string' || !content.trim()) return [];
  const results: TextToolCall[] = [];

  const xmlPatterns = [
    /<tool_call>([\s\S]*?)<\/tool_call>/gi,
    /<\|tool_call\|>([\s\S]*?)<\|\/tool_call\|>/gi,
    /<\|tool_call(?:\|>|>)([\s\S]*?)(?:<\|tool_call_end(?:\|>|>)|<\|im_end\|>|$)/gi,
  ];

  for (const pattern of xmlPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const inner = match[1].trim();
      if (!inner) continue;
      try {
        const parsed = JSON.parse(inner);
        if (parsed && typeof parsed === 'object') {
          const name = String(parsed.name || parsed.tool || parsed.function || '');
          let args = (parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments))
            ? parsed.arguments
            : (typeof parsed.arguments === 'string' ? JSON.parse(parsed.arguments) : (parsed.parameters && typeof parsed.parameters === 'object' ? parsed.parameters : parsed));
          if (typeof args !== 'object' || args === null || Array.isArray(args)) args = {};
          if (name) {
            results.push({ name, args });
            continue;
          }
        }
      } catch { /* Try function call expression */ }

      const callMatch = /^(?:call:)?([A-Za-z0-9_.-]+)\s*(\{[\s\S]*\})$/i.exec(inner);
      if (callMatch) {
        const name = callMatch[1];
        try {
          const args = JSON.parse(callMatch[2]);
          if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
            results.push({ name, args });
          }
        } catch { /* Ignore malformed arguments */ }
      }
    }
  }

  if (!results.length) {
    const rawCallMatch = /^\s*call:([A-Za-z0-9_.-]+)\s*(\{[\s\S]*\})\s*$/i.exec(content);
    if (rawCallMatch) {
      const name = rawCallMatch[1];
      try {
        const args = JSON.parse(rawCallMatch[2]);
        if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
          results.push({ name, args });
        }
      } catch { /* ignore */ }
    }
  }

  return results;
}

/** Accepts user-facing Markdown and rejects model/runtime control syntax. */
export function validateGemmaDirectChatResponse(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('LM Studio returned an empty chat response.');
  }
  let answer = value.trim();

  // Some LM Studio chat templates serialize a hidden reasoning channel into the
  // content field. Keep only the user-facing segment when the template supplies
  // an explicit boundary; never display or preserve the hidden segment.
  if (/^<\|channel>thought\b/i.test(answer)) {
    const boundary = answer.lastIndexOf('<channel|>');
    if (boundary < 0) throw new GemmaDirectChatProtocolError();
    answer = answer.slice(boundary + '<channel|>'.length).trim();
  }

  // Strip reasoning blocks if followed by markdown answer
  answer = answer.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
  answer = answer.replace(/<\|thought\|>[\s\S]*?<\|end_thought\|>/gi, '').trim();

  // Strip inline XML tool tags if text response is present
  answer = answer.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim();
  answer = answer.replace(/<\|tool_call\|>[\s\S]*?<\|\/tool_call\|>/gi, '').trim();

  // Strip boundary control tokens
  answer = answer.replace(/<\|(?:im_start|im_end|start|end|eot_id|endoftext|start_header_id|end_header_id)(?:\|>|>)?/gi, '').trim();

  if (rawToolInvocationPatterns.some((pattern) => pattern.test(answer))) {
    throw new GemmaDirectChatProtocolError();
  }
  if (!answer || internalControlTokenPattern.test(answer)) {
    throw new GemmaDirectChatProtocolError();
  }
  return answer;
}

export function isDirectGitStatusQuestion(prompt: string): boolean {
  const text = prompt.trim();
  if (/^git\s+status(?:\s+--(?:short|porcelain))?\s*[?.!]*$/i.test(text)) return true;
  const asksAboutStatus = /\b(?:uncommitt?ed|working\s+(?:tree|directory)|git\s+status|dirty\s+(?:tree|repo|repository)|(?:pending|unstaged|staged|modified|untracked)\s+(?:git\s+)?changes?)\b/i.test(text);
  const isInquiry = /\b(?:any|are|check|do|does|has|have|is|list|show|tell|what|whether|which)\b/i.test(text);
  return asksAboutStatus && isInquiry;
}

export function formatDirectGitStatusAnswer(root: string, status: GitStatus): string {
  const repository = `\`${root}\``;
  if (!status.isGit) {
    return `Git status is unavailable because ${repository} is not a recognized Git repository.`;
  }
  const branch = status.branch ? ` on branch \`${status.branch}\`` : '';
  if (!status.files.length) {
    return `${repository} has no uncommitted changes${branch}. The Git working tree is clean.`;
  }
  const count = status.files.length;
  const entries = status.files.map((file) => `- \`${file.path}\` — ${describeGitFileState(file.index, file.worktree)}`).join('\n');
  return `${repository} has ${count} uncommitted file${count === 1 ? '' : 's'}${branch}:\n\n${entries}`;
}

function describeGitFileState(index: string, worktree: string): string {
  if (index === '?' && worktree === '?') return 'untracked';
  const states: string[] = [];
  if (index !== ' ') states.push(index === 'A' ? 'staged addition' : index === 'D' ? 'staged deletion' : index === 'R' ? 'staged rename' : 'staged change');
  if (worktree !== ' ') states.push(worktree === 'D' ? 'deleted in working tree' : worktree === 'M' ? 'modified in working tree' : 'working-tree change');
  return states.join(', ') || 'changed';
}

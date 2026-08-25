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

/** Accepts user-facing Markdown and rejects model/runtime control syntax. */
export function validateGemmaDirectChatResponse(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('LM Studio returned an empty chat response.');
  }
  const answer = value.trim();
  if (rawToolInvocationPatterns.some((pattern) => pattern.test(answer))) {
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

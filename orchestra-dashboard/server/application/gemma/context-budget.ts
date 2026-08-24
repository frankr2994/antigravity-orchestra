export interface GemmaPromptBudget {
  contextTokens: number;
  responseTokens: number;
  reserveTokens: number;
  inputCharacterLimit: number;
}

const DEFAULT_CONTEXT_TOKENS = 8_192;
const SAFETY_RESERVE_TOKENS = 768;
const CONSERVATIVE_CHARACTERS_PER_TOKEN = 2;

function messageContent(message: Record<string, unknown>): string {
  return typeof message.content === 'string' ? message.content : '';
}

export function gemmaPromptBudget(contextTokens: number | undefined, responseTokens: number): GemmaPromptBudget {
  const usableContext = Number.isSafeInteger(contextTokens) && contextTokens! >= 2_048
    ? contextTokens!
    : DEFAULT_CONTEXT_TOKENS;
  const boundedResponse = Math.max(1, Math.min(responseTokens, Math.floor(usableContext / 2)));
  const availableInputTokens = usableContext - boundedResponse - SAFETY_RESERVE_TOKENS;
  if (availableInputTokens <= 0) throw new Error('The loaded Gemma context is too small for the requested response budget.');
  return {
    contextTokens: usableContext,
    responseTokens: boundedResponse,
    reserveTokens: SAFETY_RESERVE_TOKENS,
    inputCharacterLimit: availableInputTokens * CONSERVATIVE_CHARACTERS_PER_TOKEN,
  };
}

export function compactHeadAndTail(value: string, limit: number, label = 'content'): string {
  if (value.length <= limit) return value;
  if (limit < 160) return value.slice(0, Math.max(0, limit));
  const marker = `\n\n[${label} compacted: ${value.length - limit} characters omitted]\n\n`;
  const remaining = Math.max(0, limit - marker.length);
  const head = Math.ceil(remaining * 0.6);
  return `${value.slice(0, head)}${marker}${value.slice(-(remaining - head))}`;
}

export function fitGemmaMessages(
  messages: Array<Record<string, unknown>>,
  contextTokens: number | undefined,
  responseTokens: number,
  protocolOverhead = '',
): { messages: Array<Record<string, unknown>>; compacted: boolean; budget: GemmaPromptBudget } {
  const budget = gemmaPromptBudget(contextTokens, responseTokens);
  const structuralCharacters = JSON.stringify(messages.map((message) => ({ ...message, content: '' }))).length
    + protocolOverhead.length;
  const systemCharacters = messages
    .filter((message) => message.role === 'system')
    .reduce((total, message) => total + messageContent(message).length, 0);
  const availableForNonSystem = budget.inputCharacterLimit - structuralCharacters - systemCharacters;
  if (availableForNonSystem < 256) {
    throw new Error(`Gemma's ${budget.contextTokens.toLocaleString()}-token context cannot fit the required system instructions and response schema.`);
  }

  const nonSystem = messages.filter((message) => message.role !== 'system');
  const requested = nonSystem.reduce((total, message) => total + messageContent(message).length, 0);
  if (requested <= availableForNonSystem) return { messages, compacted: false, budget };

  let remaining = availableForNonSystem;
  let remainingMessages = nonSystem.length;
  const fitted = messages.map((message, index) => {
    if (message.role === 'system' || typeof message.content !== 'string') return message;
    const fairShare = Math.max(0, Math.floor(remaining / Math.max(1, remainingMessages)));
    const limit = Math.min(message.content.length, fairShare);
    const content = compactHeadAndTail(message.content, limit, `message ${index + 1}`);
    remaining -= content.length;
    remainingMessages -= 1;
    return { ...message, content };
  });
  return { messages: fitted, compacted: true, budget };
}

export function splitGemmaText(value: string, maxCharacters = 10_000): string[] {
  if (value.length <= maxCharacters) return [value];
  const sections = value.split(/(?=^diff --git )/m).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  const flush = () => { if (current.trim()) chunks.push(current); current = ''; };
  for (const section of sections.length ? sections : [value]) {
    if (section.length > maxCharacters) {
      flush();
      for (let offset = 0; offset < section.length; offset += maxCharacters) {
        chunks.push(section.slice(offset, offset + maxCharacters));
      }
      continue;
    }
    if (current.length + section.length > maxCharacters) flush();
    current += section;
  }
  flush();
  return chunks.length ? chunks : [''];
}

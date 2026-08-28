import { redactSecrets } from '../../infrastructure/security/redaction.js';

export { redactSecrets };

export function parseJson(text: string): unknown {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (match?.[1] || text).trim();
  try { return JSON.parse(candidate); }
  catch {
    const start = candidate.indexOf('{'); const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) { const objectText = candidate.slice(start, end + 1); try { return JSON.parse(objectText); } catch { return JSON.parse(repairCommonJson(objectText)); } }
    throw new Error('Gemma did not return valid JSON');
  }
}

function repairCommonJson(value: string) {
  let result = ''; let inString = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' && (index === 0 || value[index - 1] !== '\\')) { inString = !inString; result += character; continue; }
    if (inString && character === '\\') { const next = value[index + 1] || ''; result += /["\\/bfnrtu]/.test(next) ? character : '\\\\'; continue; }
    if (inString && character === '\n') { result += '\\n'; continue; }
    if (inString && character === '\r') { result += '\\r'; continue; }
    if (inString && character === '\t') { result += '\\t'; continue; }
    result += character;
  }
  return result.replace(/,\s*([}\]])/g, '$1');
}

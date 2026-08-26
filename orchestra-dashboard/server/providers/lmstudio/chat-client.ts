import { config } from '../../config.js';
import { callGemmaRiderTool, getGemmaRiderTools } from '../../mcp.js';
import { getActiveLmStudioModelInfo } from '../../lmstudio.js';
import { fitGemmaMessages } from '../../application/gemma/context-budget.js';
import { redactSecrets } from '../../application/agents/agent-data-utils.js';

export type JsonSchema = { name: string; schema: Record<string, unknown> };

export async function callGemma(messages: Array<Record<string, unknown>>, maxTokens = 700, timeoutMs = 60_000, jsonSchema?: JsonSchema, riderTools = false, onToolActivity?: (activity: { tool: string; status: 'started' | 'completed' | 'failed'; detail?: string }) => void, onUsage?: (usage: Record<string, number>) => void): Promise<string> {
  const tools = riderTools ? await getGemmaRiderTools() : [];
  const active = await getActiveLmStudioModelInfo();
  const protocolOverhead = JSON.stringify({ jsonSchema: jsonSchema || null, tools });
  const fitted = fitGemmaMessages(messages, active.contextLength, maxTokens, protocolOverhead);
  const model = active.id;
  const conversation = [...fitted.messages];
  let toolCallsUsed = 0;
  for (let round = 0; round < 5; round += 1) {
    const roundMessages = fitGemmaMessages(conversation, active.contextLength, maxTokens, protocolOverhead).messages;
    const response = await fetch(`${config.lmStudioBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: roundMessages, temperature: 0.2, max_tokens: maxTokens, ...(jsonSchema ? { response_format: { type: 'json_schema', json_schema: { name: jsonSchema.name, strict: true, schema: jsonSchema.schema } } } : {}), ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`LM Studio returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>; usage?: Record<string, number> };
    if (body.usage) onUsage?.(body.usage);
    const message = body.choices?.[0]?.message;
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    if (calls.length) {
      conversation.push({ role: 'assistant', content: message?.content || null, tool_calls: calls });
      for (const call of calls) {
        toolCallsUsed += 1;
        if (toolCallsUsed > 6) throw new Error('Gemma exceeded the bounded Rider MCP tool-call limit.');
        const name = String(call.function?.name || '');
        const visibleTool = name.replace(/^rider_/, '').replace(/[_-]+/g, ' ').slice(0, 80);
        onToolActivity?.({ tool: visibleTool, status: 'started' });
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(String(call.function?.arguments || '{}')) as Record<string, unknown>; } catch { /* The tool receives an empty object and returns a useful schema error. */ }
        let content: string;
        try { content = await callGemmaRiderTool(name, args); onToolActivity?.({ tool: visibleTool, status: 'completed' }); }
        catch (error) { const detail = error instanceof Error ? error.message : String(error); content = JSON.stringify({ error: detail }); onToolActivity?.({ tool: visibleTool, status: 'failed', detail: redactSecrets(detail).slice(0, 280) }); }
        conversation.push({ role: 'tool', tool_call_id: String(call.id || `rider-${toolCallsUsed}`), name, content });
      }
      continue;
    }
    const content = message?.content?.trim() || message?.reasoning_content?.trim();
    if (!content) throw new Error('LM Studio returned an empty response');
    return content;
  }
  throw new Error('Gemma did not finish after the bounded Rider MCP tool loop.');
}


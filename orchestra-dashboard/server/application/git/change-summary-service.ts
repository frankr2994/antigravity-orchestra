import { splitGemmaText } from '../gemma/context-budget.js';
import { callGemma, type JsonSchema } from '../../providers/lmstudio/chat-client.js';
import { parseJson, redactSecrets } from '../agents/agent-data-utils.js';

const CHANGE_SUMMARY_SCHEMA: JsonSchema = { name: 'change_summary', schema: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' } }, required: ['title', 'summary'], additionalProperties: false } };
const SEMANTIC_COMMITS_SCHEMA: JsonSchema = { name: 'semantic_commit_slicing', schema: { type: 'object', properties: { slices: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, required: ['title', 'body', 'files'], additionalProperties: false } } }, required: ['slices'], additionalProperties: false } };

export async function summarizeChanges(diff: string, request: string) {
  const redacted = redactSecrets(diff).slice(0, 90_000);
  const chunks = splitGemmaText(redacted, 10_000);
  const partials: Array<{ title: string; summary: string }> = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const text = await callGemma([
      { role: 'system', content: 'You are a technical scribe reviewing one bounded portion of a Git change set. Return JSON only: {"title":"conventional commit title <=72 chars","summary":"2-6 concise Markdown bullets describing only observable changes in this portion, without secrets"}. Do not claim the portion is the complete change set.' },
      { role: 'user', content: `Request:\n${request.slice(0, 2_000)}\n\nDiff portion ${index + 1} of ${chunks.length}:\n${chunks[index]}` },
    ], 600, 60_000, CHANGE_SUMMARY_SCHEMA);
    const value = parseJson(text) as Record<string, unknown>;
    partials.push({
      title: String(value.title || 'Update project').replace(/[\r\n]/g, ' ').slice(0, 72),
      summary: String(value.summary || '- Updated project files.').trim().slice(0, 4_000),
    });
  }

  let parsed: Record<string, unknown> = partials[0] || { title: 'Update project', summary: '- Updated project files.' };
  if (partials.length > 1) {
    const text = await callGemma([
      { role: 'system', content: 'Consolidate bounded Git change summaries. Return JSON only: {"title":"one conventional commit title <=72 chars","summary":"2-8 concise Markdown bullets covering the complete change set without duplication or secrets"}.' },
      { role: 'user', content: `Request:\n${request.slice(0, 2_000)}\n\nPortion summaries:\n${partials.map((item, index) => `## Portion ${index + 1}\nTitle: ${item.title}\n${item.summary}`).join('\n\n')}` },
    ], 900, 60_000, CHANGE_SUMMARY_SCHEMA);
    parsed = parseJson(text) as Record<string, unknown>;
  }
  const title = String(parsed.title || 'Update project').replace(/[\r\n]/g, ' ').slice(0, 72);
  const summary = String(parsed.summary || '- Updated project files.').trim();
  return { title, summary };
}

export interface SemanticCommitSlice {
  title: string;
  body: string;
  files: string[];
}

export async function sliceSemanticCommits(diffText: string, changedFiles: string[], taskRequest: string): Promise<SemanticCommitSlice[]> {
  if (changedFiles.length <= 2) {
    const summary = await summarizeChanges(diffText, taskRequest);
    return [{ title: summary.title, body: summary.summary, files: changedFiles }];
  }
  const sanitizedDiff = redactSecrets(diffText).slice(0, 50_000);
  try {
    const text = await callGemma([
      {
        role: 'system',
        content: 'You are a Git release engineer. Analyze the changed files and diff. Group the files into 1 to 4 logical, atomic, conventional commit slices (e.g. feat(core), feat(ui), test, docs/chore). Every changed file must belong to exactly one slice. Return JSON only: {"slices":[{"title":"conventional commit title","body":"bulleted summary","files":["relative/path/1", ...]}]}',
      },
      {
        role: 'user',
        content: `Task Request:\n${taskRequest}\n\nChanged Files:\n${changedFiles.map((f) => `- ${f}`).join('\n')}\n\nDiff:\n${sanitizedDiff}`,
      },
    ], 1_200, 60_000, SEMANTIC_COMMITS_SCHEMA);
    const parsed = parseJson(text) as Record<string, unknown>;
    const rawSlices = Array.isArray(parsed.slices) ? parsed.slices : [];
    const validSlices: SemanticCommitSlice[] = [];
    const assignedFiles = new Set<string>();

    for (const raw of rawSlices) {
      if (!raw || typeof raw !== 'object') continue;
      const rawRecord = raw as Record<string, unknown>;
      const rawSliceFiles = Array.isArray(rawRecord.files) ? rawRecord.files.map(String) : [];
      const sliceFiles = rawSliceFiles.filter((file: string) => changedFiles.includes(file) && !assignedFiles.has(file));
      if (sliceFiles.length > 0) {
        sliceFiles.forEach((f: string) => assignedFiles.add(f));
        validSlices.push({
          title: String(rawRecord.title || 'Update project').replace(/[\r\n]/g, ' ').slice(0, 72),
          body: String(rawRecord.body || '- Updated project files.').trim(),
          files: sliceFiles,
        });
      }
    }

    const unassigned = changedFiles.filter((f) => !assignedFiles.has(f));
    if (unassigned.length > 0) {
      if (validSlices.length > 0) {
        validSlices[validSlices.length - 1].files.push(...unassigned);
      } else {
        const fallbackSummary = await summarizeChanges(diffText, taskRequest);
        return [{ title: fallbackSummary.title, body: fallbackSummary.summary, files: changedFiles }];
      }
    }

    return validSlices.length ? validSlices : [{ title: taskRequest.slice(0, 72), body: '- Updated project files.', files: changedFiles }];
  } catch {
    const summary = await summarizeChanges(diffText, taskRequest);
    return [{ title: summary.title, body: summary.summary, files: changedFiles }];
  }
}


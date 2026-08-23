import type { JulesActivity } from './types.js';

export function translateJulesActivity(activity: JulesActivity): Record<string, unknown> {
  const base = { providerActivityId: activity.id || activity.name, createTime: activity.createTime,
    originator: activity.originator, description: activity.description?.slice(0, 4_000) };
  if ('agentMessaged' in activity) return { ...base, kind: 'agent_message', message: activity.agentMessaged.agentMessage.slice(0, 20_000) };
  if ('userMessaged' in activity) return { ...base, kind: 'user_message', message: activity.userMessaged.userMessage.slice(0, 20_000) };
  if ('planGenerated' in activity) return { ...base, kind: 'plan_generated', planId: activity.planGenerated.plan?.id,
    steps: activity.planGenerated.plan?.steps.slice(0, 100).map((step) => ({ index: step.index, title: step.title.slice(0, 500), status: step.status })) };
  if ('planApproved' in activity) return { ...base, kind: 'plan_approved', planId: activity.planApproved.planId };
  if ('progressUpdated' in activity) return { ...base, kind: 'progress', title: activity.progressUpdated.title?.slice(0, 500), detail: activity.progressUpdated.description?.slice(0, 4_000) };
  if ('sessionCompleted' in activity) return { ...base, kind: 'completed', summary: activity.sessionCompleted.summary?.slice(0, 10_000) };
  if ('sessionFailed' in activity) return { ...base, kind: 'failed', reason: activity.sessionFailed.reason?.slice(0, 4_000) };
  return { ...base, kind: 'unknown', fields: activity.unknownActivity.fields.slice(0, 100) };
}

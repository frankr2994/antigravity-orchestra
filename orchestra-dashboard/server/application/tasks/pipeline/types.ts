import type { Store } from '../../../db.js';
import type { AgentName, ModelSelection, Project, Session, TaskClassification, TaskEventType, TaskRecord, TaskState } from '../../../types.js';
import type { GitStatus } from '../../../git.js';
import type { AgentRunResult } from '../../../agents.js';
import type { SystemCapabilities } from '../../capabilities/environment-sensor.js';
import type { JulesBuilderPort } from '../jules-builder-port.js';

export interface PipelineContext {
  taskId: string;
  project: Project;
  session: Session;
  task: TaskRecord;
  classification: TaskClassification;
  models: ModelSelection;
  capabilities: SystemCapabilities;
  status: GitStatus;
  signal: AbortSignal;
  recovery: boolean;
  recoveryReason?: string;
  activeGemmaModel: string;
  antigravityModels: string[];
  refinedSpec: string;
  blueprint?: string;
  agentResult?: AgentRunResult | null;
  store: Store;
  emit: (agent: AgentName, type: TaskEventType, payload?: Record<string, unknown>) => void;
  stream: (agent: AgentName, chunk: string) => void;
  transition: (state: TaskState) => void;
  recordProviderTelemetry: (provider: string, usage: unknown) => void;
  recordLocalProviderTelemetry: (usage: unknown) => void;
  riderFor: (agent: AgentName) => boolean;
  julesBuilder?: JulesBuilderPort;
  adoptedJulesTaskId?: string;
  complete: (result: string, agent: AgentName) => void;
}

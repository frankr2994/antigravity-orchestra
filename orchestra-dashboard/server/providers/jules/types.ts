import type { JulesSessionState } from './state-mapper.js';

// ============================================================================
// Google Jules REST API Wire Protocol Types (Authoritative Alpha)
// ============================================================================

export interface JulesSourceBranch {
  displayName: string;
}

export interface JulesSource {
  name: string;
  id?: string;
  githubRepo?: {
    owner: string;
    repo: string;
    defaultBranch?: JulesSourceBranch;
    branches?: JulesSourceBranch[];
  };
}

export interface JulesListSourcesResponse {
  sources?: JulesSource[];
  nextPageToken?: string;
}

export interface JulesPullRequestOutput {
  url?: string;
  title?: string;
  description?: string;
}

export interface JulesSessionOutput {
  pullRequest?: JulesPullRequestOutput;
}

export type JulesAutomationMode = 'AUTOMATION_MODE_UNSPECIFIED' | 'AUTO_CREATE_PR';

export interface JulesSession {
  name: string;
  id?: string;
  title?: string;
  state: JulesSessionState | string;
  sourceContext?: {
    source: string;
    githubRepoContext?: {
      startingBranch?: string;
    };
  };
  prompt?: string;
  requirePlanApproval?: boolean;
  automationMode?: JulesAutomationMode;
  outputs?: JulesSessionOutput[];
  createTime?: string;
  updateTime?: string;
}

export interface JulesListSessionsResponse {
  sessions?: JulesSession[];
  nextPageToken?: string;
}

export interface JulesCreateSessionRequest {
  prompt: string;
  sourceContext: {
    source: string;
    githubRepoContext?: {
      startingBranch?: string;
    };
  };
  title?: string;
  requirePlanApproval?: boolean;
  automationMode?: JulesAutomationMode;
}

export type JulesActivityOriginator = 'user' | 'agent' | 'system' | 'originator_unspecified' | string;

export interface JulesPlanStep {
  index?: number;
  title: string;
  description?: string;
  status?: string;
}

export interface JulesPlan {
  id?: string;
  steps: JulesPlanStep[];
}

export interface JulesGitPatch {
  patch?: string;
  uncommittedChanges?: boolean;
  mimeType?: string;
}

export interface JulesChangeSet {
  source?: string;
  gitPatch?: JulesGitPatch;
}

export interface JulesArtifact {
  changeSet?: JulesChangeSet;
  bashOutput?: {
    command?: string;
    output?: string;
    exitCode?: number;
  };
  media?: {
    mimeType?: string;
    data?: string;
  };
}

export interface BaseJulesActivity {
  name: string;
  id?: string;
  createTime?: string;
  originator?: JulesActivityOriginator;
  description?: string;
  artifacts?: JulesArtifact[];
}

export interface JulesPlanGeneratedActivity extends BaseJulesActivity {
  planGenerated: {
    plan?: JulesPlan;
  };
}

export interface JulesPlanApprovedActivity extends BaseJulesActivity {
  planApproved: {
    planId?: string;
  };
}

export interface JulesAgentMessageActivity extends BaseJulesActivity {
  agentMessaged?: {
    message?: string;
  };
  agentMessage?: {
    message?: string;
  };
}

export interface JulesUserMessageActivity extends BaseJulesActivity {
  userMessaged?: {
    message?: string;
  };
  userMessage?: {
    message?: string;
  };
}

export interface JulesProgressActivity extends BaseJulesActivity {
  progressUpdated: {
    title?: string;
    description?: string;
  };
}

export interface JulesSessionCompletedActivity extends BaseJulesActivity {
  sessionCompleted: {
    summary?: string;
  };
}

export interface JulesSessionFailedActivity extends BaseJulesActivity {
  sessionFailed: {
    reason?: string;
  };
}

export interface JulesGenericActivity extends BaseJulesActivity {
  [key: string]: unknown;
}

export type JulesActivity =
  | JulesPlanGeneratedActivity
  | JulesPlanApprovedActivity
  | JulesAgentMessageActivity
  | JulesUserMessageActivity
  | JulesProgressActivity
  | JulesSessionCompletedActivity
  | JulesSessionFailedActivity
  | JulesGenericActivity;

export interface JulesListActivitiesResponse {
  activities?: JulesActivity[];
  nextPageToken?: string;
}

export interface JulesSendMessageRequest {
  prompt: string;
}

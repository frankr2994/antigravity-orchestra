import type { JulesSessionState } from '../../domain/index.js';

// ============================================================================
// Google Jules REST API Wire Protocol Types (Alpha)
// ============================================================================

export interface JulesSource {
  name: string;
  id?: string;
  displayName?: string;
  githubRepo?: {
    owner: string;
    repo: string;
    defaultBranch?: string;
  };
}

export interface JulesListSourcesResponse {
  sources?: JulesSource[];
  nextPageToken?: string;
}

export interface JulesPullRequestOutput {
  url?: string;
  title?: string;
  headBranch?: string;
  baseBranch?: string;
  headCommitSha?: string;
}

export interface JulesSessionOutputs {
  pullRequest?: JulesPullRequestOutput;
}

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
  outputs?: JulesSessionOutputs;
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
  autoPr?: boolean;
}

export interface JulesActivity {
  name: string;
  id?: string;
  createTime?: string;
  type?: string;
  description?: string;
  artifacts?: Array<{
    type?: string;
    uri?: string;
    metadata?: Record<string, unknown>;
  }>;
  plan?: {
    steps?: Array<{
      title: string;
      description?: string;
      status?: string;
    }>;
  };
}

export interface JulesListActivitiesResponse {
  activities?: JulesActivity[];
  nextPageToken?: string;
}

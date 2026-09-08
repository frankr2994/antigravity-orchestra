export interface JulesBuilderResult {
  taskId: string;
  commitSha: string;
  result: string;
  requiredLocalRepair: boolean;
}

export interface JulesBuilderPort {
  dispatchAndWait(input: {
    parentTaskId: string;
    projectId: string;
    sessionId: string;
    projectRoot: string;
    prompt: string;
    signal: AbortSignal;
  }): Promise<JulesBuilderResult>;
}

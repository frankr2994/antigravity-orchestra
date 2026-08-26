export interface PromptEnvelope {
  purpose: 'analysis' | 'review' | 'repair-review';
  text: string;
  fingerprint: string;
  estimatedInputTokens: number;
  compacted: boolean;
}

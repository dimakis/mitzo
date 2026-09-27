export type ApplicationPolicy = {
  version: 1;
  mode: 'application';
  maxHostTurns: number;
  maxReviewCycles: number;
  deadlineAt: number;
  noProgressLimit: number;
};
export type ReviewWorkflow = {
  workflowId: string;
  status: string;
  artifactRevision: string;
  artifactHash: string;
  reviewRounds: number;
  tokensUsed?: number | null;
  costUsd?: number | null;
  limits?:
    | ApplicationPolicy
    | {
        mode?: 'native-hard-cap';
        maxTokens: number;
        maxReviewRounds: number;
        maxCostUsd: number | null;
      };
  hostTurns?: number;
  reviewCycles?: number;
  decisionCode?: string;
  usageCompleteness?: { tokens: 'complete' | 'partial'; cost: 'complete' | 'partial' };
  applicationAttempts?: Array<{ attemptId: string; kind: 'review' | 'fix'; settled: boolean }>;
  findings: Array<{
    fingerprint: string;
    severity?: 'critical' | 'high' | 'medium' | 'low';
    summary: string;
    location: string;
    criterion: string;
    evidenceRefs: string[];
    status: string;
  }>;
  reviews: Array<{ reviewId: string; kind: string; artifactRevision: string }>;
  reservations: Array<{ attemptId: string; kind: 'review' | 'fix'; settled: boolean }>;
};

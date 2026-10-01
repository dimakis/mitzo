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
  acceptanceCriteria?: string[];
  currentResultId?: string | null;
  evidence?: Array<{
    source: 'host' | 'model';
    artifactHash: string;
    item: {
      evidenceId: string;
      resultId: string;
      criterion: string;
      verdict: 'verified' | 'failed' | 'inconclusive';
      artifactRevision: string;
      evidenceRefs: string[];
      checkedAt: number;
    };
  }>;
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
  applicationAttempts?: Array<{
    attemptId: string;
    kind: 'initial' | 'review' | 'fix' | 'delta' | 'retry';
    effectiveKind?: 'initial' | 'review' | 'fix' | 'delta';
    settled: boolean;
  }>;
  applicationPreparations?: Array<{
    attemptId: string;
    kind: 'initial' | 'review' | 'fix' | 'delta';
    status: 'preparing' | 'bound' | 'settled';
    disposition?: 'not_applied' | 'applied_no_dispatch';
  }>;

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

export type CriterionCheck = {
  id: string;
  criterion: string;
  kind: 'file-sha256' | 'python-json-cases';
  path: string;
};

export type InitialApplicationRun = {
  available: boolean;
  initialArtifact: { revision: string; hash: string } | null;
  reason?: string;
};

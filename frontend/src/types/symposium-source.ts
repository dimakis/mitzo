export type LocalSourcePlan = {
  repositoryId: string;
  targetRepository: string;
  baseBranch: string;
  featureBranch: string;
  baseOid: string;
  treeOid: string;
  sourceIdentity: string;
  historyCommits: number;
};
export type SourcePreview = {
  plan: LocalSourcePlan;
  expectedRevision: number;
  expectedGeneration: string;
  disclosure: string;
};
export type SourceStatus = {
  repositories: string[];
  expectedRevision: number;
  artifact: {
    available: boolean;
    state: string;
    admissionIssued?: boolean;
    volumeGeneration?: string;
    receipt?: { commit?: string; operationId?: string } | null;
    sourceSeal?: { state: string; operationId: string } | null;
  };
};

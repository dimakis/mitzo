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
  artifact: {
    available: boolean;
    state: string;
    admissionIssued?: boolean;
    receipt?: { commit?: string };
  };
};

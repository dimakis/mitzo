export interface ReleasePinsInput {
  manifest: Record<string, unknown> & {
    runtime?: Record<string, unknown>;
    policy?: Record<string, unknown>;
  };
  environment: string;
  image: string;
  digest: string;
  mitzoCommit: string;
  mgmtCommit: string;
  policyDigest: string;
  knowledgeContract?: {
    knowledgeSchemaVersion: number;
    knowledgeCompilerCommit: string;
    knowledgeCompilerSha256: string;
    knowledgeRecipeSha256: string;
    dependencyProjectionSha256: string;
    jiraRuntimeInputsSha256: string;
    runtimeInputsSha256: string;
    targetPlatform: string;
    targetMarkerEnvironmentB64: string;
  };
}

export function updateReleasePins(input: ReleasePinsInput): {
  manifest: Record<string, unknown>;
  environment: string;
};

export function main(argv?: string[]): void;

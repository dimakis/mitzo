export interface ReleasePinsInput {
  manifest: Record<string, unknown> & { runtime?: Record<string, unknown> };
  environment: string;
  image: string;
  digest: string;
  mitzoCommit: string;
  mgmtCommit: string;
}

export function updateReleasePins(input: ReleasePinsInput): {
  manifest: Record<string, unknown>;
  environment: string;
};

export function main(argv?: string[]): void;

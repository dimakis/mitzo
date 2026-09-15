export function validateStaticConfig(
  config: Record<string, string | undefined>,
  manifest: Record<string, unknown>,
): { enabled: boolean; image?: string; configuredProviders?: string[] };

export function verifyAccountBindings(
  accounts: Array<Record<string, unknown>>,
  providers: Array<Record<string, unknown>>,
): void;

export function hasExactGlobalSetting(
  settings: string,
  key: string,
  value: string | number | boolean,
): boolean;

export function canonicalJson(value: unknown): unknown;
export function canonicalJsonPayload(value: unknown): string;

export function validateSeedBaseline(
  seedBaseline: Record<string, unknown> | null,
  manifest: {
    runtime: {
      mgmtSourceCommit: string;
      dependencyProjectionSha256?: string;
      seedPayloadSha256?: string;
    };
  },
  seedPath?: string,
): void;

export function validateRuntimeImageLabels(
  imageLabels: Record<string, string | undefined>,
  manifest: {
    runtime: { mitzoSourceCommit: string; mgmtSourceCommit: string; baseImage: string };
  },
): void;

export function validateRuntimeDependencyProjection(
  projection: string,
  manifest: { runtime: { dependencyProjectionSha256: string } },
): void;

export function validateRuntimeResolutionContract(
  contract: string,
  manifest: { runtime: { dependencyProjectionSha256: string; baseImage: string } },
  imageLabels: Record<string, string | undefined>,
): void;

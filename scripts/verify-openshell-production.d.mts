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

export function loadProductionConfig(
  envPath: string,
  inheritedEnv?: NodeJS.ProcessEnv,
): Record<string, string | undefined>;

export function verifyOpenAiHeaderAuthentication(profile: Record<string, unknown>): void;

export function verifyPreparedSeed(
  seedPath: string,
  expectedCommit: string | Record<string, unknown>,
): void;

export function canonicalJsonPayload(value: unknown): string;

export function validateSeedBaseline(
  baseline: Record<string, unknown>,
  manifest: Record<string, unknown>,
  seedPath?: string,
): void;

export function validateRuntimeMarkerEnvironment(
  encoded: unknown,
  targetPlatform: unknown,
): Record<string, string>;

export function verifyKnowledgeGit(
  config: Record<string, string | undefined>,
  executionEnv?: NodeJS.ProcessEnv,
): void;
export function loadServiceGitEnvironment(
  plistPath: string,
  inheritedEnv?: NodeJS.ProcessEnv,
  releaseEnv?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;

export function main(argv?: string[], inheritedEnv?: NodeJS.ProcessEnv): void;

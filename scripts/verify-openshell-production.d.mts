export function validateStaticConfig(
  config: Record<string, string | undefined>,
  manifest: Record<string, unknown>,
): { enabled: boolean; image?: string; configuredProviders?: string[] };

export function verifyAccountBindings(
  accounts: Array<Record<string, unknown>>,
  providers: Array<Record<string, unknown>>,
): void;

export function verifyAccountProfileIntegrity(
  config: Record<string, string | undefined>,
  manifest: Record<string, unknown>,
): string;

export function verifyCleanTrackedWorktree(options?: {
  root?: string;
  runCommand?: (command: string, args: string[]) => string;
}): void;

export function verifyCheckoutReleaseProvenance(
  release: Record<string, unknown>,
  options?: { root?: string; runCommand?: (command: string, args: string[]) => string },
): string;

export function verifyLocalReleaseIdentity(
  config: Record<string, string | undefined>,
  manifest: Record<string, unknown>,
  options?: { root?: string; runCommand?: (command: string, args: string[]) => string },
): { checkoutCommit: string; cliVersion: string; artifactPath: string };

export function hasExactGlobalSetting(
  settings: string,
  key: string,
  value: string | number | boolean,
): boolean;

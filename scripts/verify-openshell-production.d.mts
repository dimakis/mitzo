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

export function validateReleaseIdentity(manifest: Record<string, unknown>): {
  release: Record<string, unknown>;
  cli: Record<string, unknown>;
  supervisor: Record<string, unknown>;
};

export function validateReleaseTransport(
  config: Record<string, string | undefined>,
  manifest: Record<string, unknown>,
): { tlsRequired: true; publicOrigin: string; webSocketOrigin: string };

export function validateRollbackRecord(
  manifest: Record<string, unknown>,
  rollback: Record<string, unknown>,
  stackLockSha256: string,
): void;

export function verifyBakedBrowserOrigin(origin: string, buildDir?: string): void;

export function verifyReleaseTls(
  config: Record<string, string | undefined>,
  options?: { root?: string; now?: number; minimumValidityMs?: number },
): { certPath: string; keyPath: string; certificate: import('node:crypto').X509Certificate };

export function main(
  argv?: string[],
  inheritedEnv?: Record<string, string | undefined>,
  options?: {
    buildDir?: string;
    root?: string;
    runCommand?: (command: string, args: string[]) => string;
  },
): void;

export function validateStaticConfig(
  config: Record<string, string | undefined>,
  manifest: Record<string, unknown>,
): { enabled: boolean; image?: string; configuredProviders?: string[] };

export function verifyAccountBindings(
  accounts: Array<Record<string, unknown>>,
  providers: Array<Record<string, unknown>>,
): void;

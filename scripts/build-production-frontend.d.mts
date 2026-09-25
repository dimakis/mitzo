export function productionFrontendRepositoryRoot(moduleUrl?: string): string;

export function productionFrontendEnvironment(
  config: Record<string, string | undefined>,
  inheritedEnv?: Record<string, string | undefined>,
): Record<string, string | undefined> & { VITE_API_BASE_URL: string };

export function main(argv?: string[], options?: { root?: string }): void;

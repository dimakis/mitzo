export function stageObservabilityConfig(
  sourceRoot: string,
  stateRoot: string,
  publicUrls?: {
    jaegerUiUrl?: string;
    mlflowUiUrl?: string;
  },
): string;

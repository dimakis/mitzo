export type SearchFailureStage = 'append' | 'search' | 'worker' | 'cleanup';
interface SearchDiagnostic {
  code: 'session_search_failed';
  stage: SearchFailureStage;
  requestId?: number;
  causeName: string;
}

/** Safe to log: never includes the query, transcript, paths or exception message. */
export function sessionSearchDiagnostic(
  cause: unknown,
  stage: SearchFailureStage = 'search',
  requestId?: number,
): SearchDiagnostic {
  if (cause instanceof SessionSearchError) return cause.diagnostic;
  const name = cause instanceof Error ? cause.name : '';
  return {
    code: 'session_search_failed' as const,
    stage,
    ...(requestId === undefined ? {} : { requestId }),
    causeName: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : 'Error',
  };
}

export class SessionSearchError extends Error {
  readonly diagnostic;

  constructor(stage: SearchFailureStage, requestId: number | undefined, cause: unknown) {
    super('Search index unavailable', { cause });
    this.name = 'SessionSearchError';
    this.diagnostic = sessionSearchDiagnostic(cause, stage, requestId);
  }
}

import { WebAccessError } from './request-web-access.js';

export type WebSearchProvider = 'OpenAI' | 'native Codex' | 'Gemini/Vertex' | 'Claude SDK';

/** Callers supply fixed server-authored details, never provider bodies or exceptions. */
export function webSearchFailure(provider: WebSearchProvider, detail: string) {
  return new WebAccessError(
    `Approved web access failed: ${provider} search ${detail}. No other account was used.`,
  );
}

export function webSearchHttpFailure(provider: WebSearchProvider, status: number) {
  const detail =
    status === 400
      ? 'request was rejected'
      : status === 401
        ? 'authentication failed'
        : status === 403
          ? 'access was refused'
          : status === 429
            ? 'rate or quota limit was reached'
            : status >= 500
              ? 'service was unavailable'
              : 'request failed';
  return webSearchFailure(provider, `${detail} (HTTP ${status})`);
}

/** One selected route. No retry, model substitution, deadline or alternate credentials. */
export async function runApprovedProviderSearch<T>(
  provider: WebSearchProvider,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  try {
    signal.throwIfAborted();
    const result = await work();
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (signal.aborted) throw webSearchFailure(provider, 'was interrupted');
    if (error instanceof WebAccessError) throw error;
    throw webSearchFailure(provider, 'could not complete on the selected route');
  }
}

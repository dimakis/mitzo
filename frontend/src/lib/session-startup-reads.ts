/**
 * A new chat is selected before its durable session row exists, so per-session
 * reads answer 404 for the few seconds startup takes. Before a reader's first
 * successful read, treat that 404 as "not started yet" and re-read on this
 * bounded schedule (~90s total). A 404 after a successful read, or after the
 * schedule is exhausted, is a real failure and is reported normally.
 */
export const SESSION_STARTUP_READ_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000, 30000];

/** Per-conversation startup window for one reader. */
export interface SessionStartupReadWindow {
  conversationId: string | null;
  settled: boolean;
  attempt: number;
}

export function sessionStartupReadWindow(conversationId: string | null): SessionStartupReadWindow {
  return { conversationId, settled: false, attempt: 0 };
}

/**
 * Next re-read delay when `status` is a startup 404 for the current window, or
 * null when the response must be handled (or reported) normally.
 */
export function nextSessionStartupReadDelay(
  window: SessionStartupReadWindow,
  conversationId: string,
  status: number,
): number | null {
  if (status !== 404 || window.settled || window.conversationId !== conversationId) return null;
  const delay = SESSION_STARTUP_READ_DELAYS_MS[window.attempt];
  if (delay === undefined) return null;
  window.attempt += 1;
  return delay;
}

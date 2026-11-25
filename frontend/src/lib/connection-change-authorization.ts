/** One reviewer-facing change that needs a fresh identity confirmation. The
 * change is retained while identity is confirmed, then applied with the new
 * csrf so the operator never has to find the control and tap it again. */
export type PendingConnectionChange = {
  connectionId: string;
  description: string;
  success: string;
  apply: (csrf: string) => Promise<unknown>;
};

export type ConnectionAuthorizationState = {
  csrf: string;
  csrfExpiresAt: number;
  connectionsRefreshing: boolean;
  loadError: string;
};

export type ConnectionAuthorizationDecision =
  | { action: 'blocked'; message: string }
  | { action: 'confirm'; message: string }
  | { action: 'proceed' };

/** Decide before any change is sent. A tap is never silently dropped: when the
 * csrf is absent or stale the caller opens identity confirmation and keeps the
 * pending change, so the refusal is visible next to the control that was tapped. */
export function decideConnectionAuthorization(
  state: ConnectionAuthorizationState,
  pending: PendingConnectionChange | null,
  now: number,
): ConnectionAuthorizationDecision {
  if (state.connectionsRefreshing || state.loadError)
    return { action: 'blocked', message: 'Refresh connection details before changing access.' };
  if (state.csrf && state.csrfExpiresAt > now) return { action: 'proceed' };
  return {
    action: 'confirm',
    message: pending
      ? `${pending.description}. Confirm your identity and it will be applied automatically.`
      : 'Confirm your identity to continue.',
  };
}

/** The confirmed identity applies the retained change exactly once, with the
 * csrf issued by that confirmation rather than the stale one seen at tap time. */
export function takePendingConnectionChange(
  pending: PendingConnectionChange | null,
  csrf: string,
): { run: () => Promise<unknown>; success: string } | null {
  if (!pending || !csrf) return null;
  return { run: () => pending.apply(csrf), success: pending.success };
}

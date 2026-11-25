/** A Claude SDK command a server restart left unconfirmed, and its settled outcome. */
export interface RestartedOrdinarySdkCommand {
  sessionId: string;
  commandId: string;
  outcome: 'delivered' | 'not_delivered' | 'unknown';
}

/** The only host-authored notices restart settlement writes. Replay authorizes
 * exactly these strings for a command whose input may never have been echoed. */
export const RESTARTED_SDK_COMMAND_ERRORS: Record<
  RestartedOrdinarySdkCommand['outcome'],
  string | null
> = {
  delivered: null,
  not_delivered:
    'Mitzo restarted before this message reached the agent. Nothing was sent; send it again if you still need it.',
  unknown:
    'Mitzo restarted while this message was being delivered, so the agent may not have received it. Check its reply before sending it again.',
};

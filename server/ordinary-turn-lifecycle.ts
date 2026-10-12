/** Trusted in-process observers. Never accepted from HTTP or WebSocket requests. */
export interface OrdinaryTurnLifecycle {
  beforeDispatch(commandId: string): void;
  accepted(commandId: string, providerThreadId: string, providerTurnId: string): void;
  /** Only an exact provider terminal notification, never transport closure. */
  terminal(
    commandId: string,
    providerTurnId: string,
    status: 'completed' | 'interrupted' | 'failed',
  ): void;
  /** A trusted unfinished-work receipt, separate from actual provider terminal status. */
  environmentPending?(commandId: string, providerTurnId: string): void;
  terminalConflict?(commandId: string, providerTurnId: string): void;
}

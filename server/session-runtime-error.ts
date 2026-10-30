import { randomUUID } from 'node:crypto';

const messages = {
  runtime_unavailable:
    'The execution runtime could not continue. The conversation, workspace and saved messages are retained.',
  callbacks_pending:
    'The provider finished, but an original tool callback has not settled. Saved messages remain queued. Completed work will not be rerun.',
  callbacks_failed:
    'An original tool callback could not finish safely. Its outcome needs reconciliation before saved messages can continue. Completed work will not be rerun.',
  turn_completed:
    'This provider turn has already finished. A new tool callback cannot execute on that turn.',
  unsettled_effects:
    'A previous turn has unresolved tool or completion effects. Saved messages remain queued while its original outcome is reconciled. Completed work will not be rerun.',
  provider_active:
    'The previous provider turn is still active. Saved messages remain queued until its exact outcome is confirmed.',
  provider_identity:
    'The provider outcome does not match the retained command and turn. The original work and saved messages are retained for inspection.',
} as const;
export function sessionRuntimeMessage(code: keyof typeof messages): string {
  return messages[code];
}

/** Reviewed, account-independent diagnostics. Raw upstream exceptions stay in cause. */
export class SessionRuntimeError extends Error {
  readonly diagnosticId = randomUUID();
  constructor(
    readonly code: keyof typeof messages,
    options?: ErrorOptions,
  ) {
    super(messages[code], options);
    this.name = 'SessionRuntimeError';
  }
  publicMessage() {
    return `${this.message} Reference: ${this.diagnosticId}`;
  }
  telemetry() {
    return { runtimeFailureCode: this.code, diagnosticId: this.diagnosticId };
  }
}

/** Generic wrappers retain an actionable reviewed cause; upstream lookalikes grant nothing. */
export function findSessionRuntimeError(error: unknown): SessionRuntimeError | undefined {
  const seen = new Set<Error>();
  let found: SessionRuntimeError | undefined;
  for (let depth = 0; depth < 16 && error instanceof Error && !seen.has(error); depth++) {
    seen.add(error);
    if (error instanceof SessionRuntimeError && (!found || found.code === 'runtime_unavailable'))
      found = error;
    error = error.cause;
  }
  return found;
}

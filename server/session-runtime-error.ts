import { randomUUID } from 'node:crypto';
import { SESSION_RUNTIME_MESSAGES as messages } from '@mitzo/protocol';
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

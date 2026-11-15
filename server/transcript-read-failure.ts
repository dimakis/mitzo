import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { runtimeFailureDiagnostics } from './runtime-failure-diagnostics.js';

/** Fixed local failure categories only; provider text and stored content stay in cause. */
const replayReasons = new Map([
  ['Unmatched attributed tool result in stored transcript', 'tool_result_unmatched'],
  ['Ambiguous or unattributed late tool result in stored transcript', 'tool_result_ambiguous'],
  ['Claude account history unavailable', 'account_history_unavailable'],
  ['Stored event has unverifiable Symposium attribution', 'seat_attribution_invalid'],
  ['Stored Symposium event has mismatched seat provenance', 'seat_attribution_invalid'],
]);

export class TranscriptReadFailure extends Error {
  readonly diagnosticId = randomUUID();
  readonly code = 'session_transcript_unavailable';
  constructor(
    cause: unknown,
    readonly variant: string,
  ) {
    super('Session transcript unavailable', { cause });
    this.name = 'TranscriptReadFailure';
  }
  telemetry() {
    const diagnostic = runtimeFailureDiagnostics(this.cause);
    const reason =
      this.cause instanceof ZodError
        ? 'history_schema_invalid'
        : this.cause instanceof Error
          ? (replayReasons.get(this.cause.message) ?? 'history_read_failed')
          : 'history_read_failed';
    return {
      code: this.code,
      diagnosticId: this.diagnosticId,
      variant: this.variant,
      reason,
      stage: diagnostic.failedCheck ?? 'transcript.request',
      ...diagnostic,
    };
  }
}

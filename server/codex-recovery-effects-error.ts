import { SessionRuntimeError } from './session-runtime-error.js';

export type RecoveryReceiptCheck =
  | 'call_count_mismatch'
  | 'receipt_missing'
  | 'turn_mismatch'
  | 'tool_mismatch'
  | 'request_mismatch'
  | 'result_missing'
  | 'result_mismatch'
  | 'effect_unsettled';

/** Private diagnostic metadata, separate from the strict public failure wire.
 * Never retain tool arguments, result bodies or upstream exception text here. */
export class CodexRecoveryEffectsError extends SessionRuntimeError {
  constructor(
    readonly failedCheck: RecoveryReceiptCheck,
    private readonly identity: Readonly<{
      commandId: string;
      turnId: string;
      callId?: string;
      observedCalls: number;
      retainedReceipts: number;
    }>,
  ) {
    super('recovery_effects_unverified');
  }
  recoveryTelemetry() {
    return {
      recoveryStage: 'host_receipts',
      recoveryFailedCheck: this.failedCheck,
      ...this.identity,
    };
  }
}

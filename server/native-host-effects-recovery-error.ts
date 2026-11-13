import { z } from 'zod';
import { SessionRuntimeError } from './session-runtime-error.js';

const Diagnostic = z.strictObject({
  stage: z.literal('native_host_effects'),
  reason: z.enum([
    'receipt_count_mismatch',
    'receipt_missing',
    'turn_mismatch',
    'tool_mismatch',
    'request_mismatch',
    'result_missing',
    'result_outcome_mismatch',
    'effects_unsettled',
  ]),
  commandId: z.string().min(1).max(200),
  callId: z.string().min(1).max(200).optional(),
  nativeCallCount: z.number().int().nonnegative(),
  receiptCount: z.number().int().nonnegative(),
});

/** Fixed cause and original operation identifiers only. Arguments, result text,
 * account data and upstream exceptions never enter public copy or diagnostics. */
export class NativeHostEffectsRecoveryError extends SessionRuntimeError {
  readonly diagnostic: Readonly<z.infer<typeof Diagnostic>>;
  constructor(diagnostic: z.infer<typeof Diagnostic>) {
    super('recovery_effects_unverified');
    this.diagnostic = Object.freeze(Diagnostic.parse(diagnostic));
  }
}

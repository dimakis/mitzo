import { SandboxCreationPreflightError } from './symposium-workspace-lifecycle.js';

const failureCodes = [
  'SEAT_ARTIFACT_LEASE_FAILED',
  'SEAT_ARTIFACT_VERIFICATION_FAILED',
  'SEAT_MANAGER_SETUP_FAILED',
  'SEAT_CAPABILITY_RECHECK_FAILED',
  'SEAT_MOUNT_CUSTODY_FAILED',
  'SEAT_MOUNT_NATIVE_IDENTITY_FAILED',
  'SEAT_MOUNT_NATIVE_ACCESS_FAILED',
  'SEAT_MOUNT_NATIVE_TIMEOUT',
  'SEAT_MOUNT_ACCESS_PROOF_FAILED',
  'SEAT_MOUNT_POSTCHECK_FAILED',
  'SEAT_MOUNT_VERIFICATION_FAILED',
  'SEAT_ARTIFACT_BINDING_FAILED',
] as const;

type ReconciliationFailureCode = (typeof failureCodes)[number];

/** Keep the original error internal; only the fixed code may enter diagnostics. */
class SymposiumReconciliationError extends Error {
  constructor(
    readonly code: ReconciliationFailureCode,
    cause: unknown,
  ) {
    super(code, { cause });
    this.name = 'SymposiumReconciliationError';
  }
}

export function symposiumReconciliationFailureCode(error: unknown): string {
  // Only the known dispatch fence wrapper may expose an inner stage. Never walk
  // arbitrary provider errors or accept their user-controlled code metadata.
  const failure = error instanceof SandboxCreationPreflightError ? error.cause : error;
  return failure instanceof SymposiumReconciliationError && failureCodes.includes(failure.code)
    ? failure.code
    : 'RECONCILIATION_FAILED';
}

export function atSymposiumReconciliationStage<T>(
  code: ReconciliationFailureCode,
  operation: () => T,
): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof SymposiumReconciliationError) throw cause;
    throw new SymposiumReconciliationError(code, cause);
  }
}

export async function atSymposiumReconciliationStageAsync<T>(
  code: ReconciliationFailureCode,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof SymposiumReconciliationError) throw cause;
    throw new SymposiumReconciliationError(code, cause);
  }
}

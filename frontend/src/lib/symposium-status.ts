/** Durable status permits an action request; the server still verifies authority on each POST. */
export function canRequestAgent(seat: {
  admitted?: boolean;
  admissionRecorded?: boolean;
  savedRuntimeState?: string | null;
  membership?: { state: string; reconciliation?: string } | null;
  creationDiagnostic?: unknown;
}): boolean {
  if (seat.admissionRecorded !== undefined)
    return (
      seat.admissionRecorded &&
      seat.savedRuntimeState === 'ready' &&
      seat.membership?.state === 'active' &&
      seat.membership.reconciliation === 'confirmed' &&
      !seat.creationDiagnostic
    );
  return seat.admitted === true;
}

export function canRequestRuntime(status: {
  runtimeAvailable?: boolean;
  runtimeVerification?: string;
}): boolean {
  return status.runtimeVerification === 'not_checked' || status.runtimeAvailable === true;
}

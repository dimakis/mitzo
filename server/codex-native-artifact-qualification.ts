/** Official aarch64-apple-darwin 0.160.0 artifact exercised by the no-model
 * native/kernel fixtures. Version text alone cannot qualify executable bytes. */
const QUALIFIED_NATIVE_MAC_ARTIFACT =
  '112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b';
export const NATIVE_MAC_ARTIFACT_UNAVAILABLE =
  'Native Mac execution is unavailable for this unqualified Codex artifact.';
export class NativeMacExecutionUnavailableError extends Error {
  readonly code = 'native_mac_artifact_unqualified';
  constructor() {
    super(NATIVE_MAC_ARTIFACT_UNAVAILABLE);
  }
}
/** Preserve only this fixed trusted capability diagnostic through startup
 * wrappers. Arbitrary provider/cwd/credential errors remain sanitized. */
export function findNativeMacExecutionUnavailable(
  error: unknown,
): NativeMacExecutionUnavailableError | undefined {
  const seen = new Set<Error>();
  for (let depth = 0; depth < 8 && error instanceof Error && !seen.has(error); depth++) {
    if (error instanceof NativeMacExecutionUnavailableError) return error;
    seen.add(error);
    error = error.cause;
  }
  return undefined;
}
export function assertQualifiedNativeMacExecutionArtifact(sha256: string): void {
  if (sha256 !== QUALIFIED_NATIVE_MAC_ARTIFACT) throw new NativeMacExecutionUnavailableError();
}

/** Official aarch64-apple-darwin 0.171.0 artifact exercised by the no-model
 * native/kernel fixtures. Version text alone cannot qualify executable bytes. */
const QUALIFIED_NATIVE_MAC_ARTIFACT =
  'fc8d77cf7585aded2b9bc487dad29c4ee2f066123e4e76dd3b17653a8322ce42';
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

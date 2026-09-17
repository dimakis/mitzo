/**
 * External result IDs cross a provider boundary and are returned to browser
 * clients. Keep this deliberately narrower than a URL: capability executors
 * must use an opaque provider identifier (or a hash), never a bearer URL or
 * arbitrary provider response.
 */
const opaqueIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sensitiveIdentifier =
  /(?:secret|token|password|credential|authorization|api[-_]?key|bearer)/i;

export function isSafeExternalResultId(value: unknown): value is string {
  return (
    typeof value === 'string' && opaqueIdentifier.test(value) && !sensitiveIdentifier.test(value)
  );
}

export function assertSafeExternalResultId(value: string | undefined): void {
  if (value !== undefined && !isSafeExternalResultId(value))
    throw new Error('Executor result is invalid');
}

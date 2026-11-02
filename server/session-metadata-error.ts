const admissionErrors = new Set([
  'Ordinary command admission does not match durable session identity',
  'Explicit command execution selection changed',
  'Prepared repository settings source unavailable',
]);
const resourceErrors = new Map([
  ['SQLITE_BUSY', 'storage_busy'],
  ['SQLITE_BUSY_SNAPSHOT', 'storage_busy'],
  ['SQLITE_LOCKED', 'storage_busy'],
  ['SQLITE_CANTOPEN', 'storage_unavailable'],
  ['SQLITE_CORRUPT', 'storage_unavailable'],
  ['SQLITE_NOTADB', 'storage_unavailable'],
  ['SQLITE_FULL', 'storage_full'],
  ['ENOSPC', 'storage_full'],
  ['EACCES', 'access_denied'],
  ['EPERM', 'access_denied'],
]);

/** Operator diagnostics contain only fixed classifications and reviewed codes.
 * Never serialize exception text, stack paths, SQL or diagnostic getters. */
export function sessionMetadataDiagnostic(error: unknown): Record<string, string> {
  try {
    if (error instanceof Error) {
      const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
      const reason = typeof code === 'string' ? resourceErrors.get(code) : undefined;
      if (typeof code === 'string' && reason)
        return { metadataFailure: reason, metadataErrorCode: code };
      const message: unknown = Object.getOwnPropertyDescriptor(error, 'message')?.value;
      if (typeof message === 'string' && admissionErrors.has(message))
        return { metadataFailure: 'admission_identity_changed' };
      if (error instanceof SyntaxError) return { metadataFailure: 'invalid_json' };
      if (error instanceof TypeError) return { metadataFailure: 'type_error' };
    }
  } catch {
    // A malformed diagnostic must not replace the original metadata failure.
  }
  return { metadataFailure: 'unexpected' };
}

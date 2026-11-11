import { z } from 'zod';

const failureCodes = new Map([
  ['SQLITE_BUSY', 'sqlite_busy'],
  ['SQLITE_BUSY_SNAPSHOT', 'sqlite_busy'],
  ['SQLITE_LOCKED', 'sqlite_busy'],
  ['SQLITE_ERROR', 'sqlite_unavailable'],
  ['SQLITE_CANTOPEN', 'sqlite_unavailable'],
  ['SQLITE_CORRUPT', 'sqlite_unavailable'],
  ['SQLITE_NOTADB', 'sqlite_unavailable'],
  ['SQLITE_FULL', 'resource_exhausted'],
  ['EACCES', 'filesystem_denied'],
  ['EPERM', 'filesystem_denied'],
  ['ENOSPC', 'resource_exhausted'],
  ['EMFILE', 'resource_exhausted'],
  ['ENFILE', 'resource_exhausted'],
  ['MITZO_OWNER_BUSY', 'owner_unavailable'],
  ['MITZO_OWNER_UNSUPPORTED', 'owner_unavailable'],
  ['ETIMEDOUT', 'process_timeout'],
  ['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'process_output_limit'],
]);

/** Describe only bounded, recognized failure facts. Never serialize exceptions,
 * SQL, paths, schema values, process output or arbitrary upstream names/codes.
 * Data descriptors avoid executing diagnostic getters; malformed causes stay unknown. */
export function describeTelosOperationFailure(error: unknown): Record<string, string | number> {
  let errorKind = 'unknown';
  try {
    const seen = new Set<Error>();
    for (let cause = error; cause instanceof Error && seen.size < 4 && !seen.has(cause);) {
      seen.add(cause);
      errorKind = cause instanceof TypeError ? 'type' : 'error';
      const code: unknown = Object.getOwnPropertyDescriptor(cause, 'code')?.value;
      const reason = typeof code === 'string' ? failureCodes.get(code) : undefined;
      if (typeof code === 'string' && reason)
        return {
          reason,
          errorKind: code.startsWith('SQLITE_') ? 'sqlite' : 'error',
          errorCode: code,
        };
      if (typeof code === 'number' && Number.isInteger(code) && code > 0 && code <= 255)
        return {
          reason: 'process_failed',
          errorKind: 'error',
          errorCode: 'process_exit',
          exitCode: code,
        };
      if (cause instanceof z.ZodError) return { reason: 'invalid_schema', errorKind: 'validation' };
      if (cause instanceof SyntaxError) return { reason: 'invalid_json', errorKind: 'syntax' };
      if (
        cause instanceof TypeError &&
        Object.getOwnPropertyDescriptor(cause, 'message')?.value ===
          'The database connection is not open'
      )
        return { reason: 'database_closed', errorKind: 'type' };
      cause = Object.getOwnPropertyDescriptor(cause, 'cause')?.value;
    }
  } catch {
    // Diagnostics cannot replace the original operation's outcome.
  }
  return { reason: 'unexpected', errorKind };
}

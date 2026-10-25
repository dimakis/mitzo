import { createHash } from 'node:crypto';

type Failure = {
  name: string;
  messageSha256?: string;
  code?: string;
  issues?: Array<{ code: string; path: Array<string | number> }>;
  issuesSha256?: string;
  cause?: Failure;
};
type Stage = {
  calls: number;
  returned: number;
  startedAt: number;
  lastReturnedAt?: number;
  errors: Array<Failure & { at: number }>;
};
type Check = { status: 'passed' | 'failed' | 'error' | 'not-reached'; error?: Failure };
const data = (value: object, key: string): unknown =>
  Object.getOwnPropertyDescriptor(value, key)?.value;
const token = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value);

const errorCodes = new Set([
  'pending_host_task_authority_required',
  'pending_host_task_access_required',
  'pending_host_task_ownership_changed',
  'pending_host_task_uncertain',
  'pending_host_task_invalid_input',
  'fixture_preservation_check_failed',
  'fixture_setup_check_failed',
  'SQLITE_CONSTRAINT_TRIGGER',
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_BUSY',
  'SQLITE_ERROR',
  'ENOENT',
  'EACCES',
  'EPERM',
]);
const issueCodes = new Set([
  'invalid_type',
  'invalid_value',
  'invalid_format',
  'too_big',
  'too_small',
  'unrecognized_keys',
  'custom',
]);
const schemaFields = new Set([
  'version',
  'request',
  'state',
  'rootIdentity',
  'directory',
  'sourceDigest',
  'taskIdentity',
  'root',
  'git',
  'dev',
  'ino',
  'featureBranch',
  'linkedGit',
  'identity',
  'localSource',
  'path',
  'selection',
  'repositoryId',
  'commonDirectory',
  'commonRoot',
  'binding',
  'runtimeBinding',
  'accountId',
  'profileRevision',
  'taskRoot',
  'nativeTarget',
  'prepareCallId',
  'requestHash',
]);

/** No raw message, stack, source value, path or arbitrary error property leaves
 * this fixture. Hash the original message and retain finite type/schema/cause
 * metadata so generic product error translation cannot erase classification. */
export function preparationDiagnosticFailure(error: unknown, depth = 0): Failure {
  const result: Failure = {
    name:
      error instanceof TypeError
        ? 'TypeError'
        : error instanceof RangeError
          ? 'RangeError'
          : error instanceof Error
            ? 'Error'
            : 'non-error',
  };
  if (!error || typeof error !== 'object') return result;
  try {
    const name = data(error, 'name');
    if (
      typeof name === 'string' &&
      ['Error', 'TypeError', 'RangeError', 'ZodError', 'AssertionError'].includes(name)
    )
      result.name = name;
    const message = data(error, 'message');
    if (typeof message === 'string')
      result.messageSha256 = createHash('sha256').update(message).digest('hex');
    const code = data(error, 'code');
    if (typeof code === 'string' && errorCodes.has(code)) result.code = code;
    const issues = data(error, 'issues');
    if (Array.isArray(issues))
      result.issues = issues.slice(0, 4).flatMap((issue: unknown) => {
        if (!issue || typeof issue !== 'object') return [];
        const code = data(issue, 'code'),
          path = data(issue, 'path');
        if (typeof code !== 'string' || !issueCodes.has(code) || !Array.isArray(path)) return [];
        return [
          {
            code,
            path: path
              .slice(0, 4)
              .map((part: unknown) =>
                typeof part === 'number' && Number.isSafeInteger(part)
                  ? part
                  : typeof part === 'string' && schemaFields.has(part)
                    ? part
                    : 'redacted',
              ),
          },
        ];
      });
    // Zod can expose message lazily. Keep refusing getters; fingerprint only
    // the finite, redacted issue projection when schema classification exists.
    if (result.issues?.length)
      result.issuesSha256 = createHash('sha256')
        .update(JSON.stringify(result.issues))
        .digest('hex');
    const cause = data(error, 'cause');
    if (cause !== undefined && depth < 3)
      result.cause = preparationDiagnosticFailure(cause, depth + 1);
  } catch {
    // Diagnostic projection cannot replace the original error it describes.
  }
  return result;
}

export function createPreparationAttemptDiagnostics() {
  const stages: Record<string, Stage> = {},
    checks: Record<string, Check> = {};
  const stage = (name: string) => {
    if (!token(name) || (!stages[name] && Object.keys(stages).length >= 48))
      throw Error('Fixture diagnostic stage limit');
    return (stages[name] ??= { calls: 0, returned: 0, startedAt: Date.now(), errors: [] });
  };
  const recordError = (entry: Stage, error: unknown) => {
    if (entry.errors.length < 4)
      entry.errors.push({ ...preparationDiagnosticFailure(error), at: Date.now() });
  };
  const captureSync = <T>(name: string, action: () => T): T => {
    const entry = stage(name);
    entry.calls++;
    try {
      const result = action();
      entry.returned++;
      entry.lastReturnedAt = Date.now();
      return result;
    } catch (error) {
      recordError(entry, error);
      throw error;
    }
  };
  const capture = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const entry = stage(name);
    entry.calls++;
    try {
      const result = await action();
      entry.returned++;
      entry.lastReturnedAt = Date.now();
      return result;
    } catch (error) {
      recordError(entry, error);
      throw error;
    }
  };
  return {
    capture,
    captureSync,
    async observe<T>(name: string, action: () => Promise<T>): Promise<T | undefined> {
      try {
        return await capture(name, action);
      } catch {
        return undefined;
      }
    },
    async check(name: string, action: () => Promise<boolean>) {
      if (!token(name) || (!checks[name] && Object.keys(checks).length >= 32))
        throw Error('Fixture diagnostic check limit');
      try {
        checks[name] = { status: (await action()) === true ? 'passed' : 'failed' };
      } catch (error) {
        checks[name] = { status: 'error', error: preparationDiagnosticFailure(error) };
      }
    },
    skip(name: string) {
      if (!token(name) || (!checks[name] && Object.keys(checks).length >= 32))
        throw Error('Fixture diagnostic check limit');
      checks[name] = { status: 'not-reached' };
    },
    snapshot() {
      return structuredClone({ version: 1 as const, stages, checks });
    },
  };
}
export type PreparationAttemptDiagnostics = ReturnType<typeof createPreparationAttemptDiagnostics>;

export async function recordPreparationAttempt<T>(
  diagnostics: PreparationAttemptDiagnostics,
  stage: string,
  run: () => Promise<T>,
  inspect: () => Promise<void>,
  persist: (snapshot: ReturnType<PreparationAttemptDiagnostics['snapshot']>) => Promise<void>,
): Promise<T> {
  let result: T | undefined;
  let failed = false,
    failure: unknown;
  try {
    result = await diagnostics.capture(stage, run);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await diagnostics.capture('observations', inspect);
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  try {
    await diagnostics.capture('record-write', () => persist(diagnostics.snapshot()));
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
  return result as T;
}

export async function runRecordedPreparationAttempt<T>(
  diagnostics: PreparationAttemptDiagnostics,
  run: () => Promise<T>,
  inspect: () => Promise<void>,
  persist: (snapshot: ReturnType<PreparationAttemptDiagnostics['snapshot']>) => Promise<void>,
): Promise<T> {
  const result = await recordPreparationAttempt(diagnostics, 'operation', run, inspect, persist);
  if (Object.values(diagnostics.snapshot().checks).some((check) => check.status !== 'passed'))
    throw Object.assign(Error('Fixture preservation check failed'), {
      code: 'fixture_preservation_check_failed',
    });
  return result as T;
}

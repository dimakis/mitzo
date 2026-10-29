import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  createPreparationAttemptDiagnostics,
  preparationDiagnosticFailure,
  recordPreparationAttempt,
  runRecordedPreparationAttempt,
} from './fixtures/preparation-attempt-diagnostics.js';
import { z } from 'zod';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

it.each([
  'operation',
  'service',
  'receipt-schema',
  'row-cas',
  'cleanup',
  'context-outward',
  'private-publication-helper',
])('persists the original %s error before the generic response assertion', async (stage) => {
  const diagnostic = createPreparationAttemptDiagnostics();
  const original = new Error(`private fixture failure /private/synthetic/${stage}`);
  const record: unknown[] = [];
  const check = vi.fn(async () => false);
  let thrown: unknown;
  try {
    await runRecordedPreparationAttempt(
      diagnostic,
      () =>
        diagnostic.capture(stage, async () => {
          throw original;
        }),
      async () => {
        await diagnostic.check('source-preserved', check);
        await diagnostic.check('primary-preserved', async () => {
          throw Error('secondary');
        });
      },
      async (snapshot) => {
        record.push(snapshot);
      },
    );
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBe(original);
  expect(record).toHaveLength(1);
  const snapshot = diagnostic.snapshot();
  expect(snapshot.stages[stage].errors[0].messageSha256).toBe(hash(original.message));
  expect(snapshot.stages.operation.errors[0].messageSha256).toBe(hash(original.message));
  expect(snapshot.checks['source-preserved'].status).toBe('failed');
  expect(snapshot.checks['primary-preserved'].status).toBe('error');
  expect(check).toHaveBeenCalledOnce();
  expect(JSON.stringify(record)).not.toContain('/private/synthetic');
  // The provider's generic result and its first assertion cannot erase record.
  expect(() => expect({ success: false }.success).toBe(true)).toThrow();
  expect(record).toHaveLength(1);
});

it('records every source/custody/linkage failure before a strict check failure', async () => {
  const diagnostic = createPreparationAttemptDiagnostics();
  const records: unknown[] = [];
  await expect(
    runRecordedPreparationAttempt(
      diagnostic,
      async () => ({ state: 'materialized' }),
      async () => {
        for (const name of [
          'source-index',
          'source-head',
          'source-dirty',
          'source-staged',
          'source-untracked',
          'primary-custody',
          'task-linkage',
        ])
          await diagnostic.check(name, async () => false);
      },
      async (snapshot) => {
        records.push(snapshot);
      },
    ),
  ).rejects.toMatchObject({ code: 'fixture_preservation_check_failed' });
  expect(records).toHaveLength(1);
  expect(Object.values(diagnostic.snapshot().checks).map((check) => check.status)).toEqual(
    Array(7).fill('failed'),
  );
  expect(diagnostic.snapshot().stages.operation.returned).toBe(1);
});

it('keeps actor return, service failure, row observation and cleanup failure distinct', async () => {
  const diagnostic = createPreparationAttemptDiagnostics();
  const serviceError = Object.assign(Error('pending_host_task_uncertain'), {
    code: 'pending_host_task_uncertain',
  });
  let persisted: ReturnType<typeof diagnostic.snapshot> | undefined;
  await expect(
    runRecordedPreparationAttempt(
      diagnostic,
      async () => {
        await diagnostic.capture('actor', async () => ({ publication: true }));
        return diagnostic.capture('service', async () => {
          throw serviceError;
        });
      },
      async () => {
        await diagnostic.observe('row-state', async () => ({ state: 'materializing' }));
        await diagnostic.observe('object-cleanup', async () => {
          throw Error('cleanup failed');
        });
        diagnostic.skip('task-linkage');
      },
      async (snapshot) => {
        persisted = snapshot;
      },
    ),
  ).rejects.toBe(serviceError);
  expect(persisted!.stages.actor.returned).toBe(1);
  expect(persisted!.stages.service.errors[0].code).toBe('pending_host_task_uncertain');
  expect(persisted!.stages['row-state'].returned).toBe(1);
  expect(persisted!.stages['object-cleanup'].errors).toHaveLength(1);
  expect(persisted!.checks['task-linkage'].status).toBe('not-reached');
});

it('does not replace the original exception if inspection or record writing fails', async () => {
  const diagnostic = createPreparationAttemptDiagnostics();
  const original = Error('original');
  await expect(
    runRecordedPreparationAttempt(
      diagnostic,
      async () => {
        throw original;
      },
      async () => {
        throw Error('inspection');
      },
      async () => {
        throw Error('record sink');
      },
    ),
  ).rejects.toBe(original);
  expect(diagnostic.snapshot().stages.observations.errors).toHaveLength(1);
  expect(diagnostic.snapshot().stages['record-write'].errors).toHaveLength(1);
});

it('retains bounded schema issue metadata without values or getter execution', async () => {
  const diagnostic = createPreparationAttemptDiagnostics();
  const getter = vi.fn(() => 'secret');
  const error = Object.defineProperties(Error('secret supplied source contents'), {
    code: { get: getter },
    issues: { value: [{ code: 'invalid_type', path: ['taskIdentity'], received: 'secret' }] },
  });
  await expect(
    diagnostic.capture('receipt-schema', async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(getter).not.toHaveBeenCalled();
  expect(diagnostic.snapshot().stages['receipt-schema'].errors[0].issues).toEqual([
    { code: 'invalid_type', path: ['taskIdentity'] },
  ]);
  expect(JSON.stringify(diagnostic.snapshot())).not.toContain('secret');
});

it('fingerprints finite schema metadata without evaluating lazy message accessors', () => {
  const sentinel = 'SYNTHETIC_PRIVATE_SCHEMA_VALUE';
  const getter = vi.fn(() => sentinel);
  const error = Object.defineProperties(
    {},
    {
      name: { value: 'ZodError' },
      message: { get: getter },
      issues: {
        value: [{ code: 'invalid_type', path: ['taskIdentity', sentinel], received: sentinel }],
      },
    },
  );
  const projected = preparationDiagnosticFailure(error);
  expect(projected.name).toBe('ZodError');
  expect(projected.messageSha256).toBeUndefined();
  expect(projected.issues).toEqual([{ code: 'invalid_type', path: ['taskIdentity', 'redacted'] }]);
  expect(projected.issuesSha256).toBe(hash(JSON.stringify(projected.issues)));
  expect(getter).not.toHaveBeenCalled();
  expect(JSON.stringify(projected)).not.toContain(sentinel);

  const parsed = z.object({ root: z.string() }).safeParse({ root: 42 });
  expect(parsed.success).toBe(false);
  if (parsed.success) throw Error('Expected schema failure');
  const message = Object.getOwnPropertyDescriptor(parsed.error, 'message');
  expect(message?.get).toBeTypeOf('function');
  const actual = preparationDiagnosticFailure(parsed.error);
  expect(actual.issues).toEqual([{ code: 'invalid_type', path: ['root'] }]);
  expect(actual.issuesSha256).toBe(hash(JSON.stringify(actual.issues)));
  expect(actual.messageSha256).toBeUndefined();
  expect(Object.getOwnPropertyDescriptor(parsed.error, 'message')).toEqual(message);
});

it('joins asynchronous checks and cleanup before persistence or outward success', async () => {
  const diagnostic = createPreparationAttemptDiagnostics();
  const order: string[] = [];
  const result = await runRecordedPreparationAttempt(
    diagnostic,
    async () => {
      order.push('operation');
      return 'receipt';
    },
    async () => {
      await diagnostic.check('source', async () => {
        await Promise.resolve();
        order.push('source');
        return true;
      });
      await diagnostic.observe('cleanup', async () => {
        await Promise.resolve();
        order.push('cleanup');
      });
    },
    async () => {
      order.push('persisted');
    },
  );
  expect(result).toBe('receipt');
  expect(order).toEqual(['operation', 'source', 'cleanup', 'persisted']);
});

it('preserves the first outer native-call error when final persistence also fails', async () => {
  const diagnostics = createPreparationAttemptDiagnostics();
  const original = Error('synthetic outward context failure');
  await expect(
    recordPreparationAttempt(
      diagnostics,
      'native-call',
      async () => {
        throw original;
      },
      async () => {},
      async () => {
        throw Error('final record write failed');
      },
    ),
  ).rejects.toBe(original);
  expect(diagnostics.snapshot().stages['native-call'].errors[0].messageSha256).toBe(
    hash(original.message),
  );
  expect(diagnostics.snapshot().stages['record-write'].errors).toHaveLength(1);
});

it('redacts credential-shaped codes and dynamic schema path keys', async () => {
  const diagnostic = createPreparationAttemptDiagnostics();
  const sentinel = 'SYNTHETIC_CREDENTIAL_TOKEN_12345';
  const error = Object.assign(Error('bounded fixture error'), {
    code: sentinel,
    issues: [{ code: 'invalid_type', path: ['taskIdentity', sentinel] }],
  });
  await expect(
    diagnostic.capture('receipt-schema', async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  const projected = diagnostic.snapshot().stages['receipt-schema'].errors[0];
  expect(projected.code).toBeUndefined();
  expect(projected.issues).toEqual([{ code: 'invalid_type', path: ['taskIdentity', 'redacted'] }]);
  expect(JSON.stringify(diagnostic.snapshot())).not.toContain(sentinel);
});

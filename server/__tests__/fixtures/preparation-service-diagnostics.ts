import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { PendingHostTaskReceiptSchema } from '../../pending-host-task.js';
import type { RepositoryWorkspaces } from '../../repository-workspaces.js';
import type { PreparationAttemptDiagnostics } from './preparation-attempt-diagnostics.js';

/** Test-only finite probes. Original methods, arguments and receivers are used;
 * no record bytes, SQL bindings, paths or source values enter diagnostics. */
export function observePreparationService(
  diagnostics: PreparationAttemptDiagnostics,
  service: RepositoryWorkspaces,
  observedReceipt?: (
    receipt: Awaited<ReturnType<RepositoryWorkspaces['materializeQualifiedPendingHostTask']>>,
  ) => void,
) {
  const restores: Array<() => void> = [];
  const install = (target: object, key: string, value: unknown) => {
    const own = Object.getOwnPropertyDescriptor(target, key);
    let descriptor = own;
    for (
      let parent = Object.getPrototypeOf(target) as object | null;
      !descriptor && parent;
      parent = Object.getPrototypeOf(parent) as object | null
    )
      descriptor = Object.getOwnPropertyDescriptor(parent, key);
    if (!descriptor || typeof descriptor.value !== 'function')
      throw Error('Missing preparation diagnostic method');
    Object.defineProperty(target, key, { ...descriptor, value });
    restores.push(() => {
      if (own) Object.defineProperty(target, key, own);
      else Reflect.deleteProperty(target, key);
    });
  };
  let receipt: unknown = { status: 'not-reached' };
  const cas = { calls: 0, returned: 0, zeroChanges: 0 };
  const materialize = service.materializeQualifiedPendingHostTask;
  install(
    service,
    'materializeQualifiedPendingHostTask',
    async function (this: RepositoryWorkspaces, ...args: Parameters<typeof materialize>) {
      const value = await diagnostics.capture('service-materialize', () =>
        Reflect.apply(materialize, this, args),
      );
      receipt = {
        status: 'returned',
        state: value.state,
        sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
        taskIdentitySha256: value.taskIdentity
          ? createHash('sha256').update(JSON.stringify(value.taskIdentity)).digest('hex')
          : null,
      };
      // Private fixture observation only. The sanitized diagnostic snapshot never
      // includes this real receipt or reconstructs it from public result JSON.
      observedReceipt?.(value);
      return value;
    },
  );
  const parse = PendingHostTaskReceiptSchema.parse;
  install(
    PendingHostTaskReceiptSchema,
    'parse',
    function (this: typeof PendingHostTaskReceiptSchema, ...args: Parameters<typeof parse>) {
      return diagnostics.captureSync('receipt-schema', () => Reflect.apply(parse, this, args));
    },
  );
  // Existing actual service database, exposed ONLY to this fixture observer.
  const db = (service as unknown as { db: Database.Database }).db;
  const prepare = db.prepare;
  // Plain wrappers retain no call histories or unrelated SQL statements. A mock
  // here would retain every owner lookup throughout the full journey.
  install(db, 'prepare', function (this: Database.Database, sql: string) {
    const statement = Reflect.apply(prepare, this, [sql]);
    if (
      sql ===
      'UPDATE repository_workspaces SET record=? WHERE id=? AND record=? AND conversation_id IS NULL'
    ) {
      const run = statement.run;
      install(statement, 'run', function (this: typeof statement, ...args: unknown[]) {
        cas.calls++;
        const result = diagnostics.captureSync('row-cas', () => Reflect.apply(run, this, args));
        cas.returned++;
        if (result.changes === 0) cas.zeroChanges++;
        return result;
      });
    }
    return statement;
  });
  return Object.assign(() => structuredClone({ receipt, cas }), {
    restore: () => {
      for (const restore of restores.splice(0).reverse()) restore();
    },
  });
}

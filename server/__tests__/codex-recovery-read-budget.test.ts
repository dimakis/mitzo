import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexConversationStore } from '../codex-conversation-store.js';

const stores: CodexConversationStore[] = [];
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  stores.splice(0).forEach((store) => store.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

it('bounds exact recovery observations independently of completed history and queued successors', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-recovery-budget-'));
  roots.push(root);
  const store = new CodexConversationStore(join(root, 'native.db'));
  stores.push(store);
  const db = (store as unknown as { db: Database.Database }).db;
  const binding = {
    accountId: 'offline',
    accountLabel: 'Offline API',
    provider: 'openai' as const,
    profileRevision: 'api-r1',
    model: 'synthetic',
  };
  // Build the static history through the same store transitions, with nested
  // savepoints and one durable commit instead of syncing every fixture write.
  // The recovery observations below run after this preparation has committed.
  db.transaction(() => {
    for (const session of ['first', 'second']) {
      store.create(session, binding, '/sandbox/workspaces/task');
      store.bindThread(session, binding, `thread-${session}`);
      for (let index = 0; index < 200; index++) {
        const id = `${session}-${index}`;
        store.enqueue(session, binding, { id, prompt: id });
        const command = store.claimNext(session, binding)!;
        store.recordNativeTurnAck(session, binding, command, `thread-${session}`, `turn-${index}`);
        store.finish(session, binding, id, 'completed', `turn-${index}`);
      }
      for (let index = 0; index < 20; index++)
        store.enqueue(session, binding, { id: `${session}-queued-${index}`, prompt: 'later' });
    }
  })();
  expect(db.inTransaction).toBe(false);
  expect(
    db
      .prepare(
        'SELECT conversation_id,status,COUNT(*) AS count FROM codex_commands GROUP BY conversation_id,status ORDER BY conversation_id,status',
      )
      .all(),
  ).toEqual([
    { conversation_id: 'first', status: 'completed', count: 200 },
    { conversation_id: 'first', status: 'queued', count: 20 },
    { conversation_id: 'second', status: 'completed', count: 200 },
    { conversation_id: 'second', status: 'queued', count: 20 },
  ]);
  const prepare = db.prepare.bind(db);
  let rows = 0,
    bytes = 0,
    reads = 0;
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql);
    const query = sql.replace(/\bc\./g, '');
    if (
      !/SELECT (?:id,)?status,attempt,native_turns,pre_dispatch_failure/.test(query) ||
      !query.includes('ORDER BY sequence DESC')
    )
      return statement;
    return new Proxy(statement, {
      get(target, key) {
        if (key === 'iterate')
          return function* (...args: unknown[]) {
            reads++;
            for (const row of Reflect.apply(target.iterate, target, args)) {
              rows++;
              bytes += Buffer.byteLength(JSON.stringify(row));
              yield row;
            }
          };
        if (key !== 'get' && key !== 'all') return Reflect.get(target, key, target);
        return (...args: unknown[]) => {
          reads++;
          const result: unknown = Reflect.apply(target[key], target, args);
          rows += Array.isArray(result) ? result.length : result ? 1 : 0;
          bytes += Buffer.byteLength(JSON.stringify(result) ?? '');
          return result;
        };
      },
    });
  });
  const durations: number[] = [];
  for (let sample = 0; sample < 11; sample++) {
    const start = performance.now();
    for (const session of ['first', 'second']) {
      expect(store.recoveryProbeThreadId(session, binding)).toBe(`thread-${session}`);
      expect(store.nativeRecoveryTarget(session, binding)).toEqual({
        commandId: `${session}-199`,
        attempt: 1,
        threadId: `thread-${session}`,
        turnId: 'turn-199',
        generation: 0,
      });
    }
    durations.push(performance.now() - start);
  }
  if (process.env.MITZO_MEASURE_RECOVERY)
    console.log(
      JSON.stringify({
        workload: 'two-session-recovery-200-completed-20-queued',
        reads,
        rows,
        bytes,
        durationsMs: durations,
      }),
    );
  expect(reads).toBe(44);
  expect(rows).toBe(44);
});

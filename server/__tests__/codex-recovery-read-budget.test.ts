import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { observeNativeRecoveryTurn, interruptedEffectCalls } from '../codex-interrupted-effects.js';
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

it('pages interrupted results within frames and rejects incomplete or changing native evidence', async () => {
  const target = {
    commandId: 'original',
    attempt: 1,
    threadId: 'thread',
    turnId: 'turn',
    generation: 0,
  };
  const metadata = { data: [{ id: 'turn', status: 'interrupted', error: null }] };
  const entry = (id: string, output = '') => ({
    turnId: 'turn',
    item: {
      id,
      type: 'commandExecution',
      status: 'completed',
      exitCode: 0,
      aggregatedOutput: output,
    },
  });
  const guard = vi.fn(async () => {});
  const request = vi.fn(
    async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      expect(params).toMatchObject({ threadId: 'thread', limit: 1 });
      if (method === 'thread/turns/list') {
        expect(params.itemsView).toBe('notLoaded');
        return metadata;
      }
      expect(method).toBe('thread/items/list');
      expect(params.turnId).toBe('turn');
      // Individually legal retained items whose combined full turn exceeds 4 MiB.
      const result = {
        data: [entry(params.cursor ? 'second' : 'first', 'x'.repeat(2_200_000))],
        nextCursor: params.cursor ? null : 'next',
      };
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4_194_304);
      return result;
    },
  );
  const result = await observeNativeRecoveryTurn(request, 'app', target, true, guard);
  expect(interruptedEffectCalls(result.settledEffects!, 'app', target)).toEqual([]);
  expect(request).toHaveBeenCalledTimes(4);
  expect(guard).toHaveBeenCalledTimes(3);

  for (const variant of [
    'foreign',
    'duplicate',
    'cursor',
    'missing',
    'budget',
    'empty',
    'changed',
    'oversized',
  ] as const) {
    let reads = 0,
      pages = 0;
    const invalid = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'thread/turns/list')
        return ++reads === 2 && variant === 'changed'
          ? { data: [{ id: 'replacement', status: 'completed', error: null }] }
          : metadata;
      pages++;
      if (variant === 'oversized') throw Error('frame_too_large');
      if (variant === 'missing') return { data: [] };
      if (variant === 'empty') return { data: [], nextCursor: 'next' };
      return {
        data: [
          {
            ...entry(variant === 'duplicate' ? 'same' : String(pages)),
            turnId: variant === 'foreign' ? 'other' : 'turn',
          },
        ],
        nextCursor:
          variant === 'cursor' || variant === 'duplicate'
            ? 'next'
            : variant === 'budget'
              ? String(pages)
              : null,
      };
    });
    await expect(observeNativeRecoveryTurn(invalid, 'app', target, true, guard)).rejects.toThrow();
    expect(pages).toBeLessThanOrEqual(128);
    expect(
      invalid.mock.calls.some(
        ([method]) => !['thread/turns/list', 'thread/items/list'].includes(method),
      ),
    ).toBe(false);
  }
});

it('settles observed terminal command failures and applied patches without replaying their effects', async () => {
  const target = {
    commandId: 'original',
    attempt: 1,
    threadId: 'thread',
    turnId: 'turn',
    generation: 0,
  };
  const metadata = { data: [{ id: 'turn', status: 'interrupted', error: null }] };
  const valid = [
    { type: 'commandExecution', id: 'not-found', status: 'failed', exitCode: 127 },
    { type: 'commandExecution', id: 'cancelled-shell', status: 'failed', exitCode: 130 },
    {
      type: 'fileChange',
      id: 'patch',
      status: 'completed',
      changes: [
        { path: '/task/fix.ts', kind: { type: 'update', move_path: null }, diff: '-old\n+new' },
      ],
    },
  ];
  const request = (item: unknown) =>
    vi.fn(async (method: string) =>
      method === 'thread/turns/list'
        ? metadata
        : { data: [{ turnId: 'turn', item }], nextCursor: null },
    );
  for (const item of valid) {
    const read = request(item);
    const result = await observeNativeRecoveryTurn(read, 'app', target, true, async () => {});
    expect(interruptedEffectCalls(result.settledEffects!, 'app', target)).toEqual([]);
    expect(read.mock.calls.map(([method]) => method)).toEqual([
      'thread/turns/list',
      'thread/items/list',
      'thread/turns/list',
    ]);
  }
  for (const item of [
    { ...valid[0], exitCode: null },
    { ...valid[0], exitCode: 0 },
    { ...valid[0], exitCode: 1.5 },
    { ...valid[0], exitCode: -1 },
    { ...valid[0], status: 'inProgress' },
    { ...valid[2], status: 'failed' },
    { ...valid[2], status: 'inProgress' },
    { ...valid[2], changes: [] },
    { ...valid[2], changes: [{ path: '/task/fix.ts', kind: { type: 'update' }, diff: '' }] },
    {
      ...valid[2],
      changes: [{ path: '/task/fix.ts', kind: { type: 'update', move_path: 42 }, diff: '' }],
    },
    {
      ...valid[2],
      changes: [{ path: '/task/fix.ts', kind: { type: 'update', movePath: null }, diff: '' }],
    },
    {
      ...valid[2],
      changes: [{ path: '/task/fix.ts', kind: { type: 'add', move_path: '/other' }, diff: '' }],
    },
    { ...valid[2], changes: [{ path: '/task/fix.ts', kind: { type: 'future' }, diff: '' }] },
  ])
    await expect(
      observeNativeRecoveryTurn(request(item), 'app', target, true, async () => {}),
    ).rejects.toThrow();
});

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

  // The incident includes terminal turns with 836 items; length alone must not
  // strand their owner at the former 128-item cutoff. Keep every I/O fence.
  let longPages = 0;
  const longRead = vi.fn(async (method: string) =>
    method === 'thread/turns/list'
      ? metadata
      : {
          data: [{ turnId: 'turn', item: { id: String(++longPages), type: 'contextCompaction' } }],
          nextCursor: longPages < 836 ? String(longPages) : null,
        },
  );
  guard.mockClear();
  const longResult = await observeNativeRecoveryTurn(longRead, 'app', target, true, guard);
  expect(interruptedEffectCalls(longResult.settledEffects!, 'app', target)).toEqual([]);
  expect(longPages).toBe(836);
  expect(guard).toHaveBeenCalledTimes(837);

  for (const variant of [
    'foreign',
    'duplicate',
    'cursor',
    'missing',
    'budget',
    'empty',
    'changed',
    'oversized',
    'bytes',
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
            ...entry(
              variant === 'duplicate' ? 'same' : String(pages),
              variant === 'bytes' ? 'x'.repeat(2_200_000) : '',
            ),
            turnId: variant === 'foreign' ? 'other' : 'turn',
          },
        ],
        nextCursor:
          variant === 'cursor' || variant === 'duplicate'
            ? 'next'
            : variant === 'budget' || variant === 'bytes'
              ? String(pages)
              : null,
      };
    });
    const failure = observeNativeRecoveryTurn(invalid, 'app', target, true, guard);
    if (variant === 'budget' || variant === 'oversized' || variant === 'bytes')
      await expect(failure).rejects.toMatchObject({
        code: variant === 'oversized' ? 'recovery_history_unavailable' : 'recovery_history_limit',
      });
    else await expect(failure).rejects.toThrow();
    expect(pages).toBeLessThanOrEqual(variant === 'bytes' ? 8 : 1024);
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
    { type: 'webSearch', id: 'searched', query: 'release notes' },
    { type: 'imageView', id: 'viewed', path: '/task/image.png' },
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
  for (const item of [...valid, { type: 'contextCompaction', id: 'compacted' }]) {
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
    { type: 'webSearch', id: 'pending-search', query: 'notes', status: 'inProgress' },
    { type: 'imageView', id: 'missing-image-path' },
    { ...valid[0], exitCode: null },
    { ...valid[0], exitCode: 0 },
    { ...valid[0], exitCode: 1.5 },
    { ...valid[0], exitCode: -1 },
    { ...valid[0], status: 'inProgress' },
    { ...valid[4], status: 'failed' },
    { ...valid[4], status: 'inProgress' },
    { ...valid[4], changes: [] },
    { ...valid[4], changes: [{ path: '/task/fix.ts', kind: { type: 'update' }, diff: '' }] },
    {
      ...valid[4],
      changes: [{ path: '/task/fix.ts', kind: { type: 'update', move_path: 42 }, diff: '' }],
    },
    {
      ...valid[4],
      changes: [{ path: '/task/fix.ts', kind: { type: 'update', movePath: null }, diff: '' }],
    },
    {
      ...valid[4],
      changes: [{ path: '/task/fix.ts', kind: { type: 'add', move_path: '/other' }, diff: '' }],
    },
    { ...valid[4], changes: [{ path: '/task/fix.ts', kind: { type: 'future' }, diff: '' }] },
  ])
    await expect(
      observeNativeRecoveryTurn(request(item), 'app', target, true, async () => {}),
    ).rejects.toThrow();
});

it('verifies every terminal child turn and parent link before recovering a tree', async () => {
  const target = {
    commandId: 'original',
    attempt: 1,
    threadId: 'root',
    turnId: 'root-turn',
    generation: 0,
  };
  const threads = {
    root: {
      id: 'root',
      parentThreadId: null,
      sessionId: 'tree',
      cwd: '/task',
      modelProvider: 'openai',
      status: { type: 'notLoaded' },
    },
    child: {
      id: 'child',
      parentThreadId: 'root',
      sessionId: 'tree',
      cwd: '/task',
      modelProvider: 'openai',
      status: { type: 'notLoaded' },
    },
  };
  const activity = (id: string, agentThreadId: string) => ({
    id,
    type: 'subAgentActivity',
    kind: 'interacted',
    agentThreadId,
  });
  const history = {
    'root-turn': [activity('spawn', 'child')],
    'child-new': [{ id: 'patch', type: 'commandExecution', status: 'completed', exitCode: 0 }],
    'child-old': [
      activity('reply-to-parent', 'root'),
      { id: 'failed', type: 'commandExecution', status: 'failed', exitCode: 1 },
      {
        id: 'child-read',
        type: 'dynamicToolCall',
        tool: 'GitHubRead',
        arguments: { endpoint: '/repos/owner/repo' },
        status: 'failed',
        success: false,
      },
    ],
  };
  const guard = vi.fn(async () => {});
  for (const variant of [
    'settled',
    'interrupted-child',
    'optional-child-error',
    'active',
    'foreign',
    'cycle',
    'cwd',
    'budget',
    'earlier-unknown',
    'child-write',
    'changed',
    'empty',
    'revoked',
  ] as const) {
    let childReads = 0;
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      const threadId = params.threadId as keyof typeof threads;
      if (method === 'thread/read')
        return {
          thread: {
            ...threads[threadId],
            ...(threadId === 'child' && variant === 'foreign' ? { sessionId: 'foreign' } : {}),
            ...(threadId === 'child' && variant === 'cycle' ? { parentThreadId: 'child' } : {}),
            ...(threadId === 'child' && variant === 'cwd' ? { cwd: '/other' } : {}),
            ...(threadId === 'child' && variant === 'active' ? { status: { type: 'active' } } : {}),
          },
        };
      if (method === 'thread/turns/list') {
        if (threadId === 'child' && variant === 'empty') return { data: [], nextCursor: null };
        if (threadId === 'child') childReads++;
        const turnId =
          threadId === 'root' ? 'root-turn' : params.cursor ? 'child-old' : 'child-new';
        return {
          data: [
            {
              id: variant === 'changed' && childReads > 2 ? 'replacement' : turnId,
              status: threadId === 'root' ? 'interrupted' : 'completed',
              ...(threadId === 'child' && variant === 'optional-child-error'
                ? {}
                : { error: null }),
            },
          ],
          nextCursor: threadId === 'child' && !params.cursor ? 'older' : null,
        };
      }
      expect(method).toBe('thread/items/list');
      if (variant === 'revoked' && threadId === 'child') throw Error('authority revoked');
      const turnId = params.turnId as keyof typeof history;
      const index = Number(params.cursor ?? 0);
      if (variant === 'budget' && threadId === 'child')
        return {
          data: [{ turnId, item: { id: String(index), type: 'reasoning' } }],
          nextCursor: String(index + 1),
        };
      const item =
        variant === 'earlier-unknown' && turnId === 'child-old' && index === 1
          ? { id: 'pending', type: 'commandExecution', status: 'inProgress', exitCode: null }
          : structuredClone(history[turnId][index]);
      if (variant === 'interrupted-child' && turnId === 'root-turn')
        Object.assign(item, { kind: 'interrupted' });
      if (variant === 'child-write' && turnId === 'child-old' && index === 2)
        Object.assign(item, { tool: 'GitCommit' });
      return {
        data: [{ turnId, item }],
        nextCursor: index + 1 < history[turnId].length ? String(index + 1) : null,
      };
    });
    const result = observeNativeRecoveryTurn(request, 'app', target, true, guard, '/task');
    if (['settled', 'interrupted-child', 'optional-child-error'].includes(variant)) {
      expect(interruptedEffectCalls((await result).settledEffects!, 'app', target)).toEqual([
        expect.objectContaining({
          threadId: 'child',
          turnId: 'child-old',
          toolName: 'GitHubRead',
          intrinsicRead: true,
        }),
      ]);
      expect(
        request.mock.calls.filter(
          ([method, params]) => method === 'thread/items/list' && params.turnId === 'child-old',
        ),
      ).toHaveLength(3);
    } else await expect(result).rejects.toThrow();
    expect(
      request.mock.calls.every(([method]) =>
        ['thread/read', 'thread/turns/list', 'thread/items/list'].includes(method),
      ),
    ).toBe(true);
  }
});

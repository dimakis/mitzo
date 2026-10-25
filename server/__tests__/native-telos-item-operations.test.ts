import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { TelosItemStore } from '../telos-item-store.js';
import { TelosWorkStore } from '../telos-work-store.js';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { executeNativeTelosItemOperation } from '../native-telos-item-operations.js';
import type { NativeHostToolContext } from '../native-host-tool-context.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const f = createTelosCanonicalData('fresh');
  cleanup.push(() => f.close());
  for (const [id, parent] of [
    ['child', 'studio'],
    ['other', null],
  ] as const)
    f.db
      .prepare(
        `INSERT INTO items(id,parent_id,summary,intent,rationale,acceptance_criteria,profile,priority,first_seen,last_seen,created_at,updated_at)
      VALUES(?,?,'Review evidence','Review','Evidence','["Verified result"]','manual',5,?,?,?,?)`,
      )
      .run(id, parent, f.stamp, f.stamp, f.stamp, f.stamp);
  const work = new TelosWorkStore(f.dbPath, { ordinaryConversation: () => true });
  const items = new TelosItemStore(f.dbPath);
  cleanup.push(
    () => work.close(),
    () => items.close(),
  );
  const command = (raw: Record<string, unknown>, itemId = 'studio') =>
    work.execute(
      {
        ...raw,
        itemId,
        requestId: randomUUID(),
        expectedRevision: work.read(itemId, f.actor).revision,
      },
      f.actor,
    );
  for (const [itemId, kind] of [
    ['studio', 'outcome'],
    ['child', 'work_item'],
    ['other', 'outcome'],
  ] as const)
    command({ operation: 'classify', kind }, itemId);
  const assign = (conversationId: string) =>
    command({
      operation: 'setup_role',
      role: 'lead',
      conversationId,
      expectedAssignmentRevision:
        work.read('studio', f.actor).assignments.find((a) => a.role === 'lead')?.revision ?? 0,
    });
  assign('planning');
  let current = true;
  const role = {
    version: 1 as const,
    itemId: 'studio',
    itemKind: 'outcome' as const,
    role: 'lead' as const,
    brief: { revision: 'original', text: 'Reviewed scope', sha256: hash('Reviewed scope') },
    parentCriteria: [],
    overallGoal: { itemId: 'studio', revision: 'original', text: 'Studio' },
    artifacts: [],
    sources: [],
  };
  const currentSync = vi.fn(() => {
    if (!current) throw Error('Original native actor retired');
  });
  const approve = vi.fn(async (_name: string, input: Record<string, unknown>) => ({
    behavior: 'allow' as const,
    updatedInput: structuredClone(input),
  }));
  // Component-port fixture only. Final App proof must capture the real signed
  // native actor and request-only permission; this object grants neither.
  const context = (name: string, raw: Record<string, unknown>) =>
    ({
      conversationId: 'planning',
      operatorId: 'synthetic-operator',
      clientId: 'original-client',
      selectedRole: role,
      toolName: name,
      requestHash: hash(JSON.stringify(raw)),
      signal: new AbortController().signal,
      assertCurrentSync: currentSync,
      async assertCurrent() {
        currentSync();
      },
    }) as unknown as NativeHostToolContext;
  const run = (
    name: 'TelosGetItem' | 'TelosUpdateItem',
    raw: Record<string, unknown>,
    overrides: Partial<NativeHostToolContext> = {},
  ) =>
    executeNativeTelosItemOperation(
      { work, items, approve, context: { ...context(name, raw), ...overrides } },
      name,
      raw,
    );
  const update = (itemId = 'child', requestId = randomUUID()) => ({
    itemId,
    requestId,
    expectedRevision: items.read(itemId).revision,
    status: 'completed' as const,
    note: 'Verified retained artifact revision and task review.',
  });
  return {
    f,
    work,
    items,
    assign,
    approve,
    currentSync,
    run,
    update,
    retire: () => {
      current = false;
    },
  };
}

it('reads and completes only the explicitly requested child, then its eligible parent through the real canonical owners', async () => {
  const f = fixture();
  const read = await f.run('TelosGetItem', { itemId: 'child' });
  expect(read.isError).toBe(false);
  expect(JSON.parse(read.content)).toMatchObject({
    ok: true,
    item: { id: 'child', status: 'active' },
  });
  const child = await f.run('TelosUpdateItem', f.update());
  expect(child.isError).toBe(false);
  expect(JSON.parse(child.content)).toMatchObject({
    ok: true,
    item: { id: 'child', status: 'completed' },
    update: { sessionId: 'planning' },
  });
  expect(f.items.read('studio').status).toBe('active');
  const parent = await f.run('TelosUpdateItem', f.update('studio'));
  expect(parent.isError).toBe(false);
  expect(f.items.read('studio').status).toBe('completed');
  expect(f.items.read('other')).toMatchObject({ status: 'active', updates: [] });
});

it.each(['other', 'missing'])(
  'refuses out-of-scope %s before approval and preserves every item',
  async (itemId) => {
    const f = fixture();
    const before = f.items.read('studio');
    const result = await f.run('TelosGetItem', { itemId });
    expect(result.isError).toBe(true);
    expect(f.approve).not.toHaveBeenCalled();
    expect(f.items.read('studio')).toEqual(before);
  },
);

it.each(['worker', 'advisor', 'reviewer', undefined] as const)(
  'refuses a non-lead role %s before approval',
  async (role) => {
    const f = fixture();
    const result = await f.run('TelosUpdateItem', f.update(), {
      selectedRole: role
        ? ({ ...f.work.read('studio', f.f.actor), role, itemId: 'studio' } as never)
        : undefined,
    });
    expect(result.isError).toBe(true);
    expect(f.approve).not.toHaveBeenCalled();
    expect(f.items.read('child')).toMatchObject({ status: 'active', updates: [] });
  },
);

it.each(['before', 'during'] as const)(
  'refuses a retired canonical lead %s approval despite retained role data',
  async (timing) => {
    const f = fixture();
    if (timing === 'before') f.assign('replacement-lead');
    else
      f.approve.mockImplementation(async (_name, input) => {
        f.assign('replacement-lead');
        return { behavior: 'allow', updatedInput: input };
      });
    const result = await f.run('TelosUpdateItem', f.update());
    expect(result.isError).toBe(true);
    expect(f.items.read('child')).toMatchObject({ status: 'active', updates: [] });
    expect(f.approve).toHaveBeenCalledTimes(timing === 'before' ? 0 : 1);
  },
);

it('refuses actor revocation and changed decision input after the actual approval await', async () => {
  const f = fixture();
  f.approve.mockImplementationOnce(async (_name, input) => {
    f.retire();
    return { behavior: 'allow', updatedInput: input };
  });
  expect((await f.run('TelosUpdateItem', f.update())).isError).toBe(true);
  expect(f.items.read('child')).toMatchObject({ status: 'active', updates: [] });
  const g = fixture();
  g.approve.mockImplementationOnce(async (_name, input) => ({
    behavior: 'allow',
    updatedInput: { ...input, note: 'changed' },
  }));
  expect((await g.run('TelosUpdateItem', g.update())).isError).toBe(true);
  expect(g.items.read('child')).toMatchObject({ status: 'active', updates: [] });
});

it('retains canonical fresh-revision, unfinished-descendant and exact request replay semantics', async () => {
  const f = fixture();
  expect((await f.run('TelosUpdateItem', f.update('studio'))).isError).toBe(true);
  expect(f.items.read('studio')).toMatchObject({ status: 'active', updates: [] });
  const input = f.update();
  const result = await f.run('TelosUpdateItem', input);
  expect(result.isError).toBe(false);
  f.items.update(
    { ...f.update(), status: 'active', note: 'New evidence; reopen.', requestId: 'external' },
    'another-session',
  );
  expect(await f.run('TelosUpdateItem', input)).toEqual(result);
  expect(f.items.read('child').status).toBe('active');
  expect((await f.run('TelosUpdateItem', { ...input, note: 'different receipt' })).isError).toBe(
    true,
  );
  expect((await f.run('TelosUpdateItem', { ...input, requestId: 'fresh-stale' })).isError).toBe(
    true,
  );
});

it('executes a current native guard inside the real canonical transaction and never after a committed effect', async () => {
  const f = fixture();
  const owner = f.items as unknown as { db: { inTransaction: boolean } };
  let inside = 0;
  f.currentSync.mockImplementation(() => {
    if (owner.db.inTransaction) inside++;
    if (f.items.read('child').status === 'completed') throw Error('Post-effect guard must not run');
  });
  const result = await f.run('TelosUpdateItem', f.update());
  expect(result.isError).toBe(false);
  expect(inside).toBeGreaterThan(0);
  expect(f.items.read('child').status).toBe('completed');
});

it('refuses a fresh update after ancestor archive while preserving an exact known committed receipt', async () => {
  const f = fixture();
  const input = f.update();
  const saved = await f.run('TelosUpdateItem', input);
  expect(saved.isError).toBe(false);
  f.work.executeLifecycle(
    {
      itemId: 'studio',
      operation: 'archive',
      requestId: randomUUID(),
      expectedRevision: f.work.read('studio', f.f.actor).revision,
    },
    f.f.actor,
  );
  const before = f.items.read('child');
  expect(await f.run('TelosUpdateItem', input)).toEqual(saved);
  const fresh = await f.run('TelosUpdateItem', {
    ...f.update(),
    status: 'active',
    note: 'This new write must not change archived work.',
  });
  expect(fresh.isError).toBe(true);
  expect(f.items.read('child')).toEqual(before);
});

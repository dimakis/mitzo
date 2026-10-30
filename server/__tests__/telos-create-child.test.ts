import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { TelosItemStore } from '../telos-item-store.js';
import { executeTelosBacklogOperation } from '../telos-backlog-tools.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);

function fixture(variant: 'fresh' | 'upgraded' = 'fresh') {
  const f = createTelosCanonicalData(variant);
  cleanup.push(() => f.close());
  let items = new TelosItemStore(f.dbPath);
  cleanup.push(() => items.close());
  const controller = new AbortController();
  let current = true;
  const assertCurrent = () => {
    if (!current) throw Error('retired');
  };
  const approve = vi.fn(async (_name: string, input: Record<string, unknown>) => ({
    behavior: 'allow' as const,
    updatedInput: input,
  }));
  const input = () => ({
    parentId: 'studio',
    expectedParentRevision: items.read('studio').revision,
    requestId: 'create-panels',
    summary: 'Choose acoustic panels',
    intent: 'Select a panel layout for the studio',
    rationale: 'Reduce reflections in recordings',
    acceptanceCriteria: ['Panel layout reviewed'],
    note: 'Split the approved studio work into a concrete child.',
  });
  const run = (raw: Record<string, unknown>) =>
    executeTelosBacklogOperation(
      {
        items,
        work: f.work,
        approve,
        context: {
          operatorId: f.actor.id,
          conversationId: 'planning',
          toolName: 'TelosCreateChild',
          requestHash: createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
          signal: controller.signal,
          assertCurrentSync: assertCurrent,
          async assertCurrent() {
            assertCurrent();
          },
        },
      },
      'TelosCreateChild',
      raw,
    );
  return {
    ...f,
    get items() {
      return items;
    },
    input,
    run,
    approve,
    controller,
    retire() {
      current = false;
    },
    restart() {
      items.close();
      f.restartOwners();
      items = new TelosItemStore(f.dbPath);
    },
  };
}

it.each(['fresh', 'upgraded'] as const)(
  'creates one canonical child with its brief, parent and audit evidence (%s)',
  async (variant) => {
    const f = fixture(variant);
    const input = f.input();
    const before = f.items.read('studio');
    const result = await f.run(input);
    expect(result.isError, result.content).toBe(false);
    const receipt = JSON.parse(result.content);
    expect(receipt).toMatchObject({
      ok: true,
      item: {
        parentId: 'studio',
        summary: input.summary,
        intent: input.intent,
        rationale: input.rationale,
        acceptanceCriteria: input.acceptanceCriteria,
        status: 'active',
      },
      update: { sessionId: 'planning', requestId: input.requestId, note: input.note },
    });
    const parent = f.items.read('studio');
    expect(parent.children).toEqual([
      { id: receipt.item.id, summary: input.summary, status: 'active' },
    ]);
    expect(parent.revision).not.toBe(before.revision);
    expect(receipt.parentRevision).toBe(parent.revision);
    expect(parent).toMatchObject({ summary: before.summary, status: before.status });
    const row = f.db
      .prepare('SELECT profile,context_hints FROM items WHERE id=?')
      .get(receipt.item.id);
    expect(row).toEqual({
      profile: 'manual',
      context_hints: JSON.stringify({ session_ids: ['planning'] }),
    });
    expect(
      f.db.prepare('SELECT new_status FROM history WHERE item_id=?').all(receipt.item.id),
    ).toEqual([{ new_status: 'active' }]);
    expect(f.work.listItems({ parentId: 'studio' }, f.actor).items.map((item) => item.id)).toEqual([
      receipt.item.id,
    ]);
    const work = f.work.read(receipt.item.id, f.actor);
    expect(work.assignments).toEqual([]);
    expect(work.attempts).toEqual([]);
    expect(work.sources).toEqual([]);
    expect(f.approve).toHaveBeenCalledWith('TelosCreateChild', input, expect.any(AbortSignal));
  },
);

it('recovers the immutable creation receipt after restart and later parent edits without duplication', async () => {
  const f = fixture();
  const input = f.input();
  const first = await f.run(input);
  expect(first.isError, first.content).toBe(false);
  f.db.prepare("UPDATE items SET summary='Later parent title' WHERE id='studio'").run();
  f.restart();
  expect(await f.run(input)).toEqual(first);
  expect(f.items.read('studio').children).toHaveLength(1);
  const changed = await f.run({ ...input, summary: 'Different child' });
  expect(changed.isError).toBe(true);
  expect(changed.content).toMatch(/request identity reused/i);
  expect(f.items.read('studio').children).toHaveLength(1);
});

it('requires a fresh parent revision for each new child, including concurrent decomposition', async () => {
  const f = fixture();
  const input = f.input();
  expect((await f.run(input)).isError).toBe(false);
  const stale = await f.run({ ...input, requestId: 'next' });
  expect(stale.isError).toBe(true);
  expect(stale.content).toMatch(/changed/);
  expect((await f.run({ ...f.input(), requestId: 'next', summary: 'Measure room' })).isError).toBe(
    false,
  );
  expect(f.items.read('studio').children).toHaveLength(2);
});

it.each(['missing', 'completed', 'archived', 'trashed', 'ancestor-archived'])(
  'refuses a new child under a %s parent',
  async (state) => {
    const f = fixture();
    const input = f.input();
    if (state === 'missing') input.parentId = 'missing';
    else if (state === 'completed') {
      f.db.prepare("UPDATE items SET status='completed' WHERE id='studio'").run();
      input.expectedParentRevision = f.items.read('studio').revision;
    } else {
      const itemId = 'studio';
      if (state === 'ancestor-archived') {
        const result = JSON.parse((await f.run(input)).content);
        input.parentId = result.item.id;
        input.requestId = 'grandchild';
        input.expectedParentRevision = f.items.read(input.parentId).revision;
      }
      f.work.executeLifecycle(
        {
          operation: state === 'trashed' ? 'trash' : 'archive',
          itemId,
          expectedRevision: f.work.readLifecycle(itemId, f.actor).revision,
          requestId: state,
        },
        f.actor,
      );
    }
    const count = f.db.prepare('SELECT count(*) AS n FROM items').get();
    expect((await f.run(input)).isError).toBe(true);
    expect(f.db.prepare('SELECT count(*) AS n FROM items').get()).toEqual(count);
  },
);

it('returns a known committed receipt after archive but refuses a new creation', async () => {
  const f = fixture();
  const input = f.input();
  const first = await f.run(input);
  expect(first.isError).toBe(false);
  f.work.executeLifecycle(
    {
      operation: 'archive',
      itemId: 'studio',
      requestId: 'archive',
      expectedRevision: f.work.readLifecycle('studio', f.actor).revision,
    },
    f.actor,
  );
  expect(await f.run(input)).toEqual(first);
  expect((await f.run({ ...f.input(), requestId: 'new' })).isError).toBe(true);
});

it('rolls back the child, parent timestamp, history and receipt together on persistence failure', async () => {
  const f = fixture();
  const input = f.input();
  const parent = f.items.read('studio');
  f.db.exec(`CREATE TRIGGER fail_child_history BEFORE INSERT ON history
    BEGIN SELECT RAISE(ABORT, 'Synthetic history failure'); END;`);
  expect((await f.run(input)).isError).toBe(true);
  expect(f.items.read('studio')).toEqual(parent);
  expect(f.db.prepare('SELECT count(*) AS n FROM items').get()).toEqual({ n: 1 });
  f.db.exec('DROP TRIGGER fail_child_history');
  expect((await f.run(input)).isError).toBe(false);
  expect(f.items.read('studio').children).toHaveLength(1);
});

it('checks authority inside the canonical writer and refuses async assertions', () => {
  const f = fixture();
  f.db.pragma('busy_timeout = 0');
  const assertion = vi.fn(() => {
    expect(() => f.db.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
    throw Error('Retired inside writer');
  });
  expect(() => f.items.createChildGuarded(f.input(), 'planning', assertion, () => {})).toThrow(
    'Retired inside writer',
  );
  expect(assertion).toHaveBeenCalledOnce();
  expect(() =>
    f.items.createChildGuarded(
      f.input(),
      'planning',
      async () => {},
      () => {},
    ),
  ).toThrow('Synchronous Telos item authority required');
  expect(f.items.read('studio').children).toEqual([]);
});

it('does not disclose a saved creation receipt after the session authority expires', async () => {
  const f = fixture();
  const input = f.input();
  expect((await f.run(input)).isError).toBe(false);
  f.retire();
  expect((await f.run(input)).isError).toBe(true);
});

it.each(['denied', 'modified', 'retired', 'cancelled', 'parent-changed'])(
  'does not create a child when approval is %s',
  async (state) => {
    const f = fixture();
    const input = f.input();
    f.approve.mockImplementationOnce(async (_name, exact) => {
      if (state === 'retired') f.retire();
      if (state === 'cancelled') f.controller.abort();
      if (state === 'parent-changed')
        f.db.prepare("UPDATE items SET summary='Changed' WHERE id='studio'").run();
      if (state === 'denied') return { behavior: 'deny', message: 'No' } as never;
      return {
        behavior: 'allow',
        updatedInput: state === 'modified' ? { ...exact, parentId: 'other' } : exact,
      };
    });
    expect((await f.run(input)).isError).toBe(true);
    expect(f.items.read('studio').children).toEqual([]);
  },
);

it.each([
  { parentId: '' },
  { expectedParentRevision: 'stale' },
  { requestId: '' },
  { summary: '' },
  { intent: '' },
  { rationale: '' },
  { acceptanceCriteria: [] },
  { note: '' },
  { status: 'completed' },
  { operatorId: 'spoofed' },
  { profile: 'github' },
])('rejects invalid or caller-supplied authority before approval: %j', async (invalid) => {
  const f = fixture();
  expect((await f.run({ ...f.input(), ...invalid })).isError).toBe(true);
  expect(f.approve).not.toHaveBeenCalled();
  expect(f.items.read('studio').children).toEqual([]);
});

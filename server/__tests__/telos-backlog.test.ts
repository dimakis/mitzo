import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { TelosItemStore } from '../telos-item-store.js';

const close: Array<() => void> = [];
afterEach(() =>
  close
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture() {
  const f = createTelosCanonicalData('fresh');
  close.push(() => f.close());
  const items = new TelosItemStore(f.dbPath);
  close.push(() => items.close());
  for (const [id, parent, title] of [
    ['a', null, 'Old acoustic plan'],
    ['b', 'a', 'Panel layout'],
    ['c', null, '100% literal'],
  ])
    f.db
      .prepare(
        `INSERT INTO items(id,parent_id,summary,intent,rationale,acceptance_criteria,profile,priority,first_seen,last_seen,created_at,updated_at)
    VALUES(?,?,?,'Compare sources','Inform decision','["Review evidence"]','manual',5,?,?,?,?)`,
      )
      .run(id, parent, title, f.stamp, f.stamp, f.stamp, f.stamp);
  return { ...f, items };
}

it('lists and searches a bounded canonical page with stable continuation and no detail hydration', () => {
  const f = fixture();
  const first = f.work.listItems({ limit: 2 }, f.actor);
  expect(first.items.map((i) => i.id)).toEqual(['a', 'b']);
  expect(first.nextCursor).toBe('b');
  expect(first.items[0]).not.toHaveProperty('sources');
  expect(
    f.work.listItems({ limit: 2, cursor: first.nextCursor! }, f.actor).items.map((i) => i.id),
  ).toEqual(['c', 'studio']);
  expect(f.work.listItems({ query: 'literal' }, f.actor).items.map((i) => i.id)).toEqual(['c']);
  expect(f.work.listItems({ query: '%' }, f.actor).items.map((i) => i.id)).toEqual(['c']);
  expect(f.work.listItems({ parentId: 'a' }, f.actor).items.map((i) => i.id)).toEqual(['b']);
  expect(() => f.work.listItems({}, { kind: 'conversation', id: 'foreign' })).toThrow();
  expect(() => f.work.listItems({ limit: 101 }, f.actor)).toThrow();
});

it('omits archived subtrees from active discovery and retains their status and content', () => {
  const f = fixture();
  const before = f.items.read('a');
  f.work.executeLifecycle(
    {
      operation: 'archive',
      itemId: 'a',
      requestId: randomUUID(),
      expectedRevision: f.work.readLifecycle('a', f.actor).revision,
    },
    f.actor,
  );
  expect(f.work.listItems({}, f.actor).items.map((i) => i.id)).toEqual(['c', 'studio']);
  expect(f.work.listItems({ view: 'archive' }, f.actor).items.map((i) => i.id)).toEqual(['a', 'b']);
  expect(f.items.read('a')).toEqual(before);
});
it('searches decoded criteria containing quotes, backslashes and escaped Unicode', () => {
  const f = fixture();
  f.db
    .prepare('UPDATE items SET acceptance_criteria=? WHERE id=?')
    .run(
      String.raw`["Review \"Proposal\" before approval","Inspect C:\\plans\\draft","Read caf\u00e9 notes"]`,
      'a',
    );
  f.db
    .prepare('UPDATE items SET acceptance_criteria=? WHERE id=?')
    .run('legacy malformed JSON', 'b');
  for (const query of [
    'Review "Proposal" before approval',
    String.raw`C:\plans\draft`,
    'café notes',
  ])
    expect(f.work.listItems({ query }, f.actor).items.map((item) => item.id)).toEqual(['a']);
  expect(f.work.listItems({ query: 'Panel layout' }, f.actor).items.map((item) => item.id)).toEqual(
    ['b'],
  );
});
it('keeps discovery concise even when a legacy title contains a wall of text', () => {
  const f = fixture();
  const summary = 'Original explanation '.repeat(5000) + 'searchable tail';
  f.db.prepare('UPDATE items SET summary=? WHERE id=?').run(summary, 'a');
  const item = f.work.listItems({ query: 'searchable tail' }, f.actor).items[0];
  expect(item.summary.length).toBeLessThanOrEqual(240);
  expect(item.summaryTruncated).toBe(true);
  expect(f.items.read('a').summary).toBe(summary);
});

it('batches ordered record reads and reports missing items without discarding ready records', () => {
  const f = fixture();
  const page = f.work.readRecords(['b', 'missing', 'a'], f.actor);
  expect(page.records.map((r) => r.itemId)).toEqual(['b', 'a']);
  expect(page.failures).toEqual([{ itemId: 'missing', code: 'not_found', status: 404 }]);
  expect(() => f.work.readRecords(Array(101).fill('a'), f.actor)).toThrow();
  expect(() => f.work.readRecords(['a'], { kind: 'conversation', id: 'foreign' })).toThrow();
});

it('edits the canonical brief with revision checks, exact retry receipts and an audit note', () => {
  const f = fixture();
  const before = f.items.read('a');
  const input = {
    itemId: 'a',
    requestId: 'rename',
    expectedRevision: before.revision,
    summary: 'Choose acoustic panels',
    intent: 'Select a layout',
    acceptanceCriteria: ['Layout reviewed'],
    note: 'Clarified the title and intended result.',
  };
  const saved = f.items.editGuarded(
    input,
    'planning',
    () => {},
    () => f.work.assertLifecycleActive('a'),
  );
  expect(saved.item).toMatchObject({
    summary: input.summary,
    intent: input.intent,
    acceptanceCriteria: input.acceptanceCriteria,
    status: before.status,
    rationale: before.rationale,
  });
  expect(saved.update.note).toBe(input.note);
  expect(f.items.editGuarded(input, 'planning', () => {})).toEqual(saved);
  expect(() => f.items.editGuarded({ ...input, requestId: 'stale' }, 'planning', () => {})).toThrow(
    'Telos item changed',
  );
  expect(() =>
    f.items.editGuarded({ ...input, summary: 'Different' }, 'planning', () => {}),
  ).toThrow('request identity reused');
  const next = {
    ...input,
    requestId: 'revoked',
    expectedRevision: saved.item.revision,
    summary: 'Forbidden',
  };
  expect(() =>
    f.items.editGuarded(next, 'planning', () => {
      throw Error('retired');
    }),
  ).toThrow('retired');
  expect(f.items.read('a').summary).toBe(input.summary);
});

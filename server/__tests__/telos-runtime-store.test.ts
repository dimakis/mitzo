import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { TelosRuntimeStore } from '../telos-runtime-store.js';
import { TelosItemStore } from '../telos-item-store.js';

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telos-runtime-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'telos.db');
  TelosRuntimeStore.initialize(path);
  const store = new TelosRuntimeStore(path);
  cleanups.push(() => store.close());
  return { path, store };
}
const outcome = {
  summary: 'Keep authored work',
  intent: 'Private durable work',
  rationale: 'Preserve edits',
  acceptanceCriteria: ['History survives'],
  milestones: ['Migrate', 'Verify'],
  profile: 'manual',
  idempotencyKey: 'original-reviewed-creation',
};
describe('Mitzo canonical Telos persistence', () => {
  it('creates an outcome and ordered children atomically, with stable receipt recovery', () => {
    const { store, path } = fixture();
    const receipt = store.createOutcome(outcome, () => {});
    expect(receipt).toMatchObject({
      ok: true,
      created: true,
      item: {
        summary: outcome.summary,
        intent: outcome.intent,
        children: [{ summary: 'Migrate' }, { summary: 'Verify' }],
      },
    });
    const other = new TelosRuntimeStore(path);
    try {
      expect(other.createOutcome(outcome, () => {})).toMatchObject({
        created: false,
        item: { id: receipt.item.id },
      });
      expect(() => other.createOutcome({ ...outcome, summary: 'Different' }, () => {})).toThrow(
        /identity/,
      );
      expect(other.list().items).toHaveLength(1);
    } finally {
      other.close();
    }
  });
  it('checks current authority inside the creation transaction and rolls back a refusal', () => {
    const { store } = fixture();
    expect(() =>
      store.createOutcome(outcome, () => {
        throw Error('revoked');
      }),
    ).toThrow('revoked');
    expect(store.list().items).toEqual([]);
  });
  it('keeps authored fields, hierarchy, progress and receipts across source imports', () => {
    const { store, path } = fixture();
    const record = {
      id: 'imported',
      summary: 'Original',
      profile: 'manual',
      sources: [
        {
          type: 'manual',
          sourceId: 'seed',
          url: '',
          title: 'Original',
          author: 'me',
          timestamp: '2026-11-05T00:00:00Z',
          rawSnippet: '',
        },
      ],
    };
    store.importSources({ items: [record] });
    const edits = new TelosItemStore(path);
    try {
      edits.editGuarded(
        {
          itemId: 'imported',
          requestId: 'edit',
          expectedRevision: edits.read('imported').revision,
          summary: 'Short edited title',
          note: 'User edit',
        },
        'operator',
        () => {},
        () => {},
      );
      store.action('imported', { action: 'priority', priority: 9 });
      store.action('imported', { action: 'done' });
      store.importSources({
        items: [{ ...record, summary: 'Stale enormous seed', parentId: null }],
      });
      const db = new Database(path, { readonly: true });
      try {
        expect(
          db.prepare('SELECT summary,status,priority FROM items WHERE id=?').get('imported'),
        ).toEqual({ summary: 'Short edited title', status: 'completed', priority: 9 });
        expect(edits.read('imported').updates).toHaveLength(1);
      } finally {
        db.close();
      }
    } finally {
      edits.close();
    }
  });
  it('rolls back the whole import on a missing parent and never reparents an existing item', () => {
    const { store } = fixture();
    expect(() =>
      store.importSources({
        items: [
          { id: 'a', summary: 'A', profile: 'work', sources: [] },
          { id: 'b', summary: 'B', profile: 'work', parentId: 'missing', sources: [] },
        ],
      }),
    ).toThrow();
    expect(store.list().items).toEqual([]);
  });
  it('updates actions and history using the selected database without a workspace script', () => {
    const { store, path } = fixture();
    const result = store.create({ summary: 'Ordinary work', profile: 'work' });
    expect(store.action(result.item.id, { action: 'ack' })).toEqual({ ok: true });
    expect(store.list('work').items[0]).toMatchObject({ status: 'acknowledged', priority: 5 });
    const db = new Database(path, { readonly: true });
    try {
      expect(db.prepare('SELECT new_status FROM history ORDER BY id').all()).toEqual([
        { new_status: 'active' },
        { new_status: 'acknowledged' },
      ]);
    } finally {
      db.close();
    }
  });
});

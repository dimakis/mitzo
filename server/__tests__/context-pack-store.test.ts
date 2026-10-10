import { afterEach, expect, it } from 'vitest';
import { ContextPackStore } from '../context-pack-store.js';
const stores: ContextPackStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
const definition = {
  version: 1 as const,
  id: 'core',
  name: 'Core',
  description: 'Shared',
  tokenBudget: 4000,
  documents: [
    {
      path: 'architecture/core.md',
      revision: 'a'.repeat(40),
      mode: 'required' as const,
      headings: [],
      priority: 100,
    },
  ],
  retrievalGuidance: '',
};
function store() {
  const s = new ContextPackStore(':memory:');
  stores.push(s);
  return s;
}
it('keeps published revisions immutable and optimistic draft edits isolated', () => {
  const s = store();
  const draft = s.create(definition);
  const first = s.publish(draft.id, 1);
  expect(first.revision).toBe(1);
  expect(s.getRevision('core', 1)).toEqual(first);
  const secondDraft = s.create({ ...definition, name: 'Core revised' });
  expect(() => s.save(secondDraft.id, 2, definition)).toThrow(/changed/);
  const saved = s.save(secondDraft.id, 1, { ...definition, name: 'Core new' });
  const second = s.publish(saved.id, 2);
  expect(second.revision).toBe(2);
  expect(second.hash).not.toBe(first.hash);
  expect(s.getRevision('core', 1)).toEqual(first);
  expect(s.list().packs).toEqual([second]);
  expect(() => s.save(draft.id, 1, definition)).toThrow(/published/);
});
it('publish retries return exact prior revision and reject stale versions', () => {
  const s = store();
  const d = s.create(definition);
  const p = s.publish(d.id, 1);
  expect(s.publish(d.id, 1)).toEqual(p);
  expect(() => s.publish(d.id, 2)).toThrow(/changed/);
  expect(() => s.getRevision('core', 99)).toThrow(/not found/);
});
it('rejects publishing a draft based on a superseded revision', () => {
  const s = store();
  const one = s.create(definition);
  const two = s.create({ ...definition, name: 'Other' });
  s.publish(one.id, 1);
  expect(() => s.publish(two.id, 1)).toThrow(/newer/);
  expect(s.getDraft(two.id).state).toBe('draft');
});
it('replays stable create/save requests but rejects changed request content', () => {
  const s = store();
  const key = crypto.randomUUID();
  const d = s.create(definition, key);
  expect(s.create(definition, key)).toEqual(d);
  expect(() => s.create({ ...definition, name: 'Changed' }, key)).toThrow(/request/);
  const saveKey = crypto.randomUUID();
  const changed = { ...definition, name: 'Edited' };
  const saved = s.save(d.id, 1, changed, saveKey);
  expect(s.save(d.id, 1, changed, saveKey)).toEqual(saved);
  expect(() => s.save(d.id, 1, definition, saveKey)).toThrow(/request/);
});
it('persists pins and retry receipts across restart and prevents SQL revision mutation', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { default: Database } = await import('better-sqlite3');
  const root = mkdtempSync(join(tmpdir(), 'mitzo-packs-'));
  const path = join(root, 'drafts.db');
  try {
    let s = new ContextPackStore(path);
    const requestId = crypto.randomUUID();
    const draft = s.create(definition, requestId);
    const pack = s.publish(draft.id, 1);
    s.close();
    s = new ContextPackStore(path);
    expect(s.getRevision('core', 1)).toEqual(pack);
    expect(s.create(definition, requestId)).toEqual(draft);
    expect(s.publish(draft.id, 1)).toEqual(pack);
    s.close();
    const db = new Database(path);
    expect(() => db.prepare('UPDATE context_pack_revisions SET value=?').run('{}')).toThrow(
      /immutable/,
    );
    expect(() => db.prepare('DELETE FROM context_pack_revisions').run()).toThrow(/immutable/);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('rejects corrupted publication hashes from detail and catalog reads', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { default: Database } = await import('better-sqlite3');
  const root = mkdtempSync(join(tmpdir(), 'mitzo-pack-integrity-'));
  const path = join(root, 'drafts.db');
  const s = new ContextPackStore(path);
  const db = new Database(path);
  try {
    db.prepare('INSERT INTO context_pack_revisions(id,revision,value) VALUES(?,?,?)').run(
      'core',
      1,
      JSON.stringify({
        id: 'core',
        revision: 1,
        hash: '0'.repeat(64),
        definition,
        publishedAt: new Date().toISOString(),
      }),
    );
    expect(() => s.getRevision('core', 1)).toThrow(/integrity/);
    expect(() => s.list()).toThrow(/integrity/);
    expect(() => s.revisions('core')).toThrow(/integrity/);
  } finally {
    db.close();
    s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

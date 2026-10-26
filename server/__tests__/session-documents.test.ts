import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';

const stores: EventStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function setup(path = ':memory:') {
  const store = new EventStore(path);
  stores.push(store);
  store.upsertSession({ sessionId: 'chat', conversationSource: 'mitzo' });
  store.upsertSession({ sessionId: 'other', conversationSource: 'mitzo' });
  return store;
}
const input = {
  requestId: 'keep-report',
  intent: 'file:report.md@hash',
  title: 'Report',
  filename: 'report.md',
  sourceKey: 'file:report.md',
  sourcePath: '/task/report.md',
  bytes: Buffer.from('# Report'),
};

describe('conversation document custody', () => {
  it('retains bytes in the existing event owner across close/reopen without workspace files or a task', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-documents-'));
    dirs.push(dir);
    const path = join(dir, 'events.db');
    const store = setup(path);
    const saved = store.keepSessionDocument('chat', input);
    expect(saved).toMatchObject({ filename: 'report.md', revision: 1, size: 8, sessionId: 'chat' });
    stores.splice(stores.indexOf(store), 1);
    store.close();
    const reopened = setup(path);
    expect(reopened.readSessionDocument('chat', saved.id, 1).bytes).toEqual(input.bytes);
    expect(reopened.listSessionDocuments('chat')).toEqual([saved]);
    expect(reopened.listSessionDocuments('other')).toEqual([]);
    expect(() => reopened.readSessionDocument('other', saved.id, 1)).toThrow();
  });

  it('recovers the same receipt before reading source and refuses changed retry intent', () => {
    const store = setup();
    const saved = store.keepSessionDocument('chat', input);
    expect(store.sessionDocumentReceipt('chat', input.requestId, input.intent)).toEqual(saved);
    expect(store.keepSessionDocument('chat', input)).toEqual(saved);
    expect(() => store.sessionDocumentReceipt('chat', input.requestId, 'different')).toThrow();
    expect(() => store.keepSessionDocument('chat', { ...input, intent: 'different' })).toThrow();
  });

  it('keeps immutable revisions, deduplicates unchanged bytes and exposes historical metadata', () => {
    const store = setup();
    const first = store.keepSessionDocument('chat', input);
    const second = store.keepSessionDocument('chat', {
      ...input,
      requestId: 'edit',
      intent: 'changed',
      bytes: Buffer.from('# Changed'),
    });
    expect(second.id).toBe(first.id);
    expect(second.revision).toBe(2);
    expect(store.readSessionDocument('chat', first.id, 1).bytes).toEqual(input.bytes);
    expect(store.readSessionDocument('chat', first.id, 2).bytes.toString()).toBe('# Changed');
    expect(store.sessionDocumentVersions('chat', first.id)).toEqual([second, first]);
    expect(
      store.keepSessionDocument('chat', {
        ...input,
        requestId: 'same',
        intent: 'same',
        bytes: Buffer.from('# Changed'),
      }),
    ).toEqual(second);
    expect(store.listSessionDocuments('chat')).toEqual([second]);
  });

  it('enforces size, filename and registered ordinary conversation scope', () => {
    const store = setup();
    expect(() => store.keepSessionDocument('missing', input)).toThrow();
    expect(() =>
      store.keepSessionDocument('chat', { ...input, bytes: Buffer.alloc(5 * 1024 * 1024 + 1) }),
    ).toThrow();
    expect(() =>
      store.keepSessionDocument('chat', { ...input, filename: '../escape.md' }),
    ).toThrow();
    expect(store.listSessionDocuments('chat')).toEqual([]);
  });
});

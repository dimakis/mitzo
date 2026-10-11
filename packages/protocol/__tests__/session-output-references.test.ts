import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStore } from '../src/event-store.js';
import { SessionOutputRegisterInputSchema } from '../src/session-output-reference.js';

const stores: EventStore[] = [];
const dirs: string[] = [];
function setup(path = ':memory:') {
  const store = new EventStore(path);
  stores.push(store);
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo' });
  return store;
}
function finalized(store: EventStore, text = 'The exact draft', blockType = 'text') {
  store.append('source', 'message_start', { messageId: 'message' });
  store.append('source', 'block_start', { messageId: 'message', blockId: 'draft', blockType });
  store.append('source', 'block_delta', {
    messageId: 'message',
    blockId: 'draft',
    blockType,
    delta: text,
  });
  store.append('source', 'block_end', { messageId: 'message', blockId: 'draft', blockType });
  return store.append('source', 'message_end', { messageId: 'message' });
}
function input(messageEndSeq: number, overrides = {}) {
  return {
    requestId: 'keep-one',
    title: 'Email draft',
    source: {
      messageId: 'message',
      blockId: 'draft',
      messageEndSeq,
      sha256: createHash('sha256').update('The exact draft').digest('hex'),
    },
    ...overrides,
  };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('session-first reference outputs', () => {
  it('preserves exact source attribution and invalidates provenance drift even if text is unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-output-provenance-'));
    dirs.push(dir);
    const path = join(dir, 'events.db');
    const store = setup(path);
    const end = finalized(store);
    const provenance = {
      seatId: 'author',
      configRevision: 1,
      accountProfileRevision: 'account-1',
      seatProfileRevision: 'profile-1',
      contextGrantRevision: 1,
      authorityGrantRevision: 1,
      isolationDomainId: 'work',
      isolationDomainRevision: 1,
    };
    const db = new Database(path);
    db.prepare('UPDATE events SET seat_id=?,symposium_provenance=?').run(
      'author',
      JSON.stringify(provenance),
    );
    const output = store.registerSessionOutput('source', input(end));
    expect(output.provenance).toEqual(provenance);
    db.prepare(
      "UPDATE events SET symposium_provenance=? WHERE type != 'session_output_registered'",
    ).run(JSON.stringify({ ...provenance, accountProfileRevision: 'account-2' }));
    expect(store.getSessionOutput('source', output.outputId)).toMatchObject({
      provenance,
      sourceAvailability: 'unavailable',
    });
    expect(() => store.readSessionOutput('source', output.outputId)).toThrow('unavailable');
    db.close();
  });

  it('offers only bounded exact finalized text candidates, excluding thought/tool and unfinished content', () => {
    const store = setup();
    const end = finalized(store);
    store.append('source', 'message_start', { messageId: 'unfinished' });
    store.append('source', 'block_start', {
      messageId: 'unfinished',
      blockId: 'draft',
      blockType: 'text',
    });
    store.append('source', 'block_delta', {
      messageId: 'unfinished',
      blockId: 'draft',
      delta: 'Streaming',
    });
    expect(store.listSessionOutputCandidates('source', 1)).toEqual([
      { source: input(end).source, content: 'The exact draft' },
    ]);
    expect(() => store.listSessionOutputCandidates('source', 101)).toThrow('limit');
    expect(store.listSessionOutputCandidates('unknown')).toEqual([]);
  });

  it('registers exact finalized text without Telos or copying content, and survives close/reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-output-'));
    dirs.push(dir);
    const path = join(dir, 'events.db');
    const store = setup(path);
    const end = finalized(store);
    const output = store.registerSessionOutput('source', input(end));
    expect(output).toMatchObject({
      sessionId: 'source',
      title: 'Email draft',
      revision: 1,
      durability: 'reference_registered',
      label: 'In conversation',
      sourceAvailability: 'available',
      source: { sessionId: 'source', messageId: 'message', blockId: 'draft', messageEndSeq: end },
    });
    expect(output.outputId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(output)).not.toContain('The exact draft');
    expect(
      store.getSessionEvents('source').filter((e) => e.type === 'session_output_registered'),
    ).toHaveLength(1);
    store.markSessionInactive('source');
    store.close();
    const reopened = setup(path);
    expect(reopened.listSessionOutputs('source')).toEqual([output]);
    expect(reopened.readSessionOutput('source', output.outputId)).toEqual({
      output,
      content: 'The exact draft',
    });
    const db = new Database(path);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'telos%'").all()).toEqual([]);
    const row = db.prepare('SELECT * FROM session_output_references').get() as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(row)).not.toContain('The exact draft');
    db.close();
  });

  it('returns the exact receipt on retries and rejects changed retry intent', () => {
    const store = setup();
    const end = finalized(store);
    const first = store.registerSessionOutput('source', input(end));
    expect(store.registerSessionOutput('source', input(end))).toEqual(first);
    expect(() =>
      store.registerSessionOutput('source', input(end, { title: 'Changed title' })),
    ).toThrow('request identity');
    const again = store.registerSessionOutput('source', input(end, { requestId: 'keep-again' }));
    expect(again.outputId).toBe(first.outputId);
    expect(store.listSessionOutputs('source')).toHaveLength(1);
    expect(
      store.getSessionEvents('source').filter((e) => e.type === 'session_output_registered'),
    ).toHaveLength(1);
  });

  it('rejects streaming, non-text, ambiguous, and incorrect-hash sources', () => {
    const store = setup();
    store.append('source', 'message_start', { messageId: 'message' });
    expect(() => store.registerSessionOutput('source', input(100))).toThrow('finalized');
    const toolStore = setup();
    expect(() =>
      toolStore.registerSessionOutput(
        'source',
        input(finalized(toolStore, 'The exact draft', 'thinking')),
      ),
    ).toThrow('text');
    const exactStore = setup();
    const end = finalized(exactStore);
    expect(() =>
      exactStore.registerSessionOutput(
        'source',
        input(end, { source: { ...input(end).source, sha256: '0'.repeat(64) } }),
      ),
    ).toThrow('hash');
    exactStore.append('source', 'message_start', { messageId: 'message' });
    expect(() => exactStore.registerSessionOutput('source', input(end))).toThrow('ambiguous');
    expect(exactStore.listSessionOutputs('source')).toEqual([]);
  });

  it('binds registration, metadata and reads to the authorized owning conversation', () => {
    const store = setup();
    const end = finalized(store);
    const output = store.registerSessionOutput('source', input(end));
    store.upsertSession({ sessionId: 'other', conversationSource: 'mitzo' });
    expect(() => store.registerSessionOutput('other', input(end))).toThrow('finalized');
    expect(store.listSessionOutputs('other')).toEqual([]);
    expect(store.getSessionOutput('other', output.outputId)).toBeNull();
    expect(() => store.readSessionOutput('other', output.outputId)).toThrow('not found');
    expect(() => store.registerSessionOutput('unknown', input(end))).toThrow(
      'registered conversation',
    );
    expect(
      SessionOutputRegisterInputSchema.safeParse({ ...input(end), owner: 'other' }).success,
    ).toBe(false);
    expect(
      SessionOutputRegisterInputSchema.safeParse(
        input(end, { source: { ...input(end).source, sessionId: 'other' } }),
      ).success,
    ).toBe(false);
  });

  it('retains honest reference metadata when source events disappear and refuses body reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-output-missing-'));
    dirs.push(dir);
    const path = join(dir, 'events.db');
    const store = setup(path);
    const output = store.registerSessionOutput('source', input(finalized(store)));
    const db = new Database(path);
    db.prepare("DELETE FROM events WHERE type = 'block_delta'").run();
    db.close();
    expect(store.getSessionOutput('source', output.outputId)).toMatchObject({
      durability: 'reference_registered',
      sourceAvailability: 'unavailable',
    });
    expect(() => store.readSessionOutput('source', output.outputId)).toThrow('unavailable');
  });
});

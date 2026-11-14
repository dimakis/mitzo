import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { EventStore } from '../src/event-store.js';
import {
  begin,
  joinParticipant,
} from '../../../server/__tests__/fixtures/collaboration-navigation.js';

let store: EventStore, directory: string, database: string;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-navigation-')));
  database = join(directory, 'events.db');
  store = new EventStore(database);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

it('derives silent linked identity after first reply and restart without allocating again', () => {
  const group = begin(store);
  const linked = joinParticipant(store, group);
  const expected = [{ sessionId: 'peer', sourceConversationId: 'source', collaborationId: group }];
  expect(store.collaborationConversation.navigation()).toEqual(expected);
  store.append('peer', 'user_message', { text: 'First explicit reply request' });
  store.close();
  store = new EventStore(database);
  expect(store.collaborationConversation.navigation()).toEqual(expected);
  expect(store.collaborationConversation.getJoin(group, linked.joinId)).toEqual(linked);
  expect(store.listSessions()).toHaveLength(2);
});

it('keeps pending/allocated failures independent and restores removed or discontinuous members', () => {
  const group = begin(store);
  joinParticipant(store, group, 'failed', 'allocated');
  joinParticipant(store, group, 'never-allocated', 'pending');
  expect(store.collaborationConversation.navigation()).toEqual([]);
  joinParticipant(store, group);
  store.setSessionCollaboration(group, {
    expectedRevision: 2,
    participantSessionIds: ['source', 'failed'],
  });
  expect(store.collaborationConversation.navigation()).toEqual([]);
  store.setSessionCollaboration(group, {
    expectedRevision: 3,
    participantSessionIds: ['source', 'failed', 'peer'],
  });
  expect(store.collaborationConversation.navigation()).toEqual([]);
  expect(store.getSession('peer')).not.toBeNull();
  expect(store.collaborationConversation.view(group).joins).toHaveLength(2);
});

it('preserves legacy associations, multiple memberships and corrupt older origin receipts', () => {
  const group = begin(store);
  joinParticipant(store, group);
  store.upsertSession({
    sessionId: 'independent',
    conversationSource: 'mitzo',
    summary: 'Reviewer',
  });
  const legacy = randomUUID();
  store.setSessionCollaboration(legacy, {
    expectedRevision: 0,
    participantSessionIds: ['peer', 'independent'],
  });
  expect(store.collaborationConversation.navigation()).toEqual([]);
  const db = new Database(database);
  db.prepare('DELETE FROM session_collaboration_revisions WHERE collaboration_id=?').run(legacy);
  db.prepare('UPDATE collaboration_requests SET fingerprint=? WHERE collaboration_id=?').run(
    'old-corrupt',
    group,
  );
  db.close();
  expect(store.collaborationConversation.navigation()).toEqual([]);
  expect(store.listSessions()).toHaveLength(3);
});

it('keeps malformed historical joins independent and reports their retained identity safely', () => {
  const group = begin(store);
  joinParticipant(store, group);
  const db = new Database(database);
  db.prepare(
    `UPDATE collaboration_records SET body=json_remove(body,'$.settings') WHERE kind='join' AND json_extract(body,'$.state')='linked'`,
  ).run();
  db.close();
  store.close();
  const info = vi.fn();
  store = new EventStore(database, { info });
  expect(store.collaborationConversation.navigation()).toEqual([]);
  expect(info).toHaveBeenCalledWith('Participant navigation record unavailable', {
    stage: 'participant_navigation',
    code: 'participant_navigation_record_unavailable',
    collaborationId: group,
    sessionId: 'peer',
  });
  expect(store.getSession('peer')?.isHidden).toBe(false);
});

it('groups async and synchronous search before the result limit and retains the match owner', async () => {
  const group = begin(store);
  for (let i = 0; i < 4; i++) {
    joinParticipant(store, group, `peer-${i}`);
    store.append(`peer-${i}`, 'user_message', { text: 'Needle participant history' });
    store.upsertSession({
      sessionId: `peer-${i}`,
      updatedAt: 1000 + i,
      summary: 'Participant title',
    });
  }
  store.upsertSession({ sessionId: 'source', updatedAt: 10 });
  store.upsertSession({
    sessionId: 'standalone',
    conversationSource: 'mitzo',
    summary: 'Needle independent',
    numTurns: 1,
  });
  for (const results of [
    store.searchSessions('Needle', 2),
    await store.searchSessionsAsync('Needle', 2),
  ]) {
    expect(new Set(results.map((r) => r.sessionId))).toEqual(new Set(['source', 'standalone']));
    expect(results.find((r) => r.sessionId === 'source')).toMatchObject({
      summary: 'Original conversation',
      matchedSessionId: expect.stringMatching(/^peer-/),
      updatedAt: 1003,
    });
  }
  store.upsertSession({ sessionId: 'source', summary: null, updatedAt: 10 });
  expect(
    store.searchSessions('Needle', 2).find((r) => r.sessionId === 'source')?.summary,
  ).toBeNull();
});

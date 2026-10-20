import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { EventStore } from '../src/event-store.js';

let store: EventStore, directory: string, database: string;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-source-setup-')));
  database = join(directory, 'events.db');
  store = new EventStore(database);
  for (const sessionId of ['source', 'peer'])
    store.upsertSession({ sessionId, conversationSource: 'mitzo' });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

it('resolves only the original durable begin after membership grows and restart', () => {
  expect(store.collaborationConversation.sourceSetup('source')).toEqual({
    state: 'unstarted',
    sourceConversationId: 'source',
  });
  const group = randomUUID(),
    requestId = randomUUID();
  const original = store.collaborationConversation.begin(group, { requestId, sessionId: 'source' });
  store.setSessionCollaboration(group, {
    expectedRevision: 1,
    participantSessionIds: ['source', 'peer'],
  });
  const selected = {
    state: 'selected',
    sourceConversationId: 'source',
    collaboration: store.getSessionCollaboration(group),
  };
  expect(store.collaborationConversation.sourceSetup('source')).toEqual(selected);
  store.close();
  store = new EventStore(database);
  expect(store.collaborationConversation.sourceSetup('source')).toEqual(selected);
  expect(store.collaborationConversation.begin(group, { requestId, sessionId: 'source' })).toEqual(
    original,
  );
  expect(() =>
    store.collaborationConversation.begin(group, { requestId, sessionId: 'peer' }),
  ).toThrow('request_conflict');
  expect(store.collaborationConversation.sourceSetup('source')).toEqual(selected);
  store.hideSession('source');
  expect(() => store.collaborationConversation.sourceSetup('source')).toThrow(
    'unavailable_recipient',
  );
  // A retained relationship retry is not a new source-access or execution grant.
  expect(store.collaborationConversation.begin(group, { requestId, sessionId: 'source' })).toEqual(
    original,
  );
});

it('refuses legacy membership even when historical data later contains one member', () => {
  const group = randomUUID();
  store.setSessionCollaboration(group, {
    expectedRevision: 0,
    participantSessionIds: ['source', 'peer'],
  });
  const expected = {
    state: 'unavailable',
    sourceConversationId: 'source',
    reason: 'origin_unverified',
  };
  expect(store.collaborationConversation.sourceSetup('source')).toEqual(expected);
  const db = new Database(database);
  try {
    db.prepare('INSERT INTO session_collaboration_revisions VALUES (?,?,?,?)').run(
      group,
      2,
      JSON.stringify(['source']),
      Date.now(),
    );
  } finally {
    db.close();
  }
  expect(store.collaborationConversation.sourceSetup('source')).toEqual(expected);
});

it('refuses foreign-origin and multiple associations without choosing a row', () => {
  const foreign = randomUUID();
  store.collaborationConversation.begin(foreign, { requestId: randomUUID(), sessionId: 'peer' });
  store.setSessionCollaboration(foreign, {
    expectedRevision: 1,
    participantSessionIds: ['peer', 'source'],
  });
  expect(store.collaborationConversation.sourceSetup('source')).toEqual({
    state: 'unavailable',
    sourceConversationId: 'source',
    reason: 'foreign_origin',
  });
  store.setSessionCollaboration(randomUUID(), {
    expectedRevision: 0,
    participantSessionIds: ['peer', 'source'],
  });
  expect(store.collaborationConversation.sourceSetup('source')).toEqual({
    state: 'unavailable',
    sourceConversationId: 'source',
    reason: 'multiple_associations',
  });
});

it('does not infer a fresh origin from membership when its begin proof is corrupt', () => {
  const group = randomUUID();
  store.collaborationConversation.begin(group, { requestId: randomUUID(), sessionId: 'source' });
  const db = new Database(database);
  try {
    db.prepare('UPDATE collaboration_requests SET fingerprint=? WHERE collaboration_id=?').run(
      'corrupt',
      group,
    );
  } finally {
    db.close();
  }
  expect(store.collaborationConversation.sourceSetup('source')).toEqual({
    state: 'unavailable',
    sourceConversationId: 'source',
    reason: 'origin_unverified',
  });
});
it('does not bootstrap imported source history', () => {
  store.upsertSession({ sessionId: 'imported', conversationSource: 'external_import' });
  expect(() => store.collaborationConversation.sourceSetup('imported')).toThrow(
    'unavailable_recipient',
  );
  expect(store.listSessionCollaborations('imported').collaborations).toEqual([]);
});

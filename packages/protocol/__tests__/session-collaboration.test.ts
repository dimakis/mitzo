import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';
import type { SessionRuntimeBindingV2 } from '../src/session-runtime-binding.js';

let directory: string, path: string, store: EventStore, id: string;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-collaboration-')));
  path = join(directory, 'events.db');
  store = new EventStore(path);
  id = randomUUID();
  for (const sessionId of ['first', 'local', 'sandbox', 'other'])
    store.upsertSession({ sessionId, conversationSource: 'mitzo', summary: sessionId });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
const selection = (participantSessionIds: string[], expectedRevision = 0) => ({
  expectedRevision,
  participantSessionIds,
});

it('does not allocate a conversation, account or collaboration on read', () => {
  expect(store.getSessionCollaboration(id)).toBeNull();
  expect(store.listSessions()).toHaveLength(4);
});

it('persists links to existing bound sessions without rewriting their identities, workspaces or history', () => {
  const binding = {
    version: 2,
    account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'r1' },
    harness: { implementation: 'codex' },
    execution: { location: 'openshell', targetId: 'existing-target', targetRevision: 'r1' },
  } as const;
  store.createSessionWithRuntimeBinding(
    {
      sessionId: 'bound',
      accountBinding: { ...binding.account, accountLabel: 'Personal', model: 'fixture' },
      repositoryWorkspaceId: 'existing-checkout',
      cwd: '/unchanged',
    },
    binding,
  );
  store.append('bound', 'user_message', { messageId: 'old', text: 'Existing context' });
  const metadata = store.getSession('bound'),
    history = store.getSessionEvents('bound');
  const allocate = vi.spyOn(store, 'createSymposiumSession');
  const append = vi.spyOn(store, 'append');
  const result = store.setSessionCollaboration(id, selection(['sandbox', 'bound', 'first']));
  expect(result).toEqual({
    version: 1,
    collaborationId: id,
    revision: 1,
    participantSessionIds: ['bound', 'first', 'sandbox'],
  });
  expect(allocate).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
  expect(store.getSession('bound')).toEqual(metadata);
  expect(store.getSessionRuntimeBinding('bound')).toEqual(binding);
  expect(store.getSessionEvents('bound')).toEqual(history);
  expect(store.listSessions()).toHaveLength(5);
  store.close();
  store = new EventStore(path);
  expect(store.getSessionCollaboration(id)).toEqual(result);
});

it('has no parent-session lifetime and does not implicitly combine separate work or groups', () => {
  const other = randomUUID();
  store.setSessionCollaboration(id, selection(['first', 'local']));
  const second = store.setSessionCollaboration(other, selection(['first', 'local', 'sandbox']));
  store.setSessionCollaboration(id, selection(['local', 'sandbox'], 1));
  store.hideSession('first');
  expect(store.getSessionCollaboration(id)).toMatchObject({
    collaborationId: id,
    revision: 2,
    participantSessionIds: ['local', 'sandbox'],
  });
  expect(store.getSessionCollaboration(other)).toEqual(second);
  expect(store.listSessionOutputs('local')).toEqual([]);
});

it.each([
  ['openai-codex', 'codex', 'local'],
  ['openai-codex', 'codex', 'openshell'],
  ['openai', 'codex', 'openshell'],
  ['openai', 'responses', 'local'],
  ['anthropic-vertex', 'claude-sdk', 'local'],
  ['google-vertex', 'gemini', 'local'],
] as const)(
  'retains %s/%s/%s recorded identities without inferring runtime availability',
  (provider, implementation, location) => {
    const binding: SessionRuntimeBindingV2 = {
      version: 2,
      account: { accountId: 'existing-account', provider, profileRevision: 'r1' },
      harness: { implementation },
      execution: { location, targetId: 'recorded-target', targetRevision: 'r1' },
    };
    for (const sessionId of ['bound-one', 'bound-two'])
      store.createSessionWithRuntimeBinding(
        {
          sessionId,
          accountBinding: {
            ...binding.account,
            accountLabel: 'Existing account',
            model: 'fixture',
          },
          repositoryWorkspaceId: `${sessionId}-workspace`,
          cwd: `/fixture/${sessionId}`,
        },
        binding,
      );
    store.setSessionCollaboration(id, selection(['bound-one', 'bound-two']));
    for (const sessionId of ['bound-one', 'bound-two']) {
      expect(store.getSessionRuntimeBinding(sessionId)).toEqual(binding);
      expect(store.getSessionEvents(sessionId)).toEqual([]);
    }
  },
);

it('retries an exact last mutation without appending another revision', () => {
  const input = selection(['local', 'first']);
  const first = store.setSessionCollaboration(id, input);
  expect(store.setSessionCollaboration(id, input)).toEqual(first);
  const db = new Database(path);
  expect(db.prepare('SELECT count(*) AS n FROM session_collaboration_revisions').get()).toEqual({
    n: 1,
  });
  db.close();
});

it('prevents lost updates across independent connections, including future revisions', () => {
  const second = new EventStore(path);
  try {
    const first = store.setSessionCollaboration(id, selection(['first', 'local']));
    expect(() => second.setSessionCollaboration(id, selection(['first', 'sandbox']))).toThrow(
      'Collaboration changed',
    );
    expect(() => second.setSessionCollaboration(id, selection(['first', 'local'], 99))).toThrow(
      'Collaboration changed',
    );
    expect(second.getSessionCollaboration(id)).toEqual(first);
  } finally {
    second.close();
  }
});

it('can remove every participant without stopping, deleting or hiding the source sessions', () => {
  store.setSessionCollaboration(id, selection(['first', 'local']));
  expect(store.setSessionCollaboration(id, selection([], 1))).toMatchObject({
    revision: 2,
    participantSessionIds: [],
  });
  expect(store.getSession('local')).toMatchObject({ sessionId: 'local', isHidden: false });
  expect(store.getSessionEvents('local')).toEqual([]);
});

it.each(['missing', 'hidden', 'native', 'internal'])(
  'refuses %s participants without partially changing membership',
  (member) => {
    store.upsertSession({ sessionId: 'hidden', conversationSource: 'mitzo' });
    store.hideSession('hidden');
    store.upsertSession({ sessionId: 'native', conversationSource: 'mitzo' });
    const db = new Database(path);
    db.prepare(
      "UPDATE sessions SET session_type='symposium', symposium_config='{}' WHERE session_id='native'",
    ).run();
    db.close();
    store.registerInternalSdkExecution({
      sdkSessionId: 'internal',
      parentSessionId: 'first',
      operationId: 'op',
      purpose: 'web_search',
      cwd: '/fixture',
    });
    const original = store.setSessionCollaboration(id, selection(['first', 'local']));
    expect(() => store.setSessionCollaboration(id, selection(['local', member], 1))).toThrow(
      'Conversation not found',
    );
    expect(store.getSessionCollaboration(id)).toEqual(original);
  },
);

it.each([
  selection(['local']),
  selection(['local', 'local']),
  selection(['local', 'first'], -1),
  { ...selection(['local', 'first']), accountId: 'replacement' },
  { ...selection(['local', 'first']), workId: 'implicit-work' },
])('rejects invalid membership and implicit account/work reassociation', (input) => {
  expect(() => store.setSessionCollaboration(id, input)).toThrow();
  expect(store.getSessionCollaboration(id)).toBeNull();
});

it('retains an unavailable reference until explicitly removed', () => {
  store.setSessionCollaboration(id, selection(['first', 'local']));
  store.hideSession('first');
  expect(store.getSessionCollaboration(id)?.participantSessionIds).toEqual(['first', 'local']);
  expect(() => store.setSessionCollaboration(id, selection(['local'], 1))).not.toThrow();
});

it('recovers the exact last mutation after a participant becomes unavailable and the store restarts', () => {
  const input = selection(['first', 'local']);
  const accepted = store.setSessionCollaboration(id, input);
  store.hideSession('first');
  store.close();
  store = new EventStore(path);
  expect(store.setSessionCollaboration(id, input)).toEqual(accepted);
  expect(store.setSessionCollaboration(id, selection(['local', 'first'], 1))).toEqual(accepted);
  const db = new Database(path);
  expect(db.prepare('SELECT count(*) AS n FROM session_collaboration_revisions').get()).toEqual({
    n: 1,
  });
  db.close();
});

it('edits other membership while retaining an unavailable reference, but refuses to add it again', () => {
  store.setSessionCollaboration(id, selection(['first', 'local']));
  store.hideSession('first');
  expect(
    store.setSessionCollaboration(id, selection(['first', 'local', 'sandbox'], 1)),
  ).toMatchObject({
    revision: 2,
    participantSessionIds: ['first', 'local', 'sandbox'],
  });
  expect(store.setSessionCollaboration(id, selection(['first', 'sandbox'], 2))).toMatchObject({
    revision: 3,
    participantSessionIds: ['first', 'sandbox'],
  });
  const removed = store.setSessionCollaboration(id, selection(['sandbox'], 3));
  expect(() => store.setSessionCollaboration(id, selection(['first', 'sandbox'], 4))).toThrow(
    'Conversation not found',
  );
  expect(store.getSessionCollaboration(id)).toEqual(removed);
});

it('rediscovers membership from an existing session after restart without making it the group owner', () => {
  const secondId = randomUUID();
  store.setSessionCollaboration(id, selection(['first', 'local']));
  store.setSessionCollaboration(secondId, selection(['local', 'sandbox']));
  store.close();
  store = new EventStore(path);
  const groups = store.listSessionCollaborations('local');
  expect(groups.collaborations.map((group) => group.collaborationId)).toEqual(
    [id, secondId].sort(),
  );
  expect(groups.nextCursor).toBeNull();
  store.setSessionCollaboration(id, selection(['first'], 1));
  expect(
    store.listSessionCollaborations('local').collaborations.map((group) => group.collaborationId),
  ).toEqual([secondId]);
});

it('bounds discovery and resumes from a stable collaboration cursor', () => {
  for (let index = 0; index < 51; index++)
    store.setSessionCollaboration(randomUUID(), selection(['first', 'local']));
  const page = store.listSessionCollaborations('local');
  expect(page.collaborations).toHaveLength(50);
  expect(page.nextCursor).toBe(page.collaborations[49].collaborationId);
  const next = store.listSessionCollaborations('local', page.nextCursor!);
  expect(next.collaborations).toHaveLength(1);
  expect(next.nextCursor).toBeNull();
  expect(next.collaborations[0].collaborationId > page.nextCursor!).toBe(true);
});

it('fails closed on corrupt persisted membership instead of allocating a replacement', () => {
  store.setSessionCollaboration(id, selection(['first', 'local']));
  const db = new Database(path);
  db.prepare('UPDATE session_collaboration_revisions SET participant_session_ids=?').run('{broken');
  db.close();
  expect(() => store.getSessionCollaboration(id)).toThrow();
  expect(() => store.setSessionCollaboration(id, selection(['local', 'sandbox']))).toThrow();
});

it('includes collaboration revisions in the existing owner backup and change watermark', async () => {
  const before = store.backupWatermark();
  const group = store.setSessionCollaboration(id, selection(['first', 'local']));
  expect(store.backupWatermark()).not.toBe(before);
  const snapshotPath = join(directory, 'snapshot.db');
  await store.backupSnapshot(snapshotPath);
  const snapshot = new EventStore(snapshotPath);
  try {
    expect(snapshot.getSessionCollaboration(id)).toEqual(group);
    expect(snapshot.listSessionCollaborations('local').collaborations).toEqual([group]);
  } finally {
    snapshot.close();
  }
});

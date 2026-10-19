import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventStore } from '../src/event-store.js';

let store: EventStore, directory: string, path: string, group: string;
const settings = {
  binding: {
    version: 2,
    account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'r1' },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
  },
  selection: {
    version: 1,
    agent: { profileId: 'default-mitzo', revision: 1, kind: 'builtin' },
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
    model: 'offline-fixture',
    thinking: null,
  },
  repositoryWorkspaceId: 'reserved-workspace',
} as const;
function input(applicationInputSha256?: string) {
  return {
    operatorId: 'operator',
    ...(applicationInputSha256 === undefined ? {} : { applicationInputSha256 }),
    selection: {
      requestId: randomUUID(),
      expectedMembershipRevision: 1,
      sourceConversationId: 'source',
      boundary: { sequence: 1, messageId: 'question' },
      mode: 'conversation_so_far' as const,
      messageIds: [],
      artifacts: [],
      purpose: 'Review ordinary code',
      joiningBrief: 'Keep the edited brief.',
    },
    settings: [settings],
  };
}
function draft(request: ReturnType<typeof input>) {
  const { requestId, sourceConversationId, boundary, mode, purpose, joiningBrief } =
    request.selection;
  return {
    requestId,
    sourceConversationId,
    boundary,
    mode,
    purpose,
    joiningBrief,
    messages: [
      {
        conversationId: 'source',
        messageId: 'question',
        sequence: 1,
        author: 'operator',
        source: null,
        blocks: [{ blockId: 'text', content: 'Visible source', sha256: 'a'.repeat(64) }],
      },
    ],
    artifacts: [],
    capacity: { status: 'unverified', reason: 'Native counting is not installed.' },
    summary: null,
  };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'review-save-fence-'));
  path = join(directory, 'events.db');
  store = new EventStore(path);
  group = randomUUID();
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo' });
  store.collaborationConversation.begin(group, { requestId: randomUUID(), sessionId: 'source' });
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

it('observes the original private reservation through restart without writes or public replay', () => {
  const request = input('a'.repeat(64));
  const retained = store.collaborationConversation.reserveReviewCompilation(group, request);
  store.close();
  store = new EventStore(path);
  expect(
    store.collaborationConversation.getReviewCompilation(group, request.selection.requestId),
  ).toEqual(retained);
  expect(store.collaborationConversation.getReviewCompilation(group, randomUUID())).toBeNull();
  expect(() => store.collaborationConversation.getReviewCompilation(group, 'invalid')).toThrow();
  expect(() =>
    store.collaborationConversation.getReviewCompilation(randomUUID(), request.selection.requestId),
  ).toThrow('not_found');
  expect(store.collaborationConversation.view(group).cursor).toBe(0);
  expect(JSON.stringify(store.collaborationConversation.view(group))).not.toContain(
    'applicationInputSha256',
  );
});

it('fingerprints the normalized application input alongside the existing immutable reservation', () => {
  const request = input('a'.repeat(64));
  const retained = store.collaborationConversation.reserveReviewCompilation(group, request);
  expect(
    store.collaborationConversation.reserveReviewCompilation(group, {
      settings: request.settings,
      selection: { ...request.selection, boundary: { messageId: 'question', sequence: 1 } },
      applicationInputSha256: request.applicationInputSha256,
      operatorId: request.operatorId,
    }),
  ).toEqual(retained);
  expect(() =>
    store.collaborationConversation.reserveReviewCompilation(group, {
      ...request,
      applicationInputSha256: 'b'.repeat(64),
    }),
  ).toThrow('request_conflict');
  expect(() =>
    store.collaborationConversation.reserveReviewCompilation(group, {
      ...request,
      applicationInputSha256: 'not-a-digest',
    }),
  ).toThrow();
});

it('runs the current-source assertion under the write transaction immediately before saving', () => {
  const request = input();
  store.collaborationConversation.reserveReviewCompilation(group, request);
  const order: string[] = [];
  const original = store.collaborationConversation.saveSnapshot.bind(
    store.collaborationConversation,
  );
  vi.spyOn(store.collaborationConversation, 'saveSnapshot').mockImplementation((...args) => {
    order.push('save');
    return original(...args);
  });
  const competitor = new Database(path, { timeout: 0 });
  try {
    const snapshot = store.collaborationConversation.completeReviewCompilation(
      group,
      request.selection.requestId,
      draft(request),
      [],
      () => {
        order.push('assert');
        // Another actual SQLite writer cannot enter: the original owner's IMMEDIATE fence is held.
        expect(() => competitor.transaction(() => {}).immediate()).toThrow(/locked/i);
        expect(store.collaborationConversation.view(group).cursor).toBe(0);
      },
    );
    expect(order).toEqual(['assert', 'save']);
    expect(store.collaborationConversation.getSnapshot(group, snapshot.snapshotId)).toEqual(
      snapshot,
    );
    expect(store.collaborationConversation.view(group).cursor).toBe(1);
  } finally {
    competitor.close();
  }
});

it('rolls back a failed final assertion and retries the exact reserved identity after restart', () => {
  const request = input();
  const retained = store.collaborationConversation.reserveReviewCompilation(group, request);
  const save = vi.spyOn(store.collaborationConversation, 'saveSnapshot');
  expect(() =>
    store.collaborationConversation.completeReviewCompilation(
      group,
      request.selection.requestId,
      draft(request),
      [],
      () => {
        throw Error('Source changed');
      },
    ),
  ).toThrow('Source changed');
  expect(save).not.toHaveBeenCalled();
  expect(store.collaborationConversation.view(group).cursor).toBe(0);
  expect(
    store.collaborationConversation.getReviewCompilation(group, request.selection.requestId),
  ).toEqual(retained);
  const observer = new Database(path, { readonly: true });
  try {
    expect(
      observer
        .prepare(
          "SELECT count(*) AS n FROM collaboration_records WHERE kind IN ('snapshot','review-capacity-witnesses')",
        )
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    observer.close();
  }
  store.close();
  store = new EventStore(path);
  const snapshot = store.collaborationConversation.completeReviewCompilation(
    group,
    request.selection.requestId,
    draft(request),
    [],
    () => {},
  );
  expect(
    store.collaborationConversation.getReviewCompilation(group, request.selection.requestId),
  ).toEqual({ ...retained, snapshotId: snapshot.snapshotId });
  expect(store.listSessions()).toHaveLength(1);
  expect(store.getOrdinaryInitialCommandId('source')).toBeUndefined();
});

it('rejects an asynchronous final assertion before any snapshot or event writes', () => {
  const request = input();
  store.collaborationConversation.reserveReviewCompilation(group, request);
  expect(() =>
    store.collaborationConversation.completeReviewCompilation(
      group,
      request.selection.requestId,
      draft(request),
      [],
      async () => {},
    ),
  ).toThrow('snapshot_changed');
  expect(store.collaborationConversation.view(group).cursor).toBe(0);
});

it('validates the retained identity before invoking the final host assertion', () => {
  const request = input();
  store.collaborationConversation.reserveReviewCompilation(group, request);
  const assertion = vi.fn();
  expect(() =>
    store.collaborationConversation.completeReviewCompilation(
      group,
      request.selection.requestId,
      { ...draft(request), joiningBrief: 'Changed' },
      [],
      assertion,
    ),
  ).toThrow('snapshot_changed');
  expect(assertion).not.toHaveBeenCalled();
});

it('preserves legacy reservations and completed exact observational retries without renewing authority', () => {
  const request = input();
  const { applicationInputSha256: _applicationInputSha256, ...legacy } = request;
  store.collaborationConversation.reserveReviewCompilation(group, legacy);
  const snapshot = store.collaborationConversation.completeReviewCompilation(
    group,
    request.selection.requestId,
    draft(request),
  );
  const assertion = vi.fn(() => {
    throw Error('Current source unavailable');
  });
  expect(
    store.collaborationConversation.completeReviewCompilation(
      group,
      request.selection.requestId,
      draft(request),
      [],
      assertion,
    ),
  ).toEqual(snapshot);
  expect(assertion).not.toHaveBeenCalled();
  expect(snapshot.capacity.status).toBe('unverified');
  expect(store.collaborationConversation.view(group).cursor).toBe(1);
  const publicBytes = JSON.stringify({
    snapshot,
    view: store.collaborationConversation.view(group),
    events: store.collaborationConversation.events(group, 0),
  });
  expect(publicBytes).not.toContain('applicationInputSha256');
  expect(publicBytes).not.toContain('operatorId');
});

import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import Database from 'better-sqlite3';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'session-learning-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const store = new EventStore(path);
  store.upsertSession({ sessionId: 'chat', cwd: root, conversationSource: 'mitzo' });
  return { store, path };
}
function message(store: EventStore, id: string) {
  return {
    messageId: id,
    eventSeq: store.append('chat', 'user_message', { messageId: id, text: 'Public statement' }),
  };
}
function candidate(source: ReturnType<typeof message>) {
  return {
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    kind: 'decision',
    attribution: 'user_statement',
    text: 'Use the existing ledger.',
    rationale: 'Preserves source lineage.',
    sources: [source],
  };
}

it('defaults to Auto and retains controller policy through reopen and engine metadata changes', () => {
  const { path, store: initial } = fixture();
  let store = initial;
  expect(store.getSessionLearningPolicy('chat')).toMatchObject({ mode: 'auto', revision: 0 });
  const selected = store.setSessionLearningMode('chat', 'deep', 0);
  store.upsertSession({
    sessionId: 'chat',
    selectedModel: 'fake-new-engine',
    reasoningEffort: 'low',
  });
  store.close();
  store = new EventStore(path);
  try {
    expect(store.getSessionLearningPolicy('chat')).toEqual(selected);
    expect(store.getSession('chat')?.learningPolicy).toEqual(selected);
    expect(store.captureReconnectState('chat', 0).session?.learningPolicy).toEqual(selected);
    expect(() => store.setSessionLearningMode('chat', 'off', 0)).toThrow(/revision/);
  } finally {
    store.close();
  }
});

it('revokes queued evidence and excluded history permanently; Deep requests eligible earlier history only', () => {
  const { store } = fixture();
  try {
    const before = message(store, 'before');
    const receipt = store.captureMemoryCandidate('chat', candidate(before));
    expect(store.memoryCandidateEligibility('chat', receipt.requestId)).toMatchObject({
      eligible: true,
    });
    store.setSessionLearningMode('chat', 'off', 0);
    expect(store.memoryCandidateEligibility('chat', receipt.requestId)).toMatchObject({
      eligible: false,
      reason: 'learning_off',
    });
    const excluded = message(store, 'excluded');
    expect(() =>
      store.captureMemoryCandidate('chat', {
        ...candidate(excluded),
        requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
    ).toThrow(/learning_off/);
    const deep = store.setSessionLearningMode('chat', 'deep', 1);
    expect(deep.historyRequest).toMatchObject({
      status: 'pending_worker',
      afterSeq: expect.any(Number),
    });
    expect(deep.historyRequest!.afterSeq).toBeGreaterThanOrEqual(excluded.eventSeq);
    expect(store.memoryCandidateEligibility('chat', receipt.requestId)).toMatchObject({
      eligible: false,
      reason: 'source_excluded',
    });
    expect(() => store.captureMemoryCandidate('chat', candidate(excluded))).toThrow(
      /source_excluded/,
    );
    const eligible = message(store, 'later');
    expect(
      store.captureMemoryCandidate('chat', {
        ...candidate(eligible),
        requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }).status,
    ).toBe('stored');
  } finally {
    store.close();
  }
});

it('durably acknowledges exactly one candidate and recovers a lost response without duplicates', () => {
  const { path, store: initial } = fixture();
  let store = initial;
  const input = candidate(message(store, 'source'));
  const receipt = store.captureMemoryCandidate('chat', input);
  store.close();
  store = new EventStore(path);
  try {
    expect(store.captureMemoryCandidate('chat', input)).toEqual(receipt);
    expect(
      store.getSessionEvents('chat').filter((event) => event.type === 'memory_candidate'),
    ).toHaveLength(1);
    expect(() => store.captureMemoryCandidate('chat', { ...input, text: 'Changed retry' })).toThrow(
      /request_conflict/,
    );
    const event = store.getSessionEvents('chat').find((e) => e.seq === receipt.eventSeq)!;
    expect(event.payload).toMatchObject({
      status: 'provisional',
      source: { sessionId: 'chat', scope: 'unclassified' },
      sources: input.sources,
    });
    expect(() => store.append('chat', 'memory_candidate', input)).toThrow(/captureMemoryCandidate/);
  } finally {
    store.close();
  }
});

it('accepts only exact public completed conversation messages and rechecks current source identity', () => {
  const { store } = fixture();
  try {
    const source = message(store, 'public');
    const hidden = store.append('chat', 'block_delta', {
      messageId: 'hidden',
      blockType: 'thinking',
      delta: 'private',
    });
    expect(() =>
      store.captureMemoryCandidate('chat', candidate({ messageId: 'hidden', eventSeq: hidden })),
    ).toThrow(/source_ineligible/);
    expect(() =>
      store.captureMemoryCandidate('chat', candidate({ ...source, messageId: 'wrong' })),
    ).toThrow(/source_ineligible/);
    expect(store.listSessionLearningSources('chat')).toEqual([expect.objectContaining(source)]);
    const receipt = store.captureMemoryCandidate('chat', candidate(source));
    store.upsertSession({ sessionId: 'chat', cwd: '/different-workspace' });
    expect(store.memoryCandidateEligibility('chat', receipt.requestId)).toMatchObject({
      eligible: false,
      reason: 'source_changed',
    });
    expect(() => store.captureMemoryCandidate('chat', candidate(source))).toThrow(/source_changed/);
  } finally {
    store.close();
  }
});

it('rolls back event and receipt together when capture is interrupted before commit', () => {
  const { store, path } = fixture();
  try {
    const input = candidate(message(store, 'retry'));
    const db = new Database(path);
    db.exec(
      "CREATE TRIGGER interrupt_capture BEFORE INSERT ON session_learning_captures BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
    );
    expect(() => store.captureMemoryCandidate('chat', input)).toThrow(/interrupted/);
    expect(
      store.getSessionEvents('chat').filter((e) => e.type === 'memory_candidate'),
    ).toHaveLength(0);
    db.exec('DROP TRIGGER interrupt_capture');
    db.close();
    expect(store.captureMemoryCandidate('chat', input).status).toBe('stored');
  } finally {
    store.close();
  }
});

it('does not re-enroll an assistant reply whose text crossed an Off boundary', () => {
  const { store } = fixture();
  try {
    store.append('chat', 'message_start', { messageId: 'reply' });
    store.append('chat', 'block_delta', {
      messageId: 'reply',
      blockType: 'text',
      delta: 'Eligible start',
    });
    store.setSessionLearningMode('chat', 'off', 0);
    store.append('chat', 'block_delta', {
      messageId: 'reply',
      blockType: 'text',
      delta: 'Excluded text',
    });
    store.setSessionLearningMode('chat', 'auto', 1);
    const eventSeq = store.append('chat', 'message_end', { messageId: 'reply' });
    expect(() =>
      store.captureMemoryCandidate('chat', candidate({ messageId: 'reply', eventSeq })),
    ).toThrow(/source_excluded/);
    expect(store.listSessionLearningSources('chat')).toHaveLength(0);
  } finally {
    store.close();
  }
});

it('never re-enrolls old evidence by changing a workspace away and back', () => {
  const { store } = fixture();
  try {
    const source = message(store, 'old-workspace');
    const receipt = store.captureMemoryCandidate('chat', candidate(source));
    const cwd = store.getSession('chat')!.cwd;
    store.upsertSession({ sessionId: 'chat', cwd: '/another-workspace' });
    store.upsertSession({ sessionId: 'chat', cwd });
    expect(store.memoryCandidateEligibility('chat', receipt.requestId)).toMatchObject({
      eligible: false,
    });
    expect(() =>
      store.captureMemoryCandidate('chat', {
        ...candidate(source),
        requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      }),
    ).toThrow(/source_excluded/);
  } finally {
    store.close();
  }
});

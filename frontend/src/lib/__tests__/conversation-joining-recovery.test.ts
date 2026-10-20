// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { markAuthLost, restoreCookieAuthentication } from '../api-fetch';
import {
  conversationJoiningRecovery,
  joiningReviewFence,
  type ConversationJoiningRecoveryRecord,
} from '../conversation-joining-recovery';
import {
  joiningReviewFixture,
  joiningSetupFixture,
} from '../../preview/conversation-joining-fixture';
import { retainedPin } from './conversation-joining-retained-fixture';

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'login-one' })),
  );
  await restoreCookieAuthentication();
});
afterEach(() => vi.unstubAllGlobals());

function record(): ConversationJoiningRecoveryRecord {
  return {
    version: 1,
    sourceConversationId: 'source-chat',
    reviewRequest: {
      requestId: '00000000-0000-4000-8000-000000000020',
      setup: joiningSetupFixture(),
    },
    acceptedReview: joiningReviewFence(joiningReviewFixture()),
  };
}

it('retains both artifact kinds under identical IDs, revisions and hashes across reload', () => {
  const storage = conversationJoiningRecovery('source-chat');
  const input = record();
  input.reviewRequest.setup.artifacts.push(retainedPin());
  storage.save(input, null);
  expect(conversationJoiningRecovery('source-chat').read()).toEqual(input);
  expect(storage.read()!.reviewRequest.setup.artifacts).toHaveLength(2);
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).not.toContain('original-author-chat');
});

it('rejects an unknown retained artifact kind without replacing the original recovery request', () => {
  const storage = conversationJoiningRecovery('source-chat');
  const original = storage.save(record(), null);
  const invalid = structuredClone(original);
  invalid.reviewRequest.setup.artifacts = [{ ...retainedPin(), kind: 'other' } as never];
  expect(() => storage.save(invalid, original)).toThrow();
  expect(storage.read()).toEqual(original);
});

it('stores public correlation and source fences without retaining reviewed source or native witnesses', () => {
  const storage = conversationJoiningRecovery('source-chat');
  const retained = storage.save(record(), null);
  expect(storage.read()).toEqual(retained);
  const raw = sessionStorage.getItem(sessionStorage.key(0)!)!;
  const snapshot = joiningReviewFixture().snapshot;
  expect(raw).not.toContain(snapshot.messages[0].blocks[0].content);
  expect(raw).not.toContain(snapshot.artifacts[0].contentBase64!);
  expect(raw).not.toMatch(/nativeWitness|preparationId|providerResponseId|threadId|accessToken/);
  expect(raw).not.toContain('mitzo_auth_token');
  expect(JSON.parse(raw).acceptedReview.snapshot).toEqual({
    snapshotId: snapshot.snapshotId,
    sha256: snapshot.sha256,
  });
  expect(JSON.parse(raw).acceptedReview.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
});

it('refuses unknown private metadata instead of persisting a widened replay object', () => {
  const storage = conversationJoiningRecovery('source-chat');
  expect(() =>
    storage.save({ ...record(), nativeWitness: { preparationId: 'private' } }, null),
  ).toThrow();
  expect(sessionStorage.length).toBe(0);
});

it('refuses a stale writer after a newer exact review request has been retained', () => {
  const storage = conversationJoiningRecovery('source-chat');
  const first = storage.save(record(), null);
  const next = storage.save(
    {
      ...record(),
      reviewRequest: {
        ...record().reviewRequest,
        requestId: '00000000-0000-4000-8000-000000000021',
      },
    },
    first,
  );
  expect(() => storage.save(first, first)).toThrow();
  expect(storage.read()).toEqual(next);
});

it('isolates source conversations and refuses a journal after the verified login changes', async () => {
  const storage = conversationJoiningRecovery('source-chat');
  storage.save(record(), null);
  expect(conversationJoiningRecovery('other-chat').read()).toBeNull();
  markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'other-login' })),
  );
  await restoreCookieAuthentication();
  expect(() => storage.read()).toThrow();
  expect(conversationJoiningRecovery('source-chat').read()).toBeNull();
});

it('fails closed on malformed storage without deleting it or permitting a replacement', () => {
  const storage = conversationJoiningRecovery('source-chat');
  storage.save(record(), null);
  const key = sessionStorage.key(0)!;
  sessionStorage.setItem(key, '{broken');
  expect(() => storage.read()).toThrow();
  expect(() => storage.save(record(), null)).toThrow();
  expect(sessionStorage.getItem(key)).toBe('{broken');
});

it('isolates the configured application server even for matching session and source IDs', () => {
  const original = import.meta.env.VITE_API_BASE_URL;
  const storage = conversationJoiningRecovery('source-chat');
  storage.save(record(), null);
  try {
    import.meta.env.VITE_API_BASE_URL = 'https://other-offline-app.invalid';
    expect(() => storage.read()).toThrow();
    expect(conversationJoiningRecovery('source-chat').read()).toBeNull();
  } finally {
    import.meta.env.VITE_API_BASE_URL = original;
  }
  expect(storage.read()).toEqual(record());
});

it('requires a fresh authenticated server check before hydrating retained state after a module reload', async () => {
  const retained = conversationJoiningRecovery('source-chat').save(record(), null);
  vi.resetModules();
  const freshAuth = await import('../api-fetch');
  const freshRecovery = await import('../conversation-joining-recovery');
  expect(freshAuth.currentVerifiedAuthSessionId()).toBeUndefined();
  expect(() => freshRecovery.conversationJoiningRecovery('source-chat')).toThrow();
  expect(sessionStorage.length).toBe(1);
  expect(await freshAuth.restoreCookieAuthentication()).toBe(true);
  expect(freshRecovery.conversationJoiningRecovery('source-chat').read()).toEqual(retained);
});

// @vitest-environment node
import { randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { JSDOM } from 'jsdom';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MitzoApiClient } from '@mitzo/client';
import { CollaborationApplicationReviewInputSchema } from '@mitzo/protocol';
import { authMiddleware, operatorAuthMiddleware, COOKIE_NAME } from '../../server/auth.js';
import { createSessionCollaborationRouter } from '../../server/session-collaboration-router.js';
import { createSessionMessagesHandler } from '../../server/session-messages-route.js';
import {
  fixture,
  cleanups,
  cleanupApplicationReviewFixtures,
} from '../../server/__tests__/fixtures/collaboration-application-review.js';
import { bindAgentLibraryTransport } from '../../server/agent-library-transport.js';
import {
  claimTransportConnection,
  releaseTransportConnection,
} from '../../server/transport-auth-ownership.js';
import { useConversationJoiningReview } from '../../frontend/src/hooks/useConversationJoiningReview';
import { restoreCookieAuthentication } from '../../frontend/src/lib/api-fetch';
import { conversationJoiningRecovery } from '../../frontend/src/lib/conversation-joining-recovery';
import type {
  ApplicationConversationJoiningOwner,
  ConversationAgentSetup,
} from '../../frontend/src/lib/conversation-joining-review';

// Hoisted in each consumer before the extracted genuine fixture loads server owners.
vi.mock('../../server/mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
let dom: JSDOM;
afterEach(async () => {
  cleanup();
  dom?.window.close();
  await cleanupApplicationReviewFixtures();
});

async function mounted() {
  const f = await fixture();
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  for (const key of [
    'window',
    'document',
    'localStorage',
    'sessionStorage',
    'navigator',
    'HTMLElement',
    'Node',
    'MutationObserver',
    'CustomEvent',
    'Event',
    'StorageEvent',
  ] as const)
    vi.stubGlobal(key, dom.window[key]);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', authMiddleware);
  app.get('/api/auth/check', (_req, res) =>
    res.json({ ok: true, authSessionId: res.locals.authSession.id }),
  );
  const forbiddenRestore = vi.fn(async () => {
    throw Error('Legacy restore must not run');
  });
  app.get(
    '/api/sessions/:id/messages',
    createSessionMessagesHandler({
      getMessages: forbiddenRestore,
      getSessionTranscript: forbiddenRestore,
      getReconnectTranscript: forbiddenRestore,
      getDurableSessionTranscript: (id) => f.store.getDurableSessionTranscript(id),
    }),
  );
  app.use(
    '/api/session-collaborations',
    operatorAuthMiddleware,
    createSessionCollaborationRouter({
      store: f.store,
      review: () => f.owner,
    }),
  );
  let lose = false;
  const transport = vi.fn(async (url: string, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const call = init?.method === 'POST' ? request(app).post(url) : request(app).get(url);
    call.set('Cookie', `${COOKIE_NAME}=${f.token}`);
    for (const [key, value] of new Headers(init?.headers)) call.set(key, value);
    if (init?.body) call.send(init.body as string);
    const abort = () => call.abort();
    init?.signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await call;
      if (lose && url.endsWith('/reviews')) {
        expect(result.status).toBe(200);
        lose = false;
        throw Error('Committed review response lost');
      }
      return new Response(JSON.stringify(result.body), { status: result.status });
    } finally {
      init?.signal?.removeEventListener('abort', abort);
    }
  });
  vi.stubGlobal('fetch', transport);
  await restoreCookieAuthentication();
  const api = new MitzoApiClient(transport);
  let connectionId = f.connectionId;
  const setup: ConversationAgentSetup = {
    name: 'Reviewer',
    purpose: f.input.selection.purpose,
    context: 'conversation_so_far',
    messageIds: [],
    artifacts: [],
    runOn: 'local',
    selection: { accountId: 'personal', model: 'fixture-model', reasoningEffort: 'low' },
    agent: f.input.target.agent,
  };
  const port: ApplicationConversationJoiningOwner = {
    kind: 'application',
    collaborationId: f.group,
    sourceConversationId: 'source',
    captureReview: vi.fn<ApplicationConversationJoiningOwner['captureReview']>(
      async (input, signal) => {
        const pending = conversationJoiningRecovery('source').read();
        expect(pending?.version === 2 ? pending.application.state : null).toBe('capture_pending');
        const transcript = await api.getDurableSessionTranscript('source', signal);
        const view = await api.collaborations.view(f.group, signal);
        return CollaborationApplicationReviewInputSchema.parse({
          selection: {
            requestId: input.requestId,
            expectedMembershipRevision: view.membershipRevision,
            sourceConversationId: transcript.sourceConversationId,
            boundary: transcript.boundary,
            mode: input.setup.context,
            messageIds: input.setup.messageIds,
            artifacts: input.setup.artifacts,
            purpose: input.setup.purpose.trim(),
            joiningBrief: input.joiningBrief ?? 'Original brief',
          },
          target: structuredClone(f.input.target),
          ...(input.previousSnapshot ? { previousSnapshot: input.previousSnapshot } : {}),
        });
      },
    ),
    review: vi.fn<ApplicationConversationJoiningOwner['review']>(async (input, signal) => {
      const saved = conversationJoiningRecovery('source').read();
      expect(saved?.version).toBe(2);
      expect(saved?.version === 2 ? saved.application : null).toEqual({
        state: 'captured',
        collaborationId: f.group,
        input,
      });
      return api.collaborations.review(f.group, connectionId, input, signal);
    }),
    confirm: vi.fn<ApplicationConversationJoiningOwner['confirm']>((input) =>
      api.collaborations.prepareJoin(f.group, input),
    ),
    recover: vi.fn<ApplicationConversationJoiningOwner['recover']>((id, signal) =>
      api.collaborations.recoverJoin(f.group, id, signal),
    ),
  };
  return {
    f,
    api,
    setup,
    port,
    transport,
    forbiddenRestore,
    loseResponse: () => {
      lose = true;
    },
    reconnect() {
      releaseTransportConnection(connectionId, f.auth.id);
      connectionId = randomUUID();
      const renewed = connectionId;
      claimTransportConnection(renewed, f.auth.id);
      const unbind = bindAgentLibraryTransport(renewed, f.auth);
      cleanups.push(() => {
        unbind();
        releaseTransportConnection(renewed, f.auth.id);
      });
    },
  };
}

it('control: the real authenticated client and application owner compile only an unverified observational review', async () => {
  const h = await mounted();
  const result = await h.api.collaborations.review(h.f.group, h.f.connectionId, h.f.input);
  expect(result.snapshot.capacity.status).toBe('unverified');
  expect(result.snapshot.messages[0].blocks[0].content).toBe('Visible source');
  expect(h.f.store.listSessions()).toHaveLength(1);
  expect(h.f.store.collaborationConversation.view(h.f.group).joins).toEqual([]);
  expect(h.f.workspaces.get(h.f.input.target.repositoryWorkspaceId).state).toBe('ready');
});

it.each([false, true])(
  'retains the actual normalized application review across committed response loss and reload (edited=%s)',
  async (edited) => {
    const h = await mounted();
    const first = renderHook(() => useConversationJoiningReview(h.port));
    if (edited) {
      await act(() => first.result.current.prepare(h.setup));
      expect(first.result.current.review?.snapshot.capacity.status).toBe('unverified');
    }
    h.loseResponse();
    await act(() =>
      edited
        ? first.result.current.editBrief('Exact edited brief.\nKeep ordering.')
        : first.result.current.prepare(h.setup),
    );
    expect(first.result.current.error).toBeTruthy();
    const original = structuredClone(vi.mocked(h.port.review).mock.calls.at(-1)![0]);
    const stored = h.f.store.collaborationConversation.getReviewCompilation(
      h.f.group,
      original.selection.requestId,
    )!;
    expect(stored.snapshotId).toBeTruthy();
    const capturedReads = vi.mocked(h.port.captureReview).mock.calls.length;
    first.unmount();
    h.reconnect();
    h.f.store.append('source', 'user_message', { messageId: 'later', text: 'Source advanced' });
    h.f.store.upsertSession({ sessionId: 'sibling', conversationSource: 'mitzo' });
    h.f.store.setSessionCollaboration(h.f.group, {
      expectedRevision: 1,
      participantSessionIds: ['source', 'sibling'],
    });
    const reopened = renderHook(() => useConversationJoiningReview({ ...h.port }));
    await act(() => reopened.result.current.retryReview());
    expect(vi.mocked(h.port.captureReview)).toHaveBeenCalledTimes(capturedReads);
    expect(vi.mocked(h.port.review).mock.calls.at(-1)![0]).toEqual(original);
    expect(reopened.result.current.review?.snapshot.snapshotId).toBe(stored.snapshotId);
    expect(reopened.result.current.review?.snapshot.sha256).toBe(
      h.f.store.collaborationConversation.getSnapshot(h.f.group, stored.snapshotId!).sha256,
    );
    expect(reopened.result.current.review?.snapshot.capacity.status).toBe('unverified');
    expect(reopened.result.current.canConfirm).toBe(false);
    expect(reopened.result.current.error).toBeNull();
    expect(reopened.result.current.brief).toBe(
      edited ? 'Exact edited brief.\nKeep ordering.' : 'Original brief',
    );
    const posts = h.transport.mock.calls.filter(([url]) => url.endsWith('/reviews')).slice(-2);
    expect(posts[0][0]).toBe(posts[1][0]);
    const { clientId: originalClient, ...originalIntent } = JSON.parse(posts[0][1]!.body as string);
    const { clientId: renewedClient, ...renewedIntent } = JSON.parse(posts[1][1]!.body as string);
    expect(originalClient).not.toBe(renewedClient);
    expect(renewedIntent).toEqual(originalIntent);
    expect(h.port.confirm).not.toHaveBeenCalled();
    expect(h.port.recover).not.toHaveBeenCalled();
    expect(h.forbiddenRestore).not.toHaveBeenCalled();
    expect(h.f.store.listSessions()).toHaveLength(2);
    expect(h.f.workspaces.get(h.f.input.target.repositoryWorkspaceId).state).toBe('ready');
    expect(h.f.store.collaborationConversation.view(h.f.group).joins).toEqual([]);
    const serialized = JSON.stringify(conversationJoiningRecovery('source').read());
    expect(serialized).not.toMatch(
      /PRIVATE|credential|clientId|nativeWitness|assessments|Visible source|Source advanced/,
    );
  },
);

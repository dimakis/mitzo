import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { CollaborationApiClient } from '@mitzo/client';
import {
  authMiddleware,
  authenticateToken,
  COOKIE_NAME,
  login,
  revokeAuthSession,
} from '../auth.js';
import { createSessionCollaborationRouter } from '../session-collaboration-router.js';
import type { OrdinaryCollaborationJoiningAuthority } from '../collaboration-joining-owner.js';
import { createJoiningFixture, cleanupJoiningFixtures } from './fixtures/collaboration-joining.js';

afterEach(cleanupJoiningFixtures);

// Real client/router/interactive authentication/SQLite/joining/workspace owners.
// Only external workspace access/runtime capacity use the existing offline fixture.
async function fixture() {
  const f = await createJoiningFixture();
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  const auth = (await authenticateToken(token))!;
  const cookie = `${COOKIE_NAME}=${token}`;
  let afterAuthentication: (() => void) | undefined;
  const mount = (enabled = true) => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(authMiddleware);
    app.use((_req, _res, next) => {
      afterAuthentication?.();
      next();
    });
    app.use(
      '/api/session-collaborations',
      createSessionCollaborationRouter({
        store: f.store,
        ...(enabled ? { joining: f.owner() } : {}),
      }),
    );
    return app;
  };
  let app = mount();
  let loseNextResponse = false;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const call = init?.method === 'POST' ? request(app).post(url) : request(app).get(url);
    call.set('Cookie', cookie);
    for (const [key, value] of new Headers(init?.headers)) call.set(key, value);
    if (init?.body) call.send(init.body as string);
    const abort = () => call.abort();
    init?.signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await call;
      if (loseNextResponse) {
        loseNextResponse = false;
        throw new TypeError('Lost response after server commit');
      }
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'Cache-Control': result.headers['cache-control'] ?? '' },
      });
    } catch (error) {
      if (init?.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
      throw error;
    } finally {
      init?.signal?.removeEventListener('abort', abort);
    }
  });
  const api = new CollaborationApiClient(fetch);
  return {
    f,
    api,
    fetch,
    cookie,
    auth,
    get app() {
      return app;
    },
    remount(enabled = true) {
      app = mount(enabled);
    },
    loseResponse() {
      loseNextResponse = true;
    },
    afterAuthentication(callback: () => void) {
      afterAuthentication = callback;
    },
  };
}

async function allocated() {
  const h = await fixture();
  h.f.authority.authorizeJoin
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      h.f.store.upsertSession({ sessionId: 'other', conversationSource: 'mitzo' });
      h.f.store.setSessionCollaboration(h.f.group, {
        expectedRevision: 1,
        participantSessionIds: ['source', 'other'],
      });
    });
  await expect(h.api.prepareJoin(h.f.group, h.f.input)).rejects.toMatchObject({
    status: 409,
    code: 'conflict',
  });
  const join = h.f.store.collaborationConversation.view(h.f.group).joins[0];
  expect(join.state).toBe('allocated');
  const approval = {
    requestId: randomUUID(),
    expectedMembershipRevision: 2,
    snapshot: structuredClone(join.snapshot),
  };
  return Object.assign(h, { join, approval });
}

it('connects the typed client to authenticated real-owner explicit reconciliation without another allocation or command', async () => {
  const h = await allocated();
  const signal = new AbortController().signal;
  await expect(h.api.recoverJoin(h.f.group, h.join.joinId, signal)).rejects.toMatchObject({
    status: 409,
    code: 'conflict',
  });
  expect(h.fetch.mock.calls.at(-1)?.[1]).toMatchObject({
    credentials: 'include',
    signal,
    method: 'POST',
    body: '{}',
  });
  const joined = await h.api.reconcileJoin(h.f.group, h.join.joinId, h.approval, signal);
  expect(joined).toEqual({ ...h.join, state: 'linked', linkedFromRevision: 2 });
  expect(h.f.authority.authorizeReconciliation).toHaveBeenCalledWith(
    expect.objectContaining({ operatorId: h.auth.id, approval: h.approval, join: h.join }),
    expect.any(AbortSignal),
  );
  expect(h.f.store.listSessions()).toHaveLength(3);
  expect(h.f.store.getOrdinaryInitialCommandId(joined.sessionId!)).toBeUndefined();
  expect(h.f.store.getSessionEvents(joined.sessionId!)).toEqual([]);
  expect(h.fetch).toHaveBeenCalledTimes(3);
});

it('retains a lost committed response and retries exactly after restart, first command and further membership changes', async () => {
  const h = await allocated();
  h.loseResponse();
  await expect(h.api.reconcileJoin(h.f.group, h.join.joinId, h.approval)).rejects.toThrow(
    'Lost response after server commit',
  );
  expect(h.fetch).toHaveBeenCalledTimes(2);
  const joined = h.f.store.collaborationConversation.getJoin(h.f.group, h.join.joinId)!;
  expect(joined.state).toBe('linked');
  const session = h.f.store.getSession(joined.sessionId!)!;
  h.f.store.admitPreparedOrdinaryCommand(
    joined.allocationOperationId,
    {
      sessionId: session.sessionId,
      repositoryWorkspaceId: session.repositoryWorkspaceId,
      cwd: session.cwd,
      accountBinding: session.accountBinding,
      agentProfile: session.agentProfile,
      selectedModel: session.selectedModel,
      reasoningEffort: session.reasoningEffort,
      mode: session.mode,
    },
    joined.settings.binding,
    {
      clientMsgId: 'explicit-first',
      requestFingerprint: 'offline-command',
      selection: joined.settings.selection,
      payload: { text: 'Explicit offline command' },
    },
  );
  h.f.store.setSessionCollaboration(h.f.group, {
    expectedRevision: 3,
    participantSessionIds: ['source'],
  });
  h.f.reopen();
  h.remount();
  const before = h.f.store.collaborationConversation.view(h.f.group);
  expect(await h.api.reconcileJoin(h.f.group, h.join.joinId, h.approval)).toEqual(joined);
  expect(h.fetch.mock.calls[1]).toEqual(h.fetch.mock.calls[2]);
  expect(h.f.store.collaborationConversation.view(h.f.group)).toEqual(before);
  expect(
    h.f.store.getOrdinarySessionPreparation(joined.allocationOperationId)?.firstCommandId,
  ).toBe('explicit-first');
  expect(h.f.authority.authorizeReconciliation).toHaveBeenCalledTimes(2);
  await expect(
    h.api.reconcileJoin(h.f.group, h.join.joinId, { ...h.approval, requestId: randomUUID() }),
  ).rejects.toMatchObject({ status: 422, code: 'invalid_transition' });
});

it('strictly validates route/body, origin and authentication before authority or mutation', async () => {
  const h = await allocated();
  const path = `/api/session-collaborations/${h.f.group}/joins/${h.join.joinId}/reconcile`;
  const before = h.f.store.collaborationConversation.view(h.f.group);
  for (const body of [
    {},
    { ...h.approval, operatorId: 'spoofed' },
    { ...h.approval, settings: h.join.settings },
    { ...h.approval, sessionId: 'replacement' },
    { ...h.approval, expectedMembershipRevision: -1 },
  ]) {
    expect((await request(h.app).post(path).set('Cookie', h.cookie).send(body)).status).toBe(400);
  }
  expect(
    (
      await request(h.app)
        .post(path.replace(h.join.joinId, 'invalid'))
        .set('Cookie', h.cookie)
        .send(h.approval)
    ).status,
  ).toBe(400);
  expect(
    (
      await request(h.app)
        .post(path)
        .set('Cookie', h.cookie)
        .set('Origin', 'https://other.invalid')
        .send(h.approval)
    ).status,
  ).toBe(403);
  expect(
    (
      await request(h.app)
        .post(path)
        .set('Cookie', h.cookie)
        .set('Content-Type', 'text/plain')
        .send('text')
    ).status,
  ).toBe(415);
  expect((await request(h.app).post(path).send(h.approval)).status).toBe(401);
  expect(h.f.authority.authorizeReconciliation).not.toHaveBeenCalled();
  expect(h.f.store.collaborationConversation.view(h.f.group)).toEqual(before);
});

it('projects stale membership as409 with allocation retained and private authority errors as sanitized503', async () => {
  const h = await allocated();
  const before = h.f.store.collaborationConversation.view(h.f.group);
  await expect(
    h.api.reconcileJoin(h.f.group, h.join.joinId, { ...h.approval, expectedMembershipRevision: 1 }),
  ).rejects.toMatchObject({ status: 409, code: 'conflict' });
  expect(h.f.authority.authorizeReconciliation).not.toHaveBeenCalled();
  h.f.authority.authorizeReconciliation.mockRejectedValueOnce(
    new Error('private-provider-native-operation-secret'),
  );
  await expect(h.api.reconcileJoin(h.f.group, h.join.joinId, h.approval)).rejects.toMatchObject({
    status: 503,
    code: 'unavailable',
    message: 'Collaboration links could not be checked. Refresh before retrying.',
  });
  expect(h.f.store.collaborationConversation.view(h.f.group)).toEqual(before);
});

it('checks current revoked authority before calling the real joining authority', async () => {
  const h = await allocated();
  h.afterAuthentication(() => revokeAuthSession(h.auth));
  await expect(h.api.reconcileJoin(h.f.group, h.join.joinId, h.approval)).rejects.toMatchObject({
    status: 403,
    message: 'Operator authorization expired or revoked',
  });
  expect(h.f.authority.authorizeReconciliation).not.toHaveBeenCalled();
  expect(h.f.store.collaborationConversation.getJoin(h.f.group, h.join.joinId)).toEqual(h.join);
});

it('aborts an in-flight real reconciliation on revocation before any link mutation', async () => {
  const h = await allocated();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let signal!: AbortSignal;
  const authority: OrdinaryCollaborationJoiningAuthority = h.f.authority;
  vi.spyOn(authority, 'authorizeReconciliation').mockImplementationOnce(
    async (_input, requestSignal) => {
      signal = requestSignal;
      started();
      await new Promise<void>((resolve) =>
        requestSignal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
  );
  const before = h.f.store.collaborationConversation.view(h.f.group);
  const pending = h.api.reconcileJoin(h.f.group, h.join.joinId, h.approval);
  const result = expect(pending).rejects.toMatchObject({ status: 403 });
  await entered;
  revokeAuthSession(h.auth);
  await result;
  expect(signal.aborted).toBe(true);
  expect(h.f.store.collaborationConversation.view(h.f.group)).toEqual(before);
});

it('keeps missing joining unavailable for recovery and reconciliation before parsing disabled bodies', async () => {
  const h = await allocated();
  h.remount(false);
  await expect(h.api.recoverJoin(h.f.group, h.join.joinId)).rejects.toMatchObject({
    status: 503,
    code: 'execution_unavailable',
  });
  await expect(h.api.reconcileJoin(h.f.group, h.join.joinId, h.approval)).rejects.toMatchObject({
    status: 503,
    code: 'execution_unavailable',
  });
  const response = await request(h.app)
    .post(`/api/session-collaborations/${h.f.group}/joins/${h.join.joinId}/reconcile`)
    .set('Cookie', h.cookie)
    .send({ disabled: true });
  expect(response.status).toBe(503);
  expect(response.body.code).toBe('execution_unavailable');
  expect(h.f.authority.authorizeReconciliation).not.toHaveBeenCalled();
  expect(h.f.store.collaborationConversation.getJoin(h.f.group, h.join.joinId)).toEqual(h.join);
});

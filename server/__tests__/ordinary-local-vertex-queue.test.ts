import { afterEach, expect, it, vi } from 'vitest';
import { ownedVertexRuntimeFixture } from './fixtures/owned-local-vertex-runtime.js';
import { OrdinaryLocalVertexOwnedRuntime } from '../ordinary-local-vertex-owned-runtime.js';
import express from 'express';
import request from 'supertest';
import { createCodexQueueRouter } from '../codex-queue-routes.js';
import type { AuthSession } from '../auth.js';
import {
  assertOwnedVertexQueueControl,
  cancelOwnedVertexQueuedCommand,
  readOwnedVertexQueueOverview,
  readOwnedVertexRecovery,
} from '../ordinary-local-vertex-queue.js';
const state = vi.hoisted(() => ({ revoked: false }));
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  hasPersistentRevocationAuthority: () => true,
  registerAuthSession: (_auth: unknown, callback: () => void) => {
    if (state.revoked) callback();
    return () => {};
  },
}));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  state.revoked = false;
  vi.unstubAllEnvs();
});
async function admittedRuntime() {
  const f = await ownedVertexRuntimeFixture(cleanups);
  const owner = new OrdinaryLocalVertexOwnedRuntime({
    enabled: true,
    eventStore: f.events,
    library: f.library,
    workspace: f.workspace,
    reservation: f.reservation,
    commandId: f.request.clientMsgId,
    operatorConnectionId: f.dependencies.operatorConnectionId,
    signal: f.signal.signal,
    env: f.dependencies.env,
    dispatch: async () => {},
    dispatchContinuation: async () => {},
  });
  cleanups.push(() => owner.close());
  await owner.admit(f.request);
  return { ...f, owner };
}
function recoveryApp(f: Awaited<ReturnType<typeof admittedRuntime>>, auth?: AuthSession) {
  const app = express();
  app.use((_req, res, next) => {
    res.locals.authSession = auth;
    next();
  });
  app.use(
    createCodexQueueRouter({
      authorizeMutation: (id, operator) => assertOwnedVertexQueueControl(f.events, id, operator),
      binding: (id) => f.events.getSession(id)?.accountBinding ?? undefined,
      recovery: (id, _binding, operator) => readOwnedVertexRecovery(f.events, id, operator),
      overview: (id) => readOwnedVertexQueueOverview(f.events, id),
      cancel: () => 'not_found',
      retry: async () => 'not_found',
      reattach: async () => 'unavailable',
    }),
  );
  return app;
}
it('guards cold Claude queue cancellation with original signed custody and retains foreign/revoked work', async () => {
  const f = await admittedRuntime();
  const owner = f.owner;
  await owner.admitContinuation({
    ...f.request,
    clientMsgId: 'queued',
    payload: { text: 'Original saved work' },
    selection: { ...f.request.selection, model: 'next-model', thinking: 'high' },
  });
  owner.close();
  const id = f.reservation.conversationId;
  expect(() => assertOwnedVertexQueueControl(f.events, id, f.auth)).not.toThrow();
  for (const auth of [undefined, { ...f.auth, id: 'foreign' }, { ...f.auth, expiresAt: 0 }])
    expect(() => cancelOwnedVertexQueuedCommand(f.events, id, 'queued', auth)).toThrow();
  state.revoked = true;
  expect(() => cancelOwnedVertexQueuedCommand(f.events, id, 'queued', f.auth)).toThrow();
  state.revoked = false;
  expect(readOwnedVertexQueueOverview(f.events, id).queued).toContainEqual({
    id: 'queued',
    preview: 'Original saved work',
  });
  expect(f.events.getSendCommand('queued')?.error).toBeNull();
  expect(cancelOwnedVertexQueuedCommand(f.events, id, 'queued', f.auth)).toBe('cancelled');
  expect(
    readOwnedVertexQueueOverview(f.events, id).queued.find((command) => command.id === 'queued'),
  ).toBeUndefined();
  expect(readOwnedVertexQueueOverview(f.events, id).cancelledIds).toContain('queued');
});

it('inspects only the original retained SDK operation without converting absent evidence into a safe replay', async () => {
  const f = await admittedRuntime();
  f.owner.close();
  const id = f.reservation.conversationId;
  const before = JSON.stringify(f.events.getSendCommand(f.request.clientMsgId));
  const diagnostic = readOwnedVertexRecovery(f.events, id, f.auth);
  expect(diagnostic).toMatchObject({
    version: 1,
    sessionId: id,
    commandId: f.request.clientMsgId,
    status: 'unconfirmed',
    inputAcknowledged: false,
    mayReplay: false,
    nextAction: 'inspect_original_owner',
  });
  expect(diagnostic.sdkSessionId).toBe(f.events.getOrdinaryLocalVertexCustody(id)!.sdkSessionId);
  expect(JSON.stringify(diagnostic)).not.toContain(f.request.payload.text);
  expect(JSON.stringify(f.events.getSendCommand(f.request.clientMsgId))).toBe(before);
  const url = `/${id}/codex-queue/recovery`;
  const res = await request(recoveryApp(f, f.auth)).get(url).expect(200);
  expect(res.body).toEqual(JSON.parse(JSON.stringify(diagnostic)));
  for (const auth of [undefined, { ...f.auth, id: 'foreign' }, { ...f.auth, expiresAt: 0 }]) {
    expect(() => readOwnedVertexRecovery(f.events, id, auth)).toThrow();
    const denied = await request(recoveryApp(f, auth)).get(url).expect(403);
    expect(denied.body.commandId).toBeUndefined();
  }
  state.revoked = true;
  expect(() => readOwnedVertexRecovery(f.events, id, f.auth)).toThrow();
  await request(recoveryApp(f, f.auth)).get(url).expect(403);
});

it('refuses malformed retained SDK evidence instead of projecting an empty or successful recovery', async () => {
  const f = await admittedRuntime();
  const id = f.reservation.conversationId;
  f.events.append(id, 'ordinary_sdk_turn_accepted', { commandId: f.request.clientMsgId });
  expect(() => readOwnedVertexRecovery(f.events, id, f.auth)).toThrow();
  const res = await request(recoveryApp(f, f.auth)).get(`/${id}/codex-queue/recovery`).expect(503);
  expect(res.body).toMatchObject({
    code: 'sdk_recovery_inspection_unavailable',
    diagnosticId: expect.any(String),
  });
  expect(res.body.commandId).toBeUndefined();
});

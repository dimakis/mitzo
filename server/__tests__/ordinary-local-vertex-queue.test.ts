import { afterEach, expect, it, vi } from 'vitest';
import { ownedVertexRuntimeFixture } from './fixtures/owned-local-vertex-runtime.js';
import { OrdinaryLocalVertexOwnedRuntime } from '../ordinary-local-vertex-owned-runtime.js';
import {
  assertOwnedVertexQueueControl,
  cancelOwnedVertexQueuedCommand,
  readOwnedVertexQueueOverview,
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
it('guards cold Claude queue cancellation with original signed custody and retains foreign/revoked work', async () => {
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

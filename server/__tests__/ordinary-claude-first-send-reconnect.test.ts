import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AsyncQueue } from '../async-queue.js';
import { sdkFixtureBoundary, sdkQueryPeer } from './fixtures/sdk-query-peer.js';
import { hostKnowledgePublication } from './fixtures/host-knowledge-publication.js';

vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  hasPersistentRevocationAuthority: () => true,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: vi.fn(),
  getSessionInfo: vi.fn(async (sessionId: string, options: { dir: string }) => ({
    sessionId,
    cwd: options.dir,
  })),
  getSessionMessages: vi.fn(async () => []),
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../session-index.js', async (original) => ({
  ...(await original<object>()),
  registerSession: vi.fn(),
}));
vi.mock('../prompt-compare.js', () => ({ capturePromptComparison: vi.fn(async () => {}) }));
vi.mock('../auto-rename.js', async (original) => ({
  ...(await original<object>()),
  shouldAutoRename: () => false,
}));
vi.mock('../hook-bridge.js', async (original) => ({
  ...(await original<object>()),
  loadProjectHooks: vi.fn(),
}));

const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  resetOfflineUserEnvironment();
  vi.resetModules();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/**
 * A new Claude chat started through the real owned entry: owned-runtime
 * admission, repository claim, custody and `startChat` with an offline SDK peer.
 * The phone's live stream is bound separately from the server-only operation
 * binding the HTTP entry creates, exactly as `/send` does.
 */
async function firstSend() {
  const { ownedVertexRuntimeFixture } = await import('./fixtures/owned-local-vertex-runtime.js');
  const f = await ownedVertexRuntimeFixture(cleanups, { chatRoute: true });
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({}))),
  );
  const repositories = await import('../repository-workspace-runtime.js');
  vi.spyOn(repositories, 'getRepositoryWorkspaces').mockReturnValue(f.workspace);
  const library = await import('../agent-library-runtime.js');
  vi.spyOn(library, 'getAgentLibrary').mockReturnValue(f.library);
  const boundary = await import('../credential-sdk-boundary.js');
  vi.spyOn(boundary, 'credentialSdkBoundary').mockReturnValue({
    ...sdkFixtureBoundary(),
    credentialIsolation: true,
  } as never);
  const knowledge = await import('../published-host-knowledge.js');
  const publication = hostKnowledgePublication(f.root, 'a', 'Accepted shared memory');
  cleanups.push(
    knowledge.installHostKnowledgeStore({ id: 'mgmt', reconcile: async () => publication }),
  );
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  vi.mocked(query).mockImplementation((request) => {
    const events = new AsyncQueue<Record<string, unknown>>();
    const peer = sdkQueryPeer(
      request,
      (async function* () {
        for await (const event of events) yield event;
      })(),
    );
    const close = peer.close;
    peer.close = () => {
      events.close();
      close();
    };
    return peer;
  });
  const transportModule = await import('../agent-library-transport.js');
  const auth = await import('../auth.js');
  const chat = await import('../chat.js');
  const entry = await import('../ordinary-local-vertex-entry.js');
  // The phone's stream. Closing it deletes this ID from the operator map.
  const phone = `conn-${randomUUID()}`;
  const releasePhone = transportModule.bindAgentLibraryTransport(phone, f.auth);
  cleanups.push(releasePhone);
  const sent = vi.fn();
  const sessionId = f.reservation.conversationId;
  cleanups.push(async () => {
    chat.registry.findBySessionId(sessionId)?.session.ordinaryRuntimeOwner?.close();
    chat.registry.dispose();
    chat.eventStore.close();
  });
  /** Runs `during` once the worktree is claimed, before the session is registered. */
  const afterWorktreeClaim = (during: () => void) => {
    const claim = f.workspace.claimReservedHostTask.bind(f.workspace);
    vi.spyOn(f.workspace, 'claimReservedHostTask').mockImplementation(async (...args) => {
      const claimed = await claim(...args);
      expect(chat.registry.findBySessionId(sessionId)).toBeFalsy();
      during();
      return claimed;
    });
  };
  const start = () =>
    entry.startOwnedLocalVertexCommand(
      { send: sent, isOpen: () => true },
      `${phone}:${sessionId}`,
      {
        command: f.request,
        reservation: f.reservation,
        operatorConnectionId: f.dependencies.operatorConnectionId,
        ownerConnectionId: phone,
        ownerAuthSessionId: f.auth.id,
      },
    );
  return { f, chat, phone, releasePhone, sessionId, afterWorktreeClaim, start, auth };
}

it('starts a new Claude chat when its stream reconnects between admission and session registration', async () => {
  const x = await firstSend();
  // The phone's stream drops after the worktree exists and before the driver
  // registers. A reconnect issues a new connection ID; the old one is gone.
  x.afterWorktreeClaim(x.releasePhone);
  await expect(x.start()).resolves.toMatchObject({ dispatched: true, sessionId: x.sessionId });
  const registered = x.chat.registry.findBySessionId(x.sessionId)?.session;
  expect(registered?.ownedLocalAuthSessionId).toBe(x.f.auth.id);
  // Event routing still names the operator's stream; reconnect handling rebinds it.
  expect(registered?.ownerConnectionId).toBe(x.phone);
  expect(x.chat.eventStore.getSession(x.sessionId)).toBeTruthy();
}, 30_000);

it('still stops a first send when the operator logs out in the same window', async () => {
  const x = await firstSend();
  x.afterWorktreeClaim(() => x.auth.revokeAuthSession(x.f.auth));
  const failure = await x.start().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  // The entry keeps the classified cause instead of a bare "runtime unavailable".
  const { findSessionRuntimeError } = await import('../session-runtime-error.js');
  expect(findSessionRuntimeError(failure)?.code).toBe('auth_revoked');
  expect(x.chat.registry.findBySessionId(x.sessionId)).toBeFalsy();
}, 30_000);

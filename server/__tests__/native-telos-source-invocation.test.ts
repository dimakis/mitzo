import { afterAll, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  capturePendingTelosSourceReviewCurrent,
  getPendingTelosSourceReview,
} from '@mitzo/harness';
const setup = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-source-invocation-'));
  for (const [key, value] of Object.entries({
    REPO_PATH: root,
    MITZO_INTERNAL_TOKEN_PATH: path.join(root, 'internal-token'),
    MITZO_CODEX_PRIVATE_DIR: path.join(root, 'private'),
  }))
    vi.stubEnv(key, value);
  const network = vi.fn(() => {
    throw Error('Offline fixture forbids network and model calls');
  });
  vi.stubGlobal('fetch', network);
  return { root, network, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
});
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('Offline fixture forbids model calls');
  },
  listSessions: () => [],
}));
import { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import { CodexAppServerClient, type CodexLifecycleTransport } from '../codex-app-server-client.js';
import { login, authenticateToken, setAuthRevocationStore } from '../auth.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import {
  initializeTelosMainPublicationRuntime,
  closeTelosMainPublicationRuntime,
} from '../telos-main-publication-runtime.js';
import * as workspaces from '../repository-workspace-runtime.js';
import * as library from '../agent-library-runtime.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterAll(async () => {
  closeTelosMainPublicationRuntime();
  for (const close of cleanups.splice(0).reverse()) await close();
  setup.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Actual ordinary chat start, original CodexChat/native callback and real pending
 * permission. Only external native process/RPC is synthetic. This bounded probe
 * stops before operator approval; it does not claim the canonical App journey. */
it('retains the signed native scope on the real source permission and refuses retirement before any source effect', async () => {
  const f = await ownedRuntimeFixture(cleanups, {
    chatRoute: true,
    tools: [{ id: 'mitzo:TelosAdoptSource', version: 1 }],
  });
  const chat = await import('../chat.js');
  const native = await import('../codex-chat-session.js');
  setAuthRevocationStore(chat.eventStore);
  vi.spyOn(workspaces, 'getRepositoryWorkspaces').mockReturnValue(f.workspace);
  vi.spyOn(library, 'getAgentLibrary').mockReturnValue(f.library);
  f.detach();
  const auth = (await authenticateToken((await login(process.env.AUTH_PASSPHRASE!))!))!;
  cleanups.push(bindAgentLibraryTransport(f.dependencies.operatorConnectionId, auth));
  const database = join(f.root, 'canonical-never-opened.db');
  const service = initializeTelosMainPublicationRuntime(
    { registry: chat.registry, events: chat.eventStore, databasePath: () => database },
    '',
  );
  const first = f.rpc.request.getMockImplementation()!;
  f.rpc.request.mockImplementation(async (method) => {
    if (method === 'thread/start')
      return { thread: { id: 'source-thread' }, model: 'fixture-model', modelProvider: 'openai' };
    if (method === 'turn/start') return { turn: { id: 'source-turn' } };
    return first(method);
  });
  let lifecycle!: CodexLifecycleTransport;
  vi.spyOn(CodexAppServerClient, 'launchIsolated').mockImplementation((_home, _env, callbacks) => {
    if (!callbacks) throw Error('Original lifecycle callbacks missing');
    lifecycle = callbacks;
    return f.rpc as unknown as ReturnType<typeof CodexAppServerClient.launchIsolated>;
  });
  const clientId = `${f.dependencies.operatorConnectionId}:${f.reservation.conversationId}`;
  cleanups.push(async () => {
    chat.registry.abort(clientId);
    await vi.waitFor(() =>
      expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeFalsy(),
    );
    native.getCodexConversationStore().close();
    chat.eventStore.close();
  });
  const sent: Record<string, unknown>[] = [];
  const transport = {
    send: (event: Record<string, unknown>) => {
      sent.push(event);
    },
    isOpen: () => true,
  };
  const result = await chat.startOwnedLocalCodexCommand(transport, clientId, {
    command: f.request,
    reservation: f.reservation,
    commandId: f.request.clientMsgId,
    operatorConnectionId: f.dependencies.operatorConnectionId,
    ownerConnectionId: f.dependencies.operatorConnectionId,
    signal: new AbortController().signal,
  });
  expect(result.dispatched).toBe(true);
  await vi.waitFor(() =>
    expect(native.getCodexRuntime(chat.registry.get(clientId)!)).toBeDefined(),
  );
  await vi.waitFor(() =>
    expect(
      native
        .getCodexConversationStore()
        .hasAcceptedProviderTurn(f.reservation.conversationId, f.reservation.binding),
    ).toBe(true),
  );
  const networkCalls = setup.network.mock.calls.length;
  let executing: Promise<unknown> | undefined;
  try {
    executing = lifecycle.onRequest(
      'item/tool/call',
      {
        threadId: 'source-thread',
        turnId: 'source-turn',
        callId: 'original-source-call',
        tool: 'TelosAdoptSource',
        arguments: { itemId: 'not-created-by-this-probe' },
      },
      new AbortController().signal,
    );
    // Observe any early callback rejection immediately; still assert its result below.
    void executing.catch(() => {});
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    const card = sent.find((e) => e.type === 'permission_request')!;
    const proof = getPendingTelosSourceReview(card.permId as string, f.reservation.conversationId)!;
    expect(proof).toBeDefined();
    const current = capturePendingTelosSourceReviewCurrent(proof, auth.id)!;
    expect(current).toBeDefined();
    expect(current.requiresLiveNativeCall).toBe(true);
    expect(
      capturePendingTelosSourceReviewCurrent(proof, 'another-signed-operator'),
    ).toBeUndefined();
    expect(JSON.stringify(proof)).not.toMatch(
      /operatorId|nativeSourceScope|requiresLiveNativeCall/,
    );
    service.close();
    expect(() => current()).toThrow();
    expect(getPendingTelosSourceReview(proof.permId, proof.sessionId)).toBeUndefined();
    expect(await executing).toMatchObject({ success: false });
    expect(setup.network.mock.calls.length).toBe(networkCalls);
    expect(existsSync(database)).toBe(false);
    expect(
      native
        .getCodexConversationStore()
        .commandStatus(f.reservation.conversationId, f.reservation.binding, f.request.clientMsgId),
    ).toBe('running');
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  } finally {
    service.close();
    await executing?.catch(() => {});
  }
}, 20000);

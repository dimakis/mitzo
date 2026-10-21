import { afterAll, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectionRegistry } from '@mitzo/harness';
import { SessionSseRegistry } from '../session-sse-registry.js';
import { createOwnedLocalCodexEntryRouter } from '../ordinary-local-codex-entry.js';
import {
  claimTransportConnection,
  releaseTransportConnection,
} from '../transport-auth-ownership.js';
import type express from 'express';
const setup = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-real-owned-start-'));
  for (const [key, value] of Object.entries({
    REPO_PATH: root,
    MITZO_INTERNAL_TOKEN_PATH: path.join(root, 'internal-token'),
    MITZO_CODEX_PRIVATE_DIR: path.join(root, 'private'),
  }))
    vi.stubEnv(key, value);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('Offline test forbids external network/model calls');
    }),
  );
  return { root, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
});
vi.mock('../openai-account-key-authority.js', () => ({
  openAIAccountKeyAuthority: () => ({
    assertReady: async () => {},
    resolveKey: async () => 'synthetic-api-key',
  }),
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('Offline test forbids SDK/model calls');
  },
  listSessions: () => [],
}));
import { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import { CodexAppServerClient } from '../codex-app-server-client.js';
import { login, authenticateToken, setAuthRevocationStore } from '../auth.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import * as workspaces from '../repository-workspace-runtime.js';
import * as library from '../agent-library-runtime.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterAll(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  setup.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('starts local API Codex from the composer without selecting or importing a repository and never replays an exact retry', async () => {
  const f = await ownedRuntimeFixture(cleanups, {
    chatRoute: true,
    api: true,
    localRepository: true,
    tools: [{ id: 'mitzo:AgentCommunication', version: 1 }],
  });
  const chat = await import('../chat.js');
  const native = await import('../codex-chat-session.js');
  const nativeStartup = vi.spyOn(native, 'openCodexChat');
  setAuthRevocationStore(chat.eventStore);
  vi.spyOn(workspaces, 'getRepositoryWorkspaces').mockReturnValue(f.workspace);
  vi.spyOn(workspaces, 'getLocalRepositoryWorkspaces').mockReturnValue(f.workspace);
  vi.spyOn(library, 'getAgentLibrary').mockReturnValue(f.library);
  f.detach();
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  const auth = (await authenticateToken(token))!;
  cleanups.push(bindAgentLibraryTransport(f.dependencies.operatorConnectionId, auth));
  const first = f.rpc.request.getMockImplementation()!;
  let providerCalls = 0;
  f.rpc.request.mockImplementation(async (method) => {
    if (method === 'thread/start')
      return {
        thread: { id: 'real-host-thread' },
        model: 'fixture-model',
        modelProvider: 'openai',
      };
    if (method === 'turn/start') {
      expect(chat.eventStore.getOrdinaryCommandAdmission(f.request.clientMsgId)?.state).toBe(
        'consumed',
      );
      providerCalls++;
      return { turn: { id: 'real-host-turn' } };
    }
    return first(method);
  });
  const launch = vi
    .spyOn(CodexAppServerClient, 'launchIsolatedApi')
    .mockImplementation(async (options) => {
      writeFileSync(
        join(options.privateHome, 'auth.json'),
        JSON.stringify({ OPENAI_API_KEY: 'synthetic-api-key' }),
        { mode: 0o600, flag: 'wx' },
      );
      return { client: f.rpc as never, binding: options.binding };
    });
  const connectionId = f.dependencies.operatorConnectionId;
  const transport = { send: vi.fn(), isOpen: () => true };
  const connections = new ConnectionRegistry(),
    streams = new SessionSseRegistry();
  connections.register(connectionId, transport);
  streams.add(
    connectionId,
    { write: () => true, end: () => {}, writableEnded: false } as unknown as express.Response,
    auth.id,
  );
  claimTransportConnection(connectionId, auth.id);
  let clientId: string | undefined;
  cleanups.push(async () => {
    streams.remove(connectionId);
    releaseTransportConnection(connectionId, auth.id);
    if (clientId) chat.registry.abort(clientId);
    native.getCodexConversationStore().close();
    chat.eventStore.close();
  });
  const router = createOwnedLocalCodexEntryRouter(
    streams,
    { connRegistry: connections, sessionRegistry: chat.registry, eventStore: chat.eventStore },
    true,
  );
  const body = { runOn: 'local', ...f.request };
  const send = () =>
    new Promise<{
      status: number;
      body: { sessionId: string; dispatched: boolean; state: string };
    }>((resolve, reject) => {
      let status = 200;
      const response = {
        locals: { authSession: auth },
        set() {
          return this;
        },
        status(code: number) {
          status = code;
          return this;
        },
        json(body: never) {
          resolve({ status, body });
          return this;
        },
      } as unknown as express.Response;
      (
        router as express.Router & {
          handle(
            req: express.Request,
            res: express.Response,
            next: (error?: unknown) => void,
          ): void;
        }
      ).handle(
        {
          method: 'POST',
          url: '/send',
          body,
          headers: { 'x-connection-id': connectionId, 'content-type': 'application/json' },
          cookies: { cc_auth: token },
          get: () => undefined,
          header: (name: string) => (name === 'content-type' ? 'application/json' : undefined),
          is: (name: string) => name === 'application/json',
        } as unknown as express.Request,
        response,
        (error) => reject(error ?? Error('Not handled')),
      );
    });
  const result = await send();
  expect(result.status, JSON.stringify(result.body)).toBe(202);
  const sessionId = result.body.sessionId;
  clientId = `${connectionId}:${sessionId}`;
  expect(result.body.dispatched).toBe(true);
  await vi.waitFor(() => expect(providerCalls).toBe(1));
  expect(launch).toHaveBeenCalledOnce();
  expect(
    native
      .getCodexConversationStore()
      .commandStatus(sessionId, f.reservation.binding, f.request.clientMsgId),
  ).toBe('running');
  expect((await send()).body).toMatchObject({ dispatched: false, sessionId });
  const workspace = f.workspace.getForConversation(sessionId)!;
  expect(workspace.localSource).toBeDefined();
  expect(workspace.taskIdentity?.linkedGit).toBeDefined();
  expect(nativeStartup.mock.calls[0][0].publishingGitStorageRoots).toContain(
    workspace.localSource!.commonDirectory,
  );
  expect(chat.eventStore.getSessionRuntimeBinding(sessionId)?.harness.implementation).toBe('codex');
  expect(providerCalls).toBe(1);
  expect(launch).toHaveBeenCalledOnce();
}, 20000);

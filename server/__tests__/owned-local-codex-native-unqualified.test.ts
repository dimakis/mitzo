import { afterAll, expect, it, vi } from 'vitest';
const setup = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-unqualified-execution-'));
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

it('refuses an unqualified native artifact without silently launching legacy host tools', async () => {
  const f = await ownedRuntimeFixture(cleanups, {
    chatRoute: true,
    tools: ['Bash', 'Read', 'Write', 'Edit', 'AgentCommunication'].map((name) => ({
      id: `mitzo:${name}`,
      version: 1,
    })),
  });
  // Select the Mac branch while retaining the real artifact classifier and the
  // actual host dependencies; unqualified bytes must still refuse before RPC.
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
  const chat = await import('../chat.js');
  const native = await import('../codex-chat-session.js');
  setAuthRevocationStore(chat.eventStore);
  vi.spyOn(workspaces, 'getRepositoryWorkspaces').mockReturnValue(f.workspace);
  vi.spyOn(library, 'getAgentLibrary').mockReturnValue(f.library);
  f.detach();
  const auth = (await authenticateToken((await login(process.env.AUTH_PASSPHRASE!))!))!;
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
  vi.spyOn(CodexAppServerClient, 'launchIsolated').mockReturnValue(f.rpc as never);
  const clientId = `${f.dependencies.operatorConnectionId}:${f.reservation.conversationId}`;
  cleanups.push(async () => {
    chat.registry.abort(clientId);
    await vi.waitFor(() =>
      expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeFalsy(),
    );
    native.getCodexConversationStore().close();
    chat.eventStore.close();
  });
  const transport = { send: vi.fn(), isOpen: () => true };
  const input = {
    command: f.request,
    reservation: f.reservation,
    commandId: f.request.clientMsgId,
    operatorConnectionId: f.dependencies.operatorConnectionId,
    ownerConnectionId: f.dependencies.operatorConnectionId,
    signal: new AbortController().signal,
  };
  await expect(chat.startOwnedLocalCodexCommand(transport, clientId, input)).rejects.toThrow(
    'Native Mac execution is unavailable for this unqualified Codex artifact.',
  );
  expect(providerCalls).toBe(0);
  expect(f.rpc.request.mock.calls.some(([method]) => method === 'thread/start')).toBe(false);
  expect(f.rpc.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
  const { NATIVE_MAC_ARTIFACT_UNAVAILABLE } =
    await import('../codex-native-artifact-qualification.js');
  expect(native.publicCodexRuntimeError(Error(NATIVE_MAC_ARTIFACT_UNAVAILABLE))).toBe(
    NATIVE_MAC_ARTIFACT_UNAVAILABLE,
  );
}, 20000);

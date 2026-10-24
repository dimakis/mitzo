import { afterAll, expect, it, vi } from 'vitest';
const setup = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-owned-execution-'));
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
// The integration exercises the existing physical owner and host adapter with
// synthetic executable bytes. The exact-artifact classifier has separate tests;
// kernel fixtures exercise the official bytes without a model call.
vi.mock('../codex-native-artifact-qualification.js', async (original) => ({
  ...(await original<typeof import('../codex-native-artifact-qualification.js')>()),
  assertQualifiedNativeMacExecutionArtifact: vi.fn(),
}));
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

it('enables native tools and fixed scoped permissions on the actual admitted Mac route', async () => {
  const f = await ownedRuntimeFixture(cleanups, {
    chatRoute: true,
    tools: ['Bash', 'Read', 'Write', 'Edit', 'AgentCommunication'].map((name) => ({
      id: `mitzo:${name}`,
      version: 1,
    })),
  });
  // The runtime/transport are synthetic; qualify this fixture's Mac host identity
  // after loading the actual host dependencies, including SQLite.
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
  const launch = vi.spyOn(CodexAppServerClient, 'launchIsolated').mockReturnValue(f.rpc as never);
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
  const result = await chat.startOwnedLocalCodexCommand(transport, clientId, input);
  expect(result.dispatched).toBe(true);
  await vi.waitFor(() => expect(providerCalls).toBe(1));
  expect(launch).toHaveBeenCalledOnce();
  const calls = f.rpc.request.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
  const thread = calls.find(([method]) => method === 'thread/start')?.[1] as Record<
    string,
    unknown
  >;
  const turn = calls.find(([method]) => method === 'turn/start')?.[1] as Record<string, unknown>;
  expect(thread).toMatchObject({
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    permissions: 'mitzo-native-agent',
    config: {
      'features.shell_tool': true,
      'features.unified_exec': true,
      'features.shell_zsh_fork': false,
      notify: [],
    },
  });
  expect(thread).not.toHaveProperty('sandbox');
  expect(turn).toMatchObject({
    approvalPolicy: 'on-request',
    permissions: 'mitzo-native-agent',
    runtimeWorkspaceRoots: [expect.any(String)],
  });
  expect(turn).not.toHaveProperty('sandboxPolicy');
  const names = ((thread.dynamicTools ?? []) as Array<{ name: string }>).map((tool) => tool.name);
  for (const name of ['Bash', 'Read', 'Write', 'Edit']) expect(names).not.toContain(name);
  expect(thread.developerInstructions).toContain(
    'Native Codex tools execute on the selected Local Mac',
  );
  expect(thread.developerInstructions).toContain('Automatic review is unavailable');
  expect(
    native
      .getCodexConversationStore()
      .commandStatus(f.reservation.conversationId, f.reservation.binding, f.request.clientMsgId),
  ).toBe('running');
  expect(await chat.startOwnedLocalCodexCommand(transport, clientId, input)).toMatchObject({
    dispatched: false,
  });
  expect(providerCalls).toBe(1);
  expect(launch).toHaveBeenCalledOnce();
}, 20000);

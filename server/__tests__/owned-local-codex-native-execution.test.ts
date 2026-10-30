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
import { setConnectionsRuntime } from '../connections-runtime.js';
import { googleWorkspaceChatFixture } from './fixtures/google-workspace-chat.js';
import { resolvePending } from '../permissions.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterAll(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  setup.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('reads Google documents through an admitted Local Mac chat while credentials stay denied', async () => {
  const f = await ownedRuntimeFixture(cleanups, {
    chatRoute: true,
    tools: ['Bash', 'Read', 'Write', 'Edit', 'AgentCommunication', 'GoogleWorkspaceRead'].map(
      (name) => ({
        id: `mitzo:${name}`,
        version: 1,
      }),
    ),
  });
  const google = await googleWorkspaceChatFixture(f.root);
  setConnectionsRuntime(google.runtime);
  cleanups.push(() => {
    setConnectionsRuntime(null);
    google.runtime.store.close();
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
  let callbacks: NonNullable<Parameters<typeof CodexAppServerClient.launchIsolated>[2]>;
  const launch = vi
    .spyOn(CodexAppServerClient, 'launchIsolated')
    .mockImplementation((_home, _env, lifecycle) => {
      callbacks = lifecycle!;
      return f.rpc as never;
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
  const call = (tool: string, arguments_: Record<string, unknown>, callId: string) =>
    callbacks!.onRequest(
      'item/tool/call',
      {
        threadId: 'real-host-thread',
        turnId: 'real-host-turn',
        callId,
        tool,
        arguments: arguments_,
      },
      new AbortController().signal,
    );
  expect(names).toContain('GoogleWorkspaceRead');
  const listing = await call(
    'ListIntegrationTools',
    { query: 'Google', limit: 20 },
    'google-discovery',
  );
  expect(JSON.stringify(listing)).toContain('GoogleWorkspaceRead');
  const read = call(
    'GoogleWorkspaceRead',
    { operation: 'drive.export', fileId: 'fixture-document', mimeType: 'text/plain' },
    'google-read',
  );
  await vi.waitFor(
    () =>
      expect(transport.send.mock.calls.some(([event]) => event.type === 'permission_request')).toBe(
        true,
      ),
    { timeout: 10000 },
  );
  const approval = transport.send.mock.calls
    .map(([event]) => event)
    .find((event) => event.type === 'permission_request')!;
  expect(approval.description).toContain('fixture@example.test');
  expect(google.contentReads()).toHaveLength(0);
  expect(resolvePending(approval.permId, 'once', undefined, f.reservation.conversationId)).toBe(
    true,
  );
  const googleResult = await read;
  expect(googleResult).toMatchObject({ success: true });
  expect(JSON.stringify(googleResult)).toContain('Google document content from the approved read');
  expect(google.contentReads()).toHaveLength(1);
  expect(JSON.stringify(googleResult)).not.toContain('SECRET');
  const approvals = () =>
    transport.send.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'permission_request');
  const nextApproval = async (before: number) => {
    await vi.waitFor(() => expect(approvals().length).toBeGreaterThan(before), { timeout: 10000 });
    return approvals().at(-1)!;
  };
  const readInput = {
    operation: 'drive.export',
    fileId: 'fixture-document',
    mimeType: 'text/plain',
  };
  const deniedRead = call('GoogleWorkspaceRead', readInput, 'denied-google-read');
  const deniedApproval = await nextApproval(approvals().length);
  resolvePending(deniedApproval.permId, 'deny', undefined, f.reservation.conversationId);
  expect(await deniedRead).toMatchObject({ success: false });
  expect(google.contentReads()).toHaveLength(1);
  google.content.text = 'Approved long Google document. '.repeat(1000);
  const longRead = call('GoogleWorkspaceRead', readInput, 'long-google-read');
  const longApproval = await nextApproval(approvals().length);
  resolvePending(longApproval.permId, 'once', undefined, f.reservation.conversationId);
  const longResult = await longRead;
  expect(longResult).toMatchObject({ success: true });
  const preview = JSON.parse((longResult.contentItems as Array<{ text: string }>)[0]!.text);
  expect(preview).toMatchObject({
    format: 'tool-output-preview',
    complete: false,
    outputId: expect.any(String),
  });
  expect(names).toContain('ReadToolOutput');
  const retained = await call(
    'ReadToolOutput',
    { outputId: preview.outputId, offset: 0, limit: 1000 },
    'retained-google-read',
  );
  expect(retained).toMatchObject({ success: true });
  expect(JSON.stringify(retained)).toContain('Approved long Google document.');
  const retiredRead = call('GoogleWorkspaceRead', readInput, 'retired-google-read');
  const retiredApproval = await nextApproval(approvals().length);
  setConnectionsRuntime(null);
  resolvePending(retiredApproval.permId, 'once', undefined, f.reservation.conversationId);
  expect(await retiredRead).toMatchObject({ success: false });
  expect(google.contentReads()).toHaveLength(2);
  expect(JSON.stringify(transport.send.mock.calls)).not.toContain('SECRET');
  const profiles = JSON.stringify(thread.config);
  expect(profiles).toContain('.config/gws');
  expect(profiles).toContain('deny');
}, 40000);

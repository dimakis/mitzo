import { expect, vi } from 'vitest';
import { ownedRuntimeFixture } from './owned-local-codex-runtime.js';
import { CodexAppServerClient } from '../../codex-app-server-client.js';
import { login, authenticateToken, setAuthRevocationStore } from '../../auth.js';
import { bindAgentLibraryTransport } from '../../agent-library-transport.js';
import * as workspaces from '../../repository-workspace-runtime.js';
import * as library from '../../agent-library-runtime.js';
import { resolvePending } from '../../permissions.js';

const serviceTools = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'ListConnections',
  'GetConnectionGuide',
  'PrepareConnectionSetup',
  'GetConnectionSetup',
  'RequestConnectionAccess',
  'ConnectionRequest',
  'ConnectionWebSocket',
  'HomeAssistantDashboard',
  'ReadKnowledge',
  'SaveKnowledgeDraft',
  'RequestWebAccess',
];
/** Real admission and native tool dispatch; model RPC remains deterministic. */
export async function admittedMacServiceChat(
  cleanups: Array<() => void | Promise<void>>,
  mode: 'agent' | 'ask' = 'agent',
) {
  const f = await ownedRuntimeFixture(cleanups, {
    chatRoute: true,
    mode,
    tools: serviceTools.map((name) => ({ id: `mitzo:${name}`, version: 1 })),
  });
  const permissions = mode === 'ask' ? 'mitzo-native-ask' : 'mitzo-native-agent';
  // The runtime/transport are synthetic; qualify this fixture's Mac host identity
  // after loading the actual host dependencies, including SQLite.
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
  const chat = await import('../../chat.js');
  const native = await import('../../codex-chat-session.js');
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
    permissions,
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
    permissions,
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
  const call = (
    tool: string,
    arguments_: Record<string, unknown>,
    callId: string,
    callSignal = new AbortController().signal,
  ) =>
    callbacks!.onRequest(
      'item/tool/call',
      {
        threadId: 'real-host-thread',
        turnId: 'real-host-turn',
        callId,
        tool,
        arguments: arguments_,
      },
      callSignal,
    );
  const approvals = () =>
    transport.send.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'permission_request');
  const approve = async (
    pending: Promise<Record<string, unknown>>,
    before: number,
    decision: 'once' | 'deny' = 'once',
  ) => {
    await vi.waitFor(() => expect(approvals().length).toBeGreaterThan(before), { timeout: 10000 });
    resolvePending(approvals().at(-1)!.permId, decision, undefined, f.reservation.conversationId);
    return pending;
  };
  const text = (result: Record<string, unknown>) =>
    (result.contentItems as Array<{ text: string }>)[0]!.text;
  return { f, chat, native, transport, thread, names, call, approvals, approve, text };
}

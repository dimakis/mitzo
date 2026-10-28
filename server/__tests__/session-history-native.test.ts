import { afterAll, expect, it, vi } from 'vitest';
const setup = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-owned-native-'));
  for (const [key, value] of Object.entries({
    REPO_PATH: root,
    MITZO_INTERNAL_TOKEN_PATH: path.join(root, 'internal-token'),
    MITZO_CODEX_PRIVATE_DIR: path.join(root, 'private'),
  }))
    vi.stubEnv(key, value);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('Offline fixture forbids network/model calls');
    }),
  );
  return { root, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
});
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('Offline fixture forbids SDK/model calls');
  },
  listSessions: () => [],
}));
import { randomUUID } from 'node:crypto';
import { OrdinaryLocalCodexHostRuntime } from '../ordinary-local-codex-host-runtime.js';
import { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import { CodexAppServerClient, type CodexLifecycleTransport } from '../codex-app-server-client.js';
import { login, authenticateToken, setAuthRevocationStore, revokeAuthSession } from '../auth.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import * as workspaces from '../repository-workspace-runtime.js';
import * as library from '../agent-library-runtime.js';
import * as publication from '../telos-main-publication-runtime.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterAll(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  setup.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('runs history through the signed native owner without publication configuration, and withholds hidden/revoked targets', async () => {
  const runtimeChecks = vi.spyOn(OrdinaryLocalCodexHostRuntime.prototype, 'assertCurrentSync');
  const f = await ownedRuntimeFixture(cleanups, {
    chatRoute: true,
    tools: [
      { id: 'mitzo:SearchPastSessions', version: 1 },
      { id: 'mitzo:ReadPastSession', version: 1 },
    ],
  });
  const chat = await import('../chat.js');
  const native = await import('../codex-chat-session.js');
  setAuthRevocationStore(chat.eventStore);
  vi.spyOn(workspaces, 'getRepositoryWorkspaces').mockReturnValue(f.workspace);
  vi.spyOn(library, 'getAgentLibrary').mockReturnValue(f.library);
  vi.spyOn(publication, 'getTelosMainPublicationRuntime').mockReturnValue(undefined);
  f.detach();
  const auth = (await authenticateToken((await login(process.env.AUTH_PASSPHRASE!))!))!;
  cleanups.push(bindAgentLibraryTransport(f.dependencies.operatorConnectionId, auth));
  let lifecycle!: CodexLifecycleTransport;
  const original = f.rpc.request.getMockImplementation()!;
  f.rpc.request.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'thread/start') {
      const names = (params?.dynamicTools as Array<{ name: string }>).map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(['SearchPastSessions', 'ReadPastSession']));
      return { thread: { id: 'history-thread' }, model: 'fixture-model', modelProvider: 'openai' };
    }
    if (method === 'turn/start') return { turn: { id: 'history-turn' } };
    return original(method);
  });
  vi.spyOn(CodexAppServerClient, 'launchIsolated').mockImplementation((_home, _base, callbacks) => {
    lifecycle = callbacks!;
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
  const started = await chat.startOwnedLocalCodexCommand(
    { send: vi.fn(), isOpen: () => true },
    clientId,
    {
      command: f.request,
      reservation: f.reservation,
      commandId: f.request.clientMsgId,
      operatorConnectionId: f.dependencies.operatorConnectionId,
      ownerConnectionId: f.dependencies.operatorConnectionId,
      signal: new AbortController().signal,
    },
  );
  expect(started.dispatched).toBe(true);
  await vi.waitFor(() =>
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1),
  );
  for (let index = 0; index < 100; index++)
    chat.eventStore.upsertSession({
      sessionId: `search-cost-${index}`,
      conversationSource: 'mitzo',
      summary: 'Unrelated public summary',
    });
  chat.eventStore.upsertSession({
    sessionId: 'history-target',
    conversationSource: 'mitzo',
    summary: 'Prior project',
  });
  chat.eventStore.append('history-target', 'user_message', {
    text: 'Public old request',
    privateField: 'private payload',
  });
  chat.eventStore.append('history-target', 'block_delta', {
    blockType: 'thinking',
    delta: 'private reasoning marker',
  });
  chat.eventStore.append('history-target', 'block_delta', {
    blockType: 'text',
    delta: 'Public old answer',
  });
  chat.eventStore.upsertSession({
    sessionId: 'hidden-target',
    conversationSource: 'mitzo',
    summary: 'Hidden project',
  });
  chat.eventStore.hideSession('hidden-target');
  const invoke = async (tool: string, input: Record<string, unknown>) => {
    const response = await lifecycle.onRequest(
      'item/tool/call',
      {
        threadId: 'history-thread',
        turnId: 'history-turn',
        callId: randomUUID(),
        namespace: null,
        tool,
        arguments: input,
      },
      new AbortController().signal,
    );
    const text = (response.contentItems as Array<{ text: string }>)[0].text;
    return { response, text, value: response.success ? JSON.parse(text) : undefined };
  };
  runtimeChecks.mockClear();
  const unmatched = await invoke('SearchPastSessions', { query: 'unmatchable-needle' });
  expect(unmatched.response.success).toBe(true);
  expect(unmatched.value.sessions).toEqual([]);
  // A bounded summary search must not fan out through thousands of full
  // native runtime/credential/workspace fences while blocking other chats.
  expect(runtimeChecks.mock.calls.length).toBeLessThan(1000);
  const searched = await invoke('SearchPastSessions', { query: 'Prior project' });
  expect(searched.response.success).toBe(true);
  expect(searched.value.sessions).toMatchObject([
    { conversationId: 'history-target', summary: 'Prior project' },
  ]);
  const read = await invoke('ReadPastSession', { conversationId: 'history-target' });
  expect(read.response.success).toBe(true);
  expect(read.value.entries.map((entry: { text: string }) => entry.text)).toEqual([
    'Public old request',
    'Public old answer',
  ]);
  expect(read.text).not.toContain('private');
  expect(
    (await invoke('ReadPastSession', { conversationId: 'hidden-target' })).response.success,
  ).toBe(false);
  expect(
    (await invoke('ReadPastSession', { conversationId: 'unregistered-target' })).response.success,
  ).toBe(false);
  chat.eventStore.registerInternalSdkExecution({
    sdkSessionId: 'internal-target',
    parentSessionId: f.reservation.conversationId,
    operationId: 'history-fixture-internal',
    purpose: 'web_search',
    cwd: setup.root,
  });
  expect(
    (await invoke('ReadPastSession', { conversationId: 'internal-target' })).response.success,
  ).toBe(false);
  const readEvents = chat.eventStore.getEventsAfter.bind(chat.eventStore);
  vi.spyOn(chat.eventStore, 'getEventsAfter').mockImplementationOnce((id, after, limit) => {
    const result = readEvents(id, after, limit);
    chat.eventStore.hideSession(id);
    return result;
  });
  const hiddenDuringRead = await invoke('ReadPastSession', { conversationId: 'history-target' });
  expect(hiddenDuringRead.response.success).toBe(false);
  expect(hiddenDuringRead.text).not.toContain('Public old');
  revokeAuthSession(auth);
  // The existing host bridge closes on logout before another tool callback can
  // reach any adapter; it deliberately rejects rather than delivering a result.
  await expect(invoke('SearchPastSessions', { query: 'project' })).rejects.toThrow(
    'Owned Codex lifecycle unavailable',
  );
  expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
}, 20000);

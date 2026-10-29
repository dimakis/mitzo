import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexConversationStore } from '../codex-conversation-store.js';
import type { EventStore } from '../event-store.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';

vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}), getMcpConfigPaths: () => [] }));
vi.mock('../connections-runtime.js', () => ({ getConnectionsRuntime: () => null }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('No model calls');
  },
}));

const resources = {
  stores: [] as EventStore[],
  natives: [] as CodexConversationStore[],
  roots: [] as string[],
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  vi.restoreAllMocks();
  resources.stores.splice(0).forEach((store) => store.close());
  resources.natives.splice(0).forEach((store) => store.close());
  resources.roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  'composes the real OpenShell driver, admission, adapter and native FIFO across lost completion and cold recovery (API=%s)',
  async (api) => {
    vi.resetModules();
    const root = mkdtempSync(join(tmpdir(), 'mitzo-openshell-completion-'));
    resources.roots.push(root);
    vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', root);
    vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '0');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('Offline fixture forbids network');
      }),
    );
    const { openCodexChat, getCodexConversationStore, getCodexRuntime } =
      await import('../codex-chat-session.js');
    const native = getCodexConversationStore();
    resources.natives.push(native);
    const { ownedOpenShellFixture } = await import('./fixtures/owned-openshell-runtime.js');
    const f = ownedOpenShellFixture(resources, true, undefined, undefined, {
      api,
      nativeStore: native,
    });
    writeFileSync(join(root, 'policy.yaml'), 'offline: true\n');
    f.owners.config.policy = join(root, 'policy.yaml');
    const { OpenShellRuntimeManager } = await import('../openshell-runtime.js');
    // Only sandbox/provider effects are synthetic. The application selects and
    // fences them through the genuine OpenShell driver and admission capability.
    const ensure = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'ensure')
      .mockResolvedValue(f.artifact.runtime);
    vi.spyOn(OpenShellRuntimeManager.prototype, 'verifyKnowledgeRuntime').mockResolvedValue({});
    vi.spyOn(OpenShellRuntimeManager.prototype, 'compileContext').mockResolvedValue({
      type: 'boot_context',
      scope: 'sandbox',
      sourceCount: 0,
      tokenCount: 0,
      tokenBudget: 12000,
      sources: [],
      included: [],
      trimmed: [],
      fullMarkdown: '',
    });
    vi.spyOn(OpenShellRuntimeManager.prototype, 'inspectTaskCapabilities').mockResolvedValue({
      mgmtCli: false,
      meetingPrep: false,
      gws: false,
    });
    vi.spyOn(OpenShellRuntimeManager.prototype, 'observeContract').mockResolvedValue({
      resourceVersion: 'offline-generation',
      policy: {},
      attestation: { basePolicy: {}, effectivePolicyHash: 'offline', providers: [] },
      approvedGrantableProviders: [],
      requiredServiceEnvironment: [],
    });
    const { CodexAppServerClient } = await import('../codex-app-server-client.js');
    let callbacks!: CodexLifecycleTransport;
    let turns = 0;
    const methods: string[] = [];
    let outcome = 'inProgress';
    const rpc = {
      initialize: vi.fn(async () => {}),
      close: vi.fn(),
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        methods.push(method);
        if (method === 'config/read') return { config: {} };
        if (method === 'thread/start' || method === 'thread/resume')
          return { thread: { id: 'remote-thread' }, model: 'first', modelProvider: 'openshell' };
        if (method === 'turn/start') {
          const id = `remote-turn-${++turns}`;
          callbacks.onNotification('turn/started', { threadId: 'remote-thread', turn: { id } });
          return { turn: { id } };
        }
        if (method === 'thread/turns/list') {
          expect(params.threadId).toBe('remote-thread');
          return { data: [{ id: 'remote-turn-1', status: outcome }], nextCursor: null };
        }
        return {};
      }),
    };
    const launch = vi
      .spyOn(CodexAppServerClient, 'launchOpenShell')
      .mockImplementation((_runtime, _env, cb) => {
        callbacks = cb!;
        return rpc as never;
      });
    const controller = new AbortController();
    const session = { cwd: f.meta.cwd, mode: 'agent', abortController: controller } as Parameters<
      typeof openCodexChat
    >[0]['session'];
    let query: Awaited<ReturnType<typeof openCodexChat>> | undefined;
    cleanups.push(() => query?.close());
    const dispatch: typeof f.owners.dispatch = async (input) => {
      if (query) {
        await getCodexRuntime(session)!.send({
          id: input.commandId,
          prompt: input.payload.text,
          model: input.expected.selection.model,
          reasoningEffort: input.expected.selection.thinking,
        });
        return;
      }
      query = await openCodexChat({
        conversationId: 'session',
        messageId: input.commandId,
        binding: input.account,
        profile: input.profile,
        session,
        registry: { findBySessionId: () => undefined, get: () => undefined } as never,
        prompt: input.payload.text,
        systemPrompt: input.payload.systemPrompt,
        model: input.expected.selection.model,
        reasoningEffort: input.expected.selection.thinking,
        agentProfile: input.expected.agentProfile,
        ordinaryWorkspace: input.workspace as never,
        ownedOpenShell: input.admission,
        resume: input.resume,
        eventStore: f.events,
        env: {},
        mcpServers: {},
      });
    };
    f.dispatch.mockImplementation(dispatch);
    await f.driver.admitPreparedFirst(f.preparationOperationId!, f.meta, f.command('first'));
    const original = native.readArtifactRuntime('session', f.account);
    await f.driver.admit(f.meta, f.command('second'));
    expect(turns).toBe(1);
    callbacks.onClose(new Error('Local transport client exited; remote agent may still run'));
    expect(native.commandLifecycle('session', f.account, 'first').state).toBe('ambiguous_effect');
    const runtime = getCodexRuntime(session)!;
    await expect(runtime.acknowledgeRecovery()).rejects.toThrow(/active/);
    expect(turns).toBe(1);
    outcome = 'completed';
    await runtime.acknowledgeRecovery();
    expect(native.commands('session', f.account).map(({ id, status }) => ({ id, status }))).toEqual(
      [
        { id: 'first', status: 'completed' },
        { id: 'second', status: 'running' },
      ],
    );
    callbacks.onNotification('turn/completed', {
      threadId: 'remote-thread',
      turn: { id: 'remote-turn-2', status: 'completed' },
    });
    await vi.waitFor(() =>
      expect(native.commandStatus('session', f.account, 'second')).toBe('completed'),
    );
    query!.close();
    query = undefined;
    f.driver.close();
    const { OrdinaryOpenShellCodexOwnedRuntime } =
      await import('../ordinary-openshell-codex-owned-runtime.js');
    const cold = new OrdinaryOpenShellCodexOwnedRuntime({
      ...f.owners,
      resume: true,
      dispatch,
      dispatchContinuation: dispatch,
    });
    cleanups.push(() => cold.close());
    await cold.admit(f.meta, f.command('third'));
    expect(turns).toBe(3);
    expect(native.readArtifactRuntime('session', f.account)).toEqual(original);
    expect(native.read('session', f.account).threadId).toBe('remote-thread');
    expect(launch).toHaveBeenCalledTimes(3); // initial, reconnect, fresh cold owner
    expect(ensure).toHaveBeenCalledTimes(1); // cold adoption cannot allocate a replacement
    expect(methods.filter((method) => method === 'turn/start')).toHaveLength(3);
    expect(f.events.getOrdinaryOpenShellCommandAdmission('third')?.state).toBe('consumed');
  },
);

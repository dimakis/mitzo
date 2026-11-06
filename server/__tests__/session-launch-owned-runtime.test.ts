import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, homedir: () => `${actual.tmpdir()}/mitzo-launch-offline-home` };
});

const services = vi.hoisted(() => ({ workspace: undefined as unknown }));
vi.mock('../repository-workspace-runtime.js', async (original) => ({
  ...(await original<object>()),
  getOrdinaryWorkspaces: () => services.workspace,
}));
vi.mock('../internal-token.js', () => ({
  INTERNAL_TOKEN: 'offline-session-launch',
  isValidInternalToken: () => false,
  createSignalCallbackToken: () => 'offline-callback',
  revokeSignalCallbackToken() {},
  isValidSignalCallbackToken: () => false,
}));
vi.mock('../mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
  loadFromFile: () => ({}),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('Real model execution forbidden');
  },
}));
vi.mock('../auto-rename.js', () => ({
  shouldAutoRename: () => {
    throw Error('Model naming forbidden');
  },
}));
vi.mock('../notify.js', () => ({ sendTurnCompleteNotification: vi.fn(async () => {}) }));
vi.mock('../pushover.js', () => ({ sendTurnCompleteNotification: vi.fn(async () => {}) }));
vi.mock('../goal-client.js', () => ({
  createGoal: vi.fn(async () => null),
  reportUsage: vi.fn(async () => {}),
  deriveGoalTitle: () => 'Offline',
}));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([
  'normal',
  'before-reservation',
  'after-reservation',
  'before-dispatch',
  'remove-prepared',
] as const)(
  'starts or resumes real ordinary ownership exactly once after %s',
  async (stage) => {
    vi.resetModules();
    for (const name of [
      'CODEX_HOME',
      'MITZO_KEYCHAIN_HELPER',
      'MITZO_KEYCHAIN_CONNECTIONS_DIR',
      'MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE',
      'MITZO_KNOWLEDGE_LIBRARY_CONFIG',
      'MITZO_WORKSPACE_RUNTIME_CONFIG',
    ])
      vi.stubEnv(name, undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('External network forbidden');
      }),
    );
    const { ownedOrdinaryRuntimeFixture } =
      await import('./fixtures/owned-ordinary-workspace-runtime.js');
    const f = await ownedOrdinaryRuntimeFixture(cleanups, {
      chatRoute: true,
      tools: [{ id: 'mitzo:AgentCommunication', version: 1 }],
    });
    services.workspace = f.workspaces;
    const chat = await import('../chat.js');
    const { closeAgentLibrary } = await import('../agent-library-runtime.js');
    cleanups.push(() => {
      closeAgentLibrary();
      chat.eventStore.close();
    });
    const native = await import('../codex-app-server-client.js');
    const { revokeAuthSession } = await import('../auth.js');
    let lifecycle: CodexLifecycleTransport | undefined;
    let closed = false;
    const raw = f.first.rpc.request.getMockImplementation()!;
    f.first.rpc.request.mockImplementation(async (method: string) => {
      if (method === 'thread/start' || method === 'thread/resume')
        return {
          thread: { id: 'launch-thread' },
          model: 'fixture-model',
          modelProvider: 'openai',
        } as never;
      if (method === 'turn/start') return { turn: { id: 'launch-turn' } } as never;
      if (method === 'turn/interrupt') return {} as never;
      return raw(method);
    });
    f.first.rpc.close.mockImplementation(() => {
      if (!closed) {
        closed = true;
        lifecycle?.onClose?.(Error('Offline close'));
      }
    });
    const launch = vi
      .spyOn(native.CodexAppServerClient, 'launchIsolated')
      .mockImplementation((_home, _env, callbacks) => {
        lifecycle = callbacks;
        return f.first.rpc as unknown as ReturnType<
          typeof native.CodexAppServerClient.launchIsolated
        >;
      });
    for (const method of ['launch', 'launchOpenShell'] as const)
      vi.spyOn(native.CodexAppServerClient, method).mockImplementation(() => {
        throw Error('Alternate provider forbidden');
      });
    const { SessionLaunchStore } = await import('../session-launch-store.js');
    const { SessionLaunchService } = await import('../session-launch-service.js');
    const { createSessionLaunchPort } = await import('../session-launch-runtime.js');
    const { withAgentLibraryRecoveryAuthorization, captureAgentLibraryAuthorization } =
      await import('../agent-library-transport.js');
    const store = new SessionLaunchStore(join(f.configuredWorkspace, '.mitzo', 'events.db'));
    cleanups.push(() => store.close());
    const port = createSessionLaunchPort();
    const originalStart = port.start;
    let startupError: unknown;
    vi.spyOn(port, 'start').mockImplementation(async (...args) => {
      try {
        return await originalStart(...args);
      } catch (error) {
        startupError = error;
        throw error;
      }
    });
    const service = new SessionLaunchService(store, port);
    const proposal = store.propose({
      operatorId: 'user',
      sourceSessionId: f.first.receipt.sessionId,
      requestId: randomUUID(),
      title: 'Reviewed ordinary launch',
      prompt: 'Write the reviewed report.',
      configuration: {
        version: 1,
        runtime: {
          version: 1,
          account: {
            accountId: f.binding.accountId,
            model: 'fixture-model',
            reasoningEffort: 'low',
          },
          accountReference: f.first.receipt.settings.binding.account,
          agentProfile: { profileId: f.agentProfile.profileId, revision: f.agentProfile.revision },
          execution: { location: 'local', targetId: 'ordinary-fixture-local' },
        },
        mode: 'agent',
        isolation: true,
        repositoryWorkspaceId: null,
        contextBlocks: [],
        extraTools: [],
      },
    });
    const edits = {
      title: proposal.title,
      prompt: proposal.prompt,
      configuration: proposal.configuration,
    };
    const authority = {
      operatorConnectionId: f.operatorConnectionId,
      authSessionId: f.auth.id,
      signal: f.signal.signal,
      assertCurrent: () => {
        f.signal.signal.throwIfAborted();
      },
    };
    let childId: string | null = null;
    try {
      expect(launch).not.toHaveBeenCalled();
      let created: Awaited<ReturnType<typeof service.approve>>;
      if (stage === 'before-reservation') {
        store.approve(proposal.proposalId, 'user', edits, proposal.revision);
        store.claimStart(proposal.proposalId);
        created = await service.refresh(proposal.proposalId, 'user', authority);
      } else {
        const interruption =
          stage === 'after-reservation'
            ? vi
                .spyOn(chat.eventStore, 'prepareOrdinaryWorkspaceSession')
                .mockImplementationOnce(() => {
                  throw Error('Offline interruption after reservation');
                })
            : stage === 'before-dispatch' || stage === 'remove-prepared'
              ? vi
                  .spyOn(
                    await import('../ordinary-scoped-command.js'),
                    'dispatchOwnedOrdinaryCommand',
                  )
                  .mockRejectedValueOnce(Error('Offline interruption before dispatch'))
              : undefined;
        created = await withAgentLibraryRecoveryAuthorization(
          f.auth,
          async (operatorConnectionId) =>
            service.approve(proposal.proposalId, 'user', edits, proposal.revision, {
              ...authority,
              operatorConnectionId: operatorConnectionId!,
            }),
        );
        interruption?.mockRestore();
      }
      if (stage === 'remove-prepared') {
        childId = created.childSessionId;
        expect(childId).toBeTruthy();
        expect(created.state).toBe('uncertain');
        const { getCodexConversationStore } = await import('../codex-chat-session.js');
        const { createSessionRemovalRuntime } = await import('../session-removal-runtime.js');
        const { SessionResourceRemovalService } = await import('../session-resource-removal.js');
        const nativeStore = getCodexConversationStore();
        expect(nativeStore.hasConversation(childId!)).toBe(false);
        const commands = vi.spyOn(nativeStore, 'commands');
        const stopped = vi.spyOn(nativeStore, 'assertRepositoryTaskStopped');
        const removalRuntime = createSessionRemovalRuntime({
          events: chat.eventStore,
          registry: chat.registry,
          tasks: { getTree: () => [], getTelosExecutionBinding: () => null },
          native: () => nativeStore,
          stop: chat.stopChat,
        });
        const removal = new SessionResourceRemovalService({
          ...removalRuntime,
          store: chat.eventStore.removals,
          cancelPrompts: async () => {},
        });
        const preparedRemoval = await removal.prepare(childId!, authority.assertCurrent);
        expect(preparedRemoval.preparationCompleted).toBe(true);
        removalRuntime.assertSettled(childId!);
        expect(commands).not.toHaveBeenCalled();
        expect(stopped).not.toHaveBeenCalled();
        const metadata = vi.spyOn(chat.eventStore, 'prepareOrdinaryWorkspaceSession');
        const title = vi.spyOn(chat.eventStore, 'upsertSession');
        await expect(
          service.resume(proposal.proposalId, 'user', created.revision, authority),
        ).rejects.toThrow(/being removed/);
        expect(metadata).not.toHaveBeenCalled();
        expect(title).not.toHaveBeenCalled();
        removal.keep(childId!, preparedRemoval.operationId, authority.assertCurrent);
        chat.eventStore.hideSession(childId!);
        await expect(
          service.resume(proposal.proposalId, 'user', created.revision, authority),
        ).rejects.toThrow(/hidden/);
        expect(metadata).not.toHaveBeenCalled();
        expect(title).not.toHaveBeenCalled();
        expect(launch).not.toHaveBeenCalled();
        return;
      }
      if (stage !== 'normal') {
        expect(created.state).toBe('uncertain');
        expect(launch).not.toHaveBeenCalled();
        const originalWorkspace = f.workspaces.getOrdinaryWorkspaceForOperation(
          created.allocationId!,
        );
        const originalCommandId = created.commandId;
        const resumed = await withAgentLibraryRecoveryAuthorization(
          f.auth,
          async (operatorConnectionId) =>
            service.resume(proposal.proposalId, 'user', created.revision, {
              ...authority,
              operatorConnectionId: operatorConnectionId!,
            }),
        );
        expect(resumed.allocationId).toBe(created.allocationId);
        expect(resumed.commandId).toBe(originalCommandId);
        if (originalWorkspace)
          expect(resumed.childSessionId).toBe(originalWorkspace.conversationId);
        created = resumed;
      }
      childId = created.childSessionId;
      expect(
        childId,
        startupError instanceof Error ? startupError.stack : String(created.error),
      ).toBeTruthy();
      expect(childId).not.toBe(f.first.receipt.sessionId);
      expect(
        created.state,
        startupError instanceof Error ? startupError.stack : created.error,
      ).toMatch(/created|running/);
      await vi.waitFor(() =>
        expect(
          f.first.rpc.request.mock.calls.filter(([method]) => method === 'turn/start'),
        ).toHaveLength(1),
      );
      const running = await service.refresh(proposal.proposalId, 'user', authority);
      expect(running.state, running.error).toBe('running');
      expect(chat.eventStore.getSession(childId!)?.ordinaryWorkspaceId).toBeTruthy();
      expect(chat.eventStore.getSession(childId!)?.cwd).not.toBe(f.first.reserved.directory);
      expect(
        chat.eventStore.getOrdinaryWorkspaceSessionPreparation(running.allocationId!)
          ?.firstCommandId,
      ).toBe(running.commandId);
      expect(chat.eventStore.getOrdinaryCommandAdmission(running.commandId!)?.state).toBe(
        'consumed',
      );
      expect(chat.registry.findBySessionId(childId!)?.session.sessionAllowList.size).toBe(0);
      const retainedOwner = chat.registry.findBySessionId(childId!)!.session.ownerConnectionId;
      expect(retainedOwner).toMatch(/^native-host:/);
      expect(captureAgentLibraryAuthorization(retainedOwner).auth.id).toBe(f.auth.id);
      expect(store.forSession(childId!, 'user')).toHaveLength(1);
      expect(
        await service.approve(proposal.proposalId, 'user', edits, proposal.revision, authority),
      ).toEqual(running);
      expect(launch).toHaveBeenCalledOnce();
      expect(f.forbidden).not.toHaveBeenCalled();
    } finally {
      revokeAuthSession(f.auth);
      if (childId)
        await vi.waitFor(() => expect(chat.registry.findBySessionId(childId!)).toBeNull());
    }
  },
  20000,
);

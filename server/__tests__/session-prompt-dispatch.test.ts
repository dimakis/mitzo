import { expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import type { SessionRegistry, ConnectionRegistry } from '@mitzo/harness';
import type { SessionPromptDelivery } from '../session-prompt-store.js';
import { createSessionPromptPort, sessionPromptText } from '../session-prompt-dispatch.js';

const f = vi.hoisted(() => ({
  dispatch: vi.fn(async () => ({ dispatched: true })),
  binding: {} as Record<string, unknown>,
  selection: {} as Record<string, unknown>,
  authorized: true,
  native: { captureInterruptTarget: vi.fn(), interruptIfCurrent: vi.fn() },
  current: vi.fn(),
  release: vi.fn(),
  live: undefined as unknown,
  workspace: {
    id: 'workspace',
    conversationId: 'worker',
    directory: '/task',
    hostReservation: { taskRoot: '/tasks' },
  } as {
    id: string;
    conversationId: string;
    directory?: string;
    hostReservation?: { taskRoot: string };
    sandbox?: boolean;
  },
}));
vi.mock('../auth.js', () => ({
  isAuthSessionCurrent: () => f.authorized,
  hasPersistentRevocationAuthority: () => true,
  isAuthenticatedOperatorSessionId: () => false,
}));
vi.mock('../codex-chat-session.js', () => ({ getCodexRuntime: () => f.native }));
vi.mock('../agent-library-transport.js', () => ({ bindAgentLibraryTransport: () => f.release }));
vi.mock('../ordinary-scoped-command.js', () => ({ dispatchOwnedOrdinaryCommand: f.dispatch }));
vi.mock('../ordinary-local-codex-entry.js', () => ({
  ordinaryRepositoryRuntimeInventory: () => ({
    result: { capabilityRevision: 'current-capabilities' },
    catalog: { resolve: () => ({ status: 'compatible', binding: f.binding }) },
  }),
}));
vi.mock('../agent-library-runtime.js', () => ({ getAgentLibrary: () => ({}) }));
vi.mock('../ordinary-codex-agent-profile.js', () => ({
  readOrdinaryCodexAgentProfile: () => ({ profileId: 'default' }),
}));
vi.mock('../repository-workspace-runtime.js', () => ({
  getRepositoryWorkspaces: () => ({ get: () => f.workspace }),
  getOrdinaryWorkspaces: () => ({ getOrdinaryWorkspace: () => f.workspace }),
}));
vi.mock('../ordinary-openshell-codex-entry-owner.js', () => ({
  loadOrdinaryOpenShellCodexTarget: () => ({ config: { workdir: '/sandbox/task' } }),
}));
vi.mock('../chat.js', () => ({
  BASE_REPO: '/app',
  canResumeOwnedLocalCodexDriver: () => true,
  canResumeOwnedLocalResponsesDriver: () => true,
}));
vi.mock('../ordinary-local-vertex-entry.js', () => ({
  canResumeOwnedLocalVertexDriver: () => true,
}));
vi.mock('../ordinary-openshell-codex-entry.js', () => ({
  canResumeOwnedOpenShellCodexDriver: () => true,
}));

function fixture(harness = 'codex', location = 'local') {
  f.authorized = true;
  f.dispatch.mockClear();
  f.current.mockClear();
  f.release.mockClear();
  f.live = undefined;
  f.workspace =
    location === 'openshell'
      ? { id: 'workspace', conversationId: 'worker', sandbox: true }
      : {
          id: 'workspace',
          conversationId: 'worker',
          directory: '/task',
          hostReservation: { taskRoot: '/tasks' },
        };
  f.binding = {
    version: 2,
    account: {
      accountId: 'recipient-account',
      provider: 'fixture-provider',
      profileRevision: 'p1',
    },
    harness: { implementation: harness },
    execution: { location, targetId: 'original-target', targetRevision: 'r1' },
  };
  f.selection = {
    version: 1,
    model: 'recipient-model',
    thinking: null,
    agent: { kind: 'builtin', profileId: 'default', revision: 1 },
    permission: { mode: 'agent', revision: 0 },
    context: { source: 'none', revision: null },
  };
  const events = {
    getSession: () => ({
      sessionId: 'worker',
      repositoryWorkspaceId: 'workspace',
      accountBinding: { accountId: 'recipient-account' },
      mode: 'agent',
      cwd: location === 'openshell' ? '/sandbox/task' : '/task',
      executionPhase: 'TERMINAL',
    }),
    removals: { assertAdmissible: vi.fn() },
    getSessionRuntimeBinding: () => f.binding,
    getSessionEvents: () => [],
    getLatestOrdinaryCommandAdmission: () => ({
      binding: f.binding,
      selection: f.selection,
      state: 'consumed',
      workspace: {
        workspaceId: 'workspace',
        cwd: location === 'openshell' ? '/sandbox/task' : '/task',
      },
    }),
    getOrdinaryCommandAdmission: () =>
      f.dispatch.mock.calls.length ? { state: 'consumed' } : undefined,
    readOrdinaryCommandExecutionEvidence: () =>
      f.dispatch.mock.calls.length ? { state: 'consumed' } : undefined,
    getSendCommand: () => (f.dispatch.mock.calls.length ? { sessionId: 'worker' } : undefined),
    hasUncertainOrdinaryCommand: () => false,
  } as unknown as EventStore;
  const registry = {
    findBySessionId: () => f.live,
    isUserClose: () => false,
    isClosingOut: () => false,
  } as unknown as SessionRegistry;
  const connections = { broadcast: vi.fn() } as unknown as ConnectionRegistry;
  const delivery: SessionPromptDelivery = {
    id: 'message',
    commandId: 'session-prompt:message',
    kind: 'timer',
    timerId: 'timer',
    timerRevision: 1,
    manual: false,
    senderSessionId: null,
    recipientSessionId: 'worker',
    text: 'Check PR #7',
    workId: null,
    state: 'pending',
    error: null,
    createdAt: 0,
    auth: { id: 'login', expiresAt: Date.now() + 100000 },
  };
  return {
    events,
    registry,
    connections,
    delivery,
    port: createSessionPromptPort({
      eventStore: events,
      sessionRegistry: registry,
      connRegistry: connections,
    }),
  };
}
it('forwards the exact idle SDK sender fence into ordinary admission', async () => {
  const h = fixture('claude-sdk');
  f.live = {
    clientId: 'sdk',
    session: {
      ordinaryRuntimeOwner: { authSessionId: 'login' },
      transport: { send() {}, isOpen: () => true },
    },
  };
  let allowed = true;
  await h.port.deliverOrdinary(
    { sessionId: 'worker', commandId: 'peer', auth: h.delivery.auth, text: 'Exact peer' },
    new AbortController().signal,
    () => {
      if (!allowed) throw Error('Sender revoked');
    },
  );
  const dispatch = f.dispatch.mock.calls[0]?.[0] as unknown as { assertCurrent?: () => void };
  expect(dispatch.assertCurrent).toBeTypeOf('function');
  allowed = false;
  expect(dispatch.assertCurrent).toThrow('Sender revoked');
});

it.each([
  'current',
  'successor',
  'claimed',
  'settled',
  'foreign',
  'revoked',
  'contributor_changed',
  'binding_changed',
])('controls only the original ordinary turn and never replays a Stop: %s', async (scenario) => {
  const h = fixture();
  vi.spyOn(h.events, 'getSendCommand').mockReturnValue({ sessionId: 'worker' } as never);
  const current = vi.fn(() => {
    if (current.mock.calls.length !== 1) return;
    if (scenario === 'contributor_changed')
      queueMicrotask(() => {
        vi.spyOn(h.events, 'getSessionEvents').mockReturnValue([
          {
            type: 'contributor_execution',
            payload: {
              childSessionId: 'worker',
              coordinatorSessionId: 'coordinator',
              deliveryId: 'delivery',
              seatId: 'seat',
              claimToken: 'claim',
              idempotencyKey: 'key',
            },
          },
        ] as never);
        Object.assign(h.events, {
          getUnsettledSymposiumSeatExecutions: () => [{ claimToken: 'claim' }],
        });
      });
    if (scenario === 'binding_changed')
      queueMicrotask(() => {
        vi.spyOn(h.events, 'getSession').mockReturnValue({
          accountBinding: { accountId: 'changed' },
        } as never);
      });
  });
  const receipt = vi.fn(() => (scenario === 'claimed' ? { retained: true } : undefined));
  const settled = vi.fn(() => (scenario === 'settled' ? ('completed' as const) : undefined));
  const port = createSessionPromptPort({
    eventStore: h.events,
    sessionRegistry: h.registry,
    connRegistry: h.connections,
    ordinaryCommands: () =>
      ({ targetedInterruptReceipt: receipt, settledCommandOutcome: settled }) as never,
  });
  f.live = { session: { ownedLocalAuthSessionId: scenario === 'foreign' ? 'other' : 'login' } };
  const captured = { commandId: scenario === 'successor' ? 'later-command' : 'original' };
  f.native.captureInterruptTarget.mockReset().mockReturnValue(captured);
  f.native.interruptIfCurrent.mockReset().mockResolvedValue({ status: 'claimed' });
  f.authorized = scenario !== 'revoked';
  try {
    const result = port.stopOrdinary!(
      h.delivery.auth,
      'worker',
      'original',
      'stop-original',
      current,
    );
    if (scenario === 'revoked') await expect(result).rejects.toThrow('authorization');
    else if (scenario === 'contributor_changed')
      await expect(result).rejects.toThrow('contributor panel');
    else if (scenario === 'binding_changed')
      await expect(result).rejects.toThrow('custody changed');
    else
      await expect(result).resolves.toBe(
        {
          current: 'requested',
          successor: 'uncertain',
          claimed: 'uncertain',
          settled: 'settled',
          foreign: 'unavailable',
        }[scenario],
      );
    if (scenario === 'current')
      expect(f.native.interruptIfCurrent).toHaveBeenCalledExactlyOnceWith(
        'stop-original',
        captured,
      );
    else expect(f.native.interruptIfCurrent).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  } finally {
    port.close();
    h.port.close();
    f.authorized = true;
  }
});

it('observes ordinary collaboration capability without binding or dispatching and refuses foreign live owners', async () => {
  const fxt = fixture();
  const prompt = {
    sessionId: 'worker',
    commandId: 'read-only',
    text: '',
    auth: fxt.delivery.auth,
    settings: { binding: f.binding, selection: f.selection, repositoryWorkspaceId: 'workspace' },
  } as Parameters<NonNullable<typeof fxt.port.inspectCollaboration>>[0];
  await expect(fxt.port.inspectCollaboration!(prompt)).resolves.toBeUndefined();
  expect(f.dispatch).not.toHaveBeenCalled();
  f.live = { session: {}, clientId: 'foreign' };
  await expect(fxt.port.inspectCollaboration!(prompt)).rejects.toThrow('fresh Local Codex');
  expect(f.dispatch).not.toHaveBeenCalled();
  fxt.port.close();
});

it.each([
  ['codex', 'local'],
  ['codex', 'openshell'],
  ['claude-sdk', 'local'],
  ['gemini', 'local'],
  ['responses', 'local'],
])(
  'reuses the ordinary %s/%s dispatcher and preserves recipient settings without UI takeover',
  async (harness, location) => {
    const fxt = fixture(harness, location);
    await fxt.port.deliver(fxt.delivery, new AbortController().signal, f.current);
    expect(f.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'worker',
        continuation: true,
        reservation: expect.objectContaining({
          conversationId: 'worker',
          runtimeBinding: f.binding,
        }),
        command: expect.objectContaining({
          clientMsgId: 'session-prompt:message',
          selection: f.selection,
          runtime: expect.objectContaining({
            account: f.binding.account,
            targetId: 'original-target',
          }),
          payload: { text: expect.stringContaining('Scheduled prompt') },
        }),
      }),
    );
    expect(f.current).toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ ordinaryTurnLifecycle: expect.anything() }),
    );
    fxt.port.close();
    expect(f.release).toHaveBeenCalled();
  },
);
it('fences cancellation and logout after asynchronous preparation', async () => {
  const fxt = fixture();
  f.current.mockImplementation(() => {
    throw Error('Cancelled');
  });
  await expect(
    fxt.port.deliver(fxt.delivery, new AbortController().signal, f.current),
  ).rejects.toThrow('Cancelled');
  expect(f.dispatch).not.toHaveBeenCalled();
  f.current.mockReset();
  f.authorized = false;
  await expect(
    fxt.port.deliver(fxt.delivery, new AbortController().signal, f.current),
  ).rejects.toThrow(/authorization/i);
});

it('dispatches an explicitly requested first turn into the original silently prepared session', async () => {
  const fxt = fixture();
  const settings = {
    binding: f.binding,
    selection: f.selection,
    repositoryWorkspaceId: 'workspace',
  };
  fxt.events.getLatestOrdinaryCommandAdmission = () => undefined;
  fxt.events.getOrdinarySessionPreparationForConversation = () =>
    ({ allocationOperationId: 'original-allocation', firstCommandId: null }) as never;
  fxt.events.getOrdinaryConversationSettings = () => settings as never;
  const prompt = {
    sessionId: 'worker',
    commandId: 'explicit-group-command',
    auth: fxt.delivery.auth,
    text: 'Exact reviewed shared context\n\nExplicit question',
    settings,
    preparationOperationId: 'original-allocation',
    onQueryEvent: vi.fn(),
    turnLifecycle: { beforeDispatch: vi.fn(), accepted: vi.fn(), terminal: vi.fn() },
  };
  try {
    await fxt.port.deliverOrdinary(prompt as never, new AbortController().signal, f.current);
    expect(f.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionId: 'worker',
        commandId: prompt.commandId,
        continuation: false,
        preparationOperationId: 'original-allocation',
        onQueryEvent: prompt.onQueryEvent,
        ordinaryTurnLifecycle: expect.any(Object),
        command: expect.objectContaining({
          selection: f.selection,
          payload: { text: prompt.text },
        }),
      }),
    );
  } finally {
    fxt.port.close();
  }
});

it('keeps timers unable to start unused sessions and rejects changed prepared settings before dispatch', async () => {
  const fxt = fixture();
  fxt.events.getLatestOrdinaryCommandAdmission = () => undefined;
  fxt.events.getOrdinarySessionPreparationForConversation = () =>
    ({ allocationOperationId: 'original-allocation', firstCommandId: null }) as never;
  fxt.events.getOrdinaryConversationSettings = () =>
    ({ binding: f.binding, selection: f.selection, repositoryWorkspaceId: 'workspace' }) as never;
  await expect(
    fxt.port.deliver(fxt.delivery, new AbortController().signal, f.current),
  ).rejects.toThrow(/send a message/);
  await expect(
    fxt.port.deliverOrdinary(
      {
        sessionId: 'worker',
        commandId: 'explicit',
        auth: fxt.delivery.auth,
        text: 'Question',
        preparationOperationId: 'original-allocation',
        settings: {
          binding: f.binding,
          selection: { ...f.selection, model: 'changed' },
          repositoryWorkspaceId: 'workspace',
        },
      } as never,
      new AbortController().signal,
      f.current,
    ),
  ).rejects.toThrow();
  expect(f.dispatch).not.toHaveBeenCalled();
  fxt.port.close();
});
it('labels callbacks with source and work reference without making peer text human authority', () => {
  const fxt = fixture();
  const text = sessionPromptText({
    ...fxt.delivery,
    kind: 'agent',
    senderSessionId: 'worker',
    recipientSessionId: 'coordinator',
    workId: 'T7',
  });
  expect(text).toContain('worker');
  expect(text).toContain('T7');
  expect(text).toContain('no additional permissions');
});
it.each(['timer', 'agent'] as const)(
  'does not cold-resume a durably user-closed recipient for %s delivery',
  async (kind) => {
    const x = fixture();
    const meta = x.events.getSession('worker')!;
    vi.spyOn(x.events, 'getSession').mockReturnValue({ ...meta, closedBy: 'user' });
    x.delivery.kind = kind;
    await expect(x.port.inspect('worker', x.delivery.auth)).rejects.toThrow(/stopped|closed/i);
    await expect(
      x.port.deliver(x.delivery, new AbortController().signal, f.current),
    ).rejects.toThrow(/stopped|closed/i);
    expect(f.dispatch).not.toHaveBeenCalled();
  },
);
it('allows an explicitly reopened live owner while preserving the historical closure marker', async () => {
  const x = fixture();
  vi.spyOn(x.events, 'getSession').mockReturnValue({
    ...x.events.getSession('worker')!,
    closedBy: 'user',
  });
  f.live = {
    clientId: 'reopened-worker',
    session: {
      ordinaryRuntimeOwner: { authSessionId: 'login' },
      transport: { isOpen: () => true, send() {} },
    },
  };
  await expect(x.port.inspect('worker', x.delivery.auth)).resolves.toEqual({ busy: false });
});
it('continues an OpenShell repository whose workspace custody has a sandbox rather than a host checkout', async () => {
  const fxt = fixture('codex', 'openshell');
  f.workspace = { id: 'workspace', conversationId: 'worker', sandbox: true };
  await fxt.port.deliver(fxt.delivery, new AbortController().signal, f.current);
  expect(f.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      sandboxWorkdir: '/sandbox/task',
      reservation: expect.objectContaining({ taskRoot: '/app/.claude/repository-tasks' }),
    }),
  );
});
it('reconciles accepted delivery from retained evidence after its recipient changes workspace', () => {
  const x = fixture();
  const store = new EventStore(':memory:');
  try {
    const binding = {
      version: 2,
      account: { accountId: 'account', provider: 'openai-codex', profileRevision: 'profile' },
      harness: { implementation: 'codex' },
      execution: { location: 'local', targetId: 'mac', targetRevision: 'target' },
    } as const;
    const commandId = x.delivery.commandId;
    store.admitOrdinaryLocalCommand(
      {
        sessionId: 'worker',
        repositoryWorkspaceId: 'old',
        cwd: '/old',
        accountBinding: { ...binding.account, accountLabel: 'Offline', model: 'fixture' },
      },
      binding,
      {
        clientMsgId: commandId,
        requestFingerprint: 'original-fingerprint',
        selection: {
          version: 1,
          agent: { profileId: 'agent', revision: 1 },
          context: { source: 'none', revision: null },
          permission: { mode: 'agent', revision: 0 },
          model: 'fixture',
          thinking: null,
        },
        payload: {
          text: 'Check PR #7',
          intent: 'Check PR #7',
          systemPrompt: 'Selected instructions',
        },
      },
    );
    store.claimOrdinaryLocalCommandDispatch(commandId);
    store.completeOrdinaryLocalCommand(commandId);
    const transition = {
      version: 1 as const,
      preparationId: '34af2bdf-5fb4-4de0-b083-cf188163d891',
      runtimeId: 'runtime',
      source: {
        commandId,
        attempt: 1,
        threadId: 'thread',
        turnId: 'turn',
        generation: 0,
        callId: 'prepare',
        requestHash: 'a'.repeat(64),
        resultSha256: 'b'.repeat(64),
      },
      oldWorkspace: { kind: 'repository' as const, id: 'old', directory: '/old' },
      newWorkspace: {
        kind: 'repository' as const,
        id: 'new',
        directory: '/new',
        featureBranch: 'task/branch',
        baseOid: 'c'.repeat(40),
        taskIdentitySha256: 'd'.repeat(64),
      },
      consumedScopeSha256: 'e'.repeat(64),
      materializedRecordSha256: 'f'.repeat(64),
    };
    const reserved = store.reservePreparedRepositoryContinuation('worker', transition);
    store.commitPreparedRepositoryContinuation('worker', reserved.childCommandId, transition);
    store.finalizePreparedRepositoryContinuation(
      'worker',
      reserved.childCommandId,
      transition,
      () => {},
    );
    expect(() => store.getOrdinaryCommandAdmission(commandId)).toThrow(/durable session identity/);
    const port = createSessionPromptPort({
      eventStore: store,
      sessionRegistry: x.registry,
      connRegistry: x.connections,
    });
    expect(port.receipt(x.delivery)).toBe('accepted');
    expect(port.receipt({ ...x.delivery, recipientSessionId: 'different-session' })).toBe('absent');
  } finally {
    store.close();
  }
});

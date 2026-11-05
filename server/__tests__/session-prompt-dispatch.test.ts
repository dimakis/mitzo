import { expect, it, vi } from 'vitest';
import type { EventStore } from '../event-store.js';
import type { SessionRegistry, ConnectionRegistry } from '@mitzo/harness';
import type { SessionPromptDelivery } from '../session-prompt-store.js';
import { createSessionPromptPort, sessionPromptText } from '../session-prompt-dispatch.js';

const f = vi.hoisted(() => ({
  dispatch: vi.fn(async () => ({ dispatched: true })),
  binding: {} as Record<string, unknown>,
  selection: {} as Record<string, unknown>,
  authorized: true,
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
}));
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
    getSessionRuntimeBinding: () => f.binding,
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

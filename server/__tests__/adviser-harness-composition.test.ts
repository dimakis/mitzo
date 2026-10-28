import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  authorization: vi.fn(),
  prepare: vi.fn(),
  reserve: vi.fn(),
  prepareSession: vi.fn(),
  dispatch: vi.fn(),
  close: vi.fn(),
  resolve: vi.fn(),
  live: undefined as
    | undefined
    | { session: { abortController: AbortController; ordinaryRuntimeOwner: { close(): void } } },
  binding: {
    accountId: 'work',
    accountLabel: 'Gateway',
    provider: 'openai' as const,
    model: 'gpt-6-luna',
    profileRevision: 'https://selected.invalid:v1',
  },
  runtime: {
    version: 2 as const,
    account: {
      accountId: 'work',
      provider: 'openai' as const,
      profileRevision: 'https://selected.invalid:v1',
    },
    harness: { implementation: 'codex' as const },
    execution: {
      location: 'local' as const,
      targetId: 'selected-mac',
      targetRevision: 'target-v1',
    },
  },
}));
vi.mock('../agent-library-transport.js', () => ({
  captureAgentLibraryAuthorization: () => ({
    auth: { id: 'operator' },
    assertCurrent: mocks.authorization,
  }),
  readBuiltinAgentLibraryProfile: () => ({
    profileId: 'builtin',
    revision: 1,
    definition: {},
    contentHash: 'hash',
  }),
}));
vi.mock('../account-profiles.js', () => ({
  loadAccountProfiles: () => ({ resolve: mocks.resolve, validateModelSelection: () => {} }),
}));
vi.mock('../ordinary-local-codex-entry.js', () => ({
  ordinaryRepositoryRuntimeInventory: () => ({
    catalog: { resolve: () => ({ status: 'compatible', binding: mocks.runtime }) },
    result: {
      targets: [{ location: 'local', harness: 'codex', targetId: 'selected-mac' }],
      capabilityRevision: 'catalog-v1',
    },
  }),
}));
vi.mock('../ordinary-workspace-runtime.js', () => ({
  ordinaryWorkspaceTaskRoot: () => '/task-root',
}));
vi.mock('../repository-workspace-runtime.js', () => ({
  getOrdinaryWorkspaces: () => ({
    prepareOrdinaryWorkspace: mocks.prepare,
    reserveOrdinaryWorkspace: mocks.reserve,
  }),
}));
vi.mock('../chat.js', () => ({
  eventStore: { prepareOrdinaryWorkspaceSession: mocks.prepareSession },
  registry: { findBySessionId: () => mocks.live },
}));
vi.mock('../ordinary-scoped-command.js', () => ({ dispatchOwnedOrdinaryCommand: mocks.dispatch }));
import { createNativeAdviserSession } from '../adviser-harness-runtime.js';
const config = {
  model: 'gpt-6-luna',
  systemPrompt: 'Feature instructions',
  maxTokens: 4096,
  tools: [],
};
const request = {
  accountId: 'work',
  model: 'gpt-6-luna',
  messages: [{ role: 'user' as const, content: 'Reviewed' }],
};
const owner = {
  authSessionId: 'operator',
  operatorConnectionId: 'feature-operation',
  feature: { kind: 'terminal' as const, terminalId: 'term' },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockReturnValue(mocks.binding);
  mocks.live = undefined;
  mocks.prepare.mockResolvedValue({ preparationId: 'preparation', runtimeBinding: mocks.runtime });
  mocks.reserve.mockImplementation(async (input) => ({
    id: 'workspace',
    conversationId: 'task',
    directory: '/task-root/empty-task',
    hostReservation: { taskRoot: '/task-root' },
    preparationFingerprint: 'fingerprint',
    settings: input.settings,
  }));
  mocks.dispatch.mockImplementation(async (input) => {
    mocks.live = {
      session: {
        abortController: new AbortController(),
        ordinaryRuntimeOwner: {
          close: () => {
            mocks.close();
            input.onEnded();
          },
        },
      },
    };
    input.onQueryEvent({ type: 'message_start', sessionId: 'task', messageId: 'reply' });
    input.onQueryEvent({
      type: 'block_start',
      sessionId: 'task',
      messageId: 'reply',
      blockId: 'b',
      blockType: 'text',
    });
    input.onQueryEvent({
      type: 'block_delta',
      sessionId: 'task',
      messageId: 'reply',
      blockId: 'b',
      blockType: 'text',
      delta: 'Advice',
    });
    input.onQueryEvent({
      type: 'session_end',
      sessionId: 'task',
      usage: { inputTokens: 17, outputTokens: 3 },
    });
  });
});
it('sends selected API identity, target and reviewed context through the existing ordinary allocation/admission path', async () => {
  const model = await createNativeAdviserSession(config, request, owner, mocks.binding);
  const events = [];
  for await (const event of model.turn(request.messages)) events.push(event);
  expect(mocks.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      binding: mocks.binding,
      selection: {
        runOn: 'local',
        runtime: { account: mocks.runtime.account, harness: 'codex', targetId: 'selected-mac' },
      },
    }),
  );
  const input = mocks.dispatch.mock.calls[0][0];
  expect(input.reservation.runtimeBinding).toEqual(mocks.runtime);
  expect(input.command.selection.permission).toEqual({ mode: 'ask', revision: 0 });
  expect(input.command.payload.text).toContain('Reviewed');
  expect(input.adviserScope.instructions()).toBe('Feature instructions');
  expect(mocks.prepareSession).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Advice' },
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'message_start',
      message: expect.objectContaining({
        model: 'gpt-6-luna',
        usage: { input_tokens: 17, output_tokens: 3 },
      }),
    }),
  );
});
it('rejects changed account authority before allocating anything and never falls back', async () => {
  mocks.resolve.mockReturnValue({ ...mocks.binding, profileRevision: 'different-endpoint' });
  await expect(createNativeAdviserSession(config, request, owner, mocks.binding)).rejects.toThrow(
    'account',
  );
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
it('rechecks the originating feature authority after deferred allocation before dispatching a paid review', async () => {
  let current = true;
  const assertCurrentSync = vi.fn(() => {
    if (!current) throw Error('Original publisher changed');
  });
  mocks.reserve.mockImplementationOnce(async (input) => {
    await Promise.resolve();
    current = false;
    return {
      id: 'workspace',
      conversationId: 'task',
      directory: '/task-root/empty-task',
      hostReservation: { taskRoot: '/task-root' },
      preparationFingerprint: 'fingerprint',
      settings: input.settings,
    };
  });
  const model = await createNativeAdviserSession(
    config,
    request,
    {
      ...owner,
      feature: { kind: 'github-publication', operationId: 'operation' },
      assertCurrentSync,
    },
    mocks.binding,
  );
  const read = async () => {
    for await (const event of model.turn(request.messages)) {
      void event; // Drain the independent review stream.
    }
  };
  await expect(read()).rejects.toThrow('Original publisher changed');
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(mocks.prepareSession).not.toHaveBeenCalled();
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionLaunchTools } from '../session-launch-tools.js';

vi.mock('../agent-library-transport.js', () => ({
  captureAgentLibraryAuthorization: () => ({ auth: { id: 'login' }, assertCurrent: vi.fn() }),
}));
vi.mock('../agent-tool-selection.js', () => ({ agentToolAllowed: () => true }));
const configuration = {
  version: 1,
  runtime: {
    version: 1,
    account: { accountId: 'a', model: 'sol', reasoningEffort: 'high' },
    accountReference: null,
    agentProfile: null,
    execution: { location: 'local', targetId: 'host' },
  },
  mode: 'agent',
  isolation: true,
  repositoryWorkspaceId: null,
  contextBlocks: [],
  extraTools: [],
};
const input = {
  requestId: '543bf396-4eb5-4d8f-a9e7-cfae371bac3a',
  title: 'New chat',
  prompt: 'Do the work',
  overrides: { mode: 'ask' },
};
function fixture(permissionPrefix?: string) {
  const session = {
    abortController: new AbortController(),
    ownerConnectionId: 'connection',
    activeSkillPolicy: undefined as Set<string> | undefined,
  };
  const store = {
    forRequest: vi.fn(),
    propose: vi.fn((value) => ({
      requestId: value.requestId,
      sourceSessionId: value.sourceSessionId,
      title: value.title,
      prompt: value.prompt,
      configuration: value.configuration,
      ...(value.telos ? { telos: value.telos } : {}),
      proposalId: '9fbe6c84-ebac-4223-9f48-617f3ab7075f',
      state: 'pending',
      revision: 1,
      childSessionId: null,
      createdAt: 1,
      updatedAt: 1,
      allocationId: null,
      commandId: null,
      preparationId: null,
    })),
  };
  const defaults = { get: vi.fn(() => ({ revision: 1, configuration })) };
  const telos = {
    propose: vi.fn(async () => ({
      telos: {
        version: 1,
        parentItemId: 'parent-feature',
        parentAssignmentRevision: 1,
        itemId: 'selected-slice',
        expectedRevision: 'a'.repeat(64),
        role: 'worker',
        sourceSnapshotIds: [],
        artifactRefs: [],
      },
    })),
  };
  const registry = {
    get: () => session,
    findBySessionId: vi.fn(() => ({ session, clientId: 'connection:source' })),
    isClosingOut: () => false,
    isUserClose: () => false,
  };
  const current = vi.fn();
  return {
    session,
    store,
    defaults,
    registry,
    current,
    telos,
    tools: sessionLaunchTools({
      sessionId: 'source',
      session,
      registry,
      permissionPrefix,
      assertCurrent: async () => {},
      assertCurrentSync: current,
      controller: () => ({ defaults, launches: { store }, telos, changed: vi.fn() }),
    } as never),
  };
}
beforeEach(() => vi.clearAllMocks());
describe('StartSession proposal tool', () => {
  it.each(['', 'mcp__mitzo-connections__'])(
    'refuses unqualified %s delegation and rechecks restrictions during proposal review',
    async (permissionPrefix) => {
      const f = fixture(permissionPrefix);
      f.session.activeSkillPolicy = new Set([permissionPrefix + 'TelosCreateSession']);
      const selected = { ...input, itemId: 'selected-slice', expectedRevision: 'a'.repeat(64) };
      const invoke = () =>
        f.tools.execute(
          selected,
          new AbortController().signal,
          { turnId: 'turn', callId: 'call' },
          'TelosCreateSession',
        );
      await expect(invoke()).rejects.toThrow(/skill tool restrictions/);
      expect(f.telos.propose).not.toHaveBeenCalled();
      expect(f.store.propose).not.toHaveBeenCalled();
      f.session.activeSkillPolicy = undefined;
      await expect(invoke()).resolves.toMatchObject({ state: 'pending', childSessionId: null });
      expect(f.store.propose).toHaveBeenCalledOnce();
      f.session.activeSkillPolicy = new Set(['Read']);
      await expect(invoke()).rejects.toThrow(/skill tool restrictions/);
      expect(f.store.propose).toHaveBeenCalledOnce();
      f.session.activeSkillPolicy = undefined;
      const previous = f.telos.propose.getMockImplementation()!;
      f.telos.propose.mockImplementation(async (...args) => {
        const result = await previous(...args);
        f.session.activeSkillPolicy = new Set(['Read']);
        return result;
      });
      await expect(invoke()).rejects.toThrow(/skill tool restrictions/);
      expect(f.store.propose).toHaveBeenCalledOnce();
    },
  );
  it('rejects changed operator custody during the awaited Telos proposal review', async () => {
    const f = fixture();
    const previous = f.telos.propose.getMockImplementation()!;
    f.telos.propose.mockImplementation(async (...args) => {
      const result = await previous(...args);
      f.session.ownerConnectionId = 'replacement-operator';
      return result;
    });
    await expect(
      f.tools.execute(
        { ...input, itemId: 'selected-slice', expectedRevision: 'a'.repeat(64) },
        new AbortController().signal,
        { turnId: 'turn', callId: 'call' },
        'TelosCreateSession',
      ),
    ).rejects.toThrow(/operator changed/i);
    expect(f.store.propose).not.toHaveBeenCalled();
  });
  it('uses the Telos-aware proposal owner and never drops selected work into an ordinary launch', async () => {
    const f = fixture();
    const selected = {
      ...input,
      itemId: 'selected-slice',
      expectedRevision: 'a'.repeat(64),
      sourceSnapshotIds: [],
      artifactRefs: [],
    };
    const result = await f.tools.execute(
      selected,
      new AbortController().signal,
      { turnId: 'turn', callId: 'call' },
      'TelosCreateSession',
    );
    expect(f.telos.propose).toHaveBeenCalledWith(
      'source',
      selected,
      expect.objectContaining({ authSessionId: 'login' }),
    );
    expect(result).toMatchObject({
      state: 'pending',
      telos: { itemId: selected.itemId, role: 'worker' },
    });
    expect(f.store.propose).toHaveBeenCalledTimes(1);
  });
  it('resolves the saved exact host plus overrides, without starting a provider', async () => {
    const f = fixture();
    const result = await f.tools.execute(input, new AbortController().signal, {
      turnId: 'turn',
      callId: 'call',
    });
    expect(result.state).toBe('pending');
    expect(result.handoverDownloadUrl).toBe(
      '/api/session-launch/requests/9fbe6c84-ebac-4223-9f48-617f3ab7075f/handover.md',
    );
    expect(f.store.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: 'user',
        sourceSessionId: 'source',
        requestId: input.requestId,
        configuration: expect.objectContaining({
          mode: 'ask',
          runtime: expect.objectContaining({ execution: { location: 'local', targetId: 'host' } }),
        }),
      }),
    );
  });
  it('does not create proposals for a stale or unverified tool invocation', async () => {
    const f = fixture();
    await expect(f.tools.execute(input, new AbortController().signal, undefined)).rejects.toThrow();
    f.current.mockImplementation(() => {
      throw Error('revoked');
    });
    await expect(
      f.tools.execute(input, new AbortController().signal, { turnId: 'turn', callId: 'call' }),
    ).rejects.toThrow('revoked');
    expect(f.store.propose).not.toHaveBeenCalled();
  });
});

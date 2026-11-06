import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionLaunchTools } from '../session-launch-tools.js';

vi.mock('../agent-library-transport.js', () => ({
  captureAgentLibraryAuthorization: () => ({ auth: { id: 'login' }, assertCurrent: vi.fn() }),
}));
vi.mock('@mitzo/harness', () => ({ checkSkillPolicy: () => 'allow' }));
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
function fixture() {
  const session = { abortController: new AbortController(), ownerConnectionId: 'connection' };
  const store = {
    forRequest: vi.fn(),
    propose: vi.fn((value) => ({
      requestId: value.requestId,
      sourceSessionId: value.sourceSessionId,
      title: value.title,
      prompt: value.prompt,
      configuration: value.configuration,
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
  const registry = {
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
    tools: sessionLaunchTools({
      sessionId: 'source',
      session,
      registry,
      assertCurrent: async () => {},
      assertCurrentSync: current,
      controller: () => ({ defaults, launches: { store }, changed: vi.fn() }),
    } as never),
  };
}
beforeEach(() => vi.clearAllMocks());
describe('StartSession proposal tool', () => {
  it('resolves the saved exact host plus overrides, without starting a provider', async () => {
    const f = fixture();
    const result = await f.tools.execute(input, new AbortController().signal, {
      turnId: 'turn',
      callId: 'call',
    });
    expect(result.state).toBe('pending');
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

import { expect, it, vi } from 'vitest';
import { SessionOverviewEmitter, type SessionOverviewDeps } from '../session-overview.js';
vi.mock('@mitzo/harness', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getPendingCountBySession: () => 0,
}));
vi.mock('../worktree.js', () => ({ hasUncommittedWorkAsync: async () => null }));

it('retains model identity in live and retained activity without provider fallback', () => {
  const deps = {
    registry: {
      getActiveSessions: () => [
        {
          clientId: 'client',
          sessionId: 'live',
          attached: true,
          hasSnapshot: true,
          taskContext: null,
          model: 'gpt-6.1-sol',
          accountLabel: 'Personal',
        },
      ],
    },
    sseRegistry: { broadcast: vi.fn() },
    getLoopStatus: () => ({ state: 'idle' }),
    taskStore: { getTree: () => [] },
    getSessionTitle: () => 'Fix login',
    isSessionHidden: () => false,
    eventStore: {
      getSession: () => null,
      getAttentionSessions: () => [
        {
          sessionId: 'retained',
          summary: 'Fix plugin install',
          lastSpeaker: 'assistant',
          lastSpeakerAt: Date.now(),
          selectedModel: 'claude-opus-4-8',
          accountBinding: {
            accountId: 'work',
            accountLabel: 'Work',
            provider: 'anthropic-vertex',
            model: 'old-model',
            profileRevision: 'r1',
          },
        },
      ],
    },
  } as unknown as SessionOverviewDeps;
  const emitter = new SessionOverviewEmitter(deps);
  try {
    expect(emitter.getSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'live',
          model: 'gpt-6.1-sol',
          accountLabel: 'Personal',
        }),
        expect.objectContaining({
          sessionId: 'retained',
          model: 'claude-opus-4-8',
          accountLabel: 'Work',
        }),
      ]),
    );
  } finally {
    emitter.destroy();
  }
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelSession, ModelSessionConfig, CostRate } from '@mitzo/harness';
import type { PaidReasoningPhaseSelection } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { GeminiSession } from '../gemini-session.js';
import { NativeCommandRegistry } from '../native-commands.js';
import { SkillRegistry } from '../skills.js';
import { cancelDeliberation } from '../deliberate-admission.js';
const f = vi.hoisted(() => ({
  sessions: vi.fn(),
  revision: 'pinned',
  hold: false,
  provider: 'anthropic-vertex' as 'anthropic-vertex' | 'openai' | 'google-vertex',
  authorized: true,
  rate: undefined as CostRate | undefined,
}));
vi.mock('../agent-library-transport.js', async (original) => ({
  ...(await original<typeof import('../agent-library-transport.js')>()),
  captureAgentLibraryAuthorization: () => ({
    auth: { id: 'operator', expiresAt: Date.now() + 60000 },
    assertCurrent() {
      if (!f.authorized) throw Error('Operator revoked');
    },
  }),
}));
vi.mock('../account-profiles.js', () => ({
  loadAccountProfiles: () => ({
    resolve: (accountId: string, model: string) => ({
      accountId,
      accountLabel: accountId,
      provider: f.provider,
      profileRevision: f.revision,
      model,
    }),
    validateModelSelection() {},
    paidReasoningRate() {
      return f.rate;
    },
  }),
}));
vi.mock('../ordinary-local-codex-entry.js', () => ({
  ordinaryRepositoryRuntimeInventory: () => ({
    catalog: {
      resolve: (runtime: {
        account: PaidReasoningPhaseSelection['binding']['account'];
        harness: PaidReasoningPhaseSelection['binding']['harness']['implementation'];
        targetId: string;
      }) => ({
        status: 'compatible',
        binding: {
          version: 2,
          account: runtime.account,
          harness: { implementation: runtime.harness },
          execution: { location: 'local', targetId: runtime.targetId, targetRevision: 'target' },
        },
      }),
    },
  }),
}));
vi.mock('../terminal-adviser-model.js', () => ({ createTerminalAdviserSession: f.sessions }));
const phase = (
  role: PaidReasoningPhaseSelection['role'],
  accountId: string,
): PaidReasoningPhaseSelection => ({
  role,
  binding: {
    version: 2,
    account: { accountId, provider: 'anthropic-vertex', profileRevision: 'pinned' },
    harness: { implementation: 'claude-sdk' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'target' },
  },
  model: 'claude-sonnet-4-6',
  thinking: null,
  outputPolicy: { kind: 'native-default', acknowledgeProviderDefaults: true },
});
describe('real native command selected reasoning entrance', () => {
  let store: EventStore;
  const registry = new NativeCommandRegistry();
  const skills = new SkillRegistry({});
  const selections = [
    phase('proposer', 'proposer-account'),
    phase('challenger', 'challenger-account'),
  ];
  const context = () => ({
    paidReasoning: {
      operatorConnectionId: 'verified-operator',
      phaseSelections: selections as PaidReasoningPhaseSelection[],
    },
    deliberation: {
      store,
      request: {
        sessionId: 'paid-stream',
        clientMsgId: 'paid-command',
        task: 'Explain the tradeoffs',
      },
      onAdmitted: vi.fn(),
    },
  });
  beforeEach(() => {
    f.revision = 'pinned';
    f.hold = false;
    f.provider = 'anthropic-vertex';
    f.authorized = true;
    f.rate = undefined;
    f.sessions.mockReset();
    store = new EventStore(':memory:');
    f.sessions.mockImplementation(async (config: ModelSessionConfig): Promise<ModelSession> => ({
      provider: 'claude-sdk',
      async *turn() {
        if (f.hold)
          await new Promise((_resolve, reject) =>
            config.signal!.addEventListener('abort', () => reject(Error('aborted')), {
              once: true,
            }),
          );
        yield {
          type: 'message_start',
          message: {
            id: 'controlled-native',
            model: config.model,
            role: 'assistant',
            usage: { input_tokens: 100, output_tokens: 0 },
          },
        };
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: '{"response":"Reviewed answer","position_changed":false}',
          },
        };
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      },
    }));
  });
  afterEach(() => {
    store.close();
    vi.unstubAllGlobals();
  });
  it('reaches selected scoped sessions, preserves model roster/account roles and observes accepted lost replies without repeating phases', async () => {
    const ctx = context();
    const result = await registry.execute('deliberate', 'Explain the tradeoffs', skills, ctx);
    expect(result?.content).toContain('Deliberation Result');
    expect(result?.content).toContain('claude-sonnet-4-6');
    expect(f.sessions.mock.calls.map(([, request]) => request.accountId)).toEqual([
      'proposer-account',
      'challenger-account',
      'proposer-account',
      'challenger-account',
      'proposer-account',
      'proposer-account',
    ]);
    const receipt = store.getExecutionAdmission('paid-stream', 'paid-command')!;
    expect(store.getProviderAttempts(receipt.token)).toHaveLength(6);
    expect(
      store
        .getProviderAttempts(receipt.token)
        .every((attempt) => attempt.terminalReason === 'completed'),
    ).toBe(true);
    await registry.execute('deliberate', 'Explain the tradeoffs', skills, ctx);
    expect(f.sessions).toHaveBeenCalledTimes(6);
    const changed = context();
    changed.paidReasoning.phaseSelections = selections.map((entry) => ({
      ...entry,
      thinking: 'high',
    }));
    await expect(
      registry.execute('deliberate', 'Explain the tradeoffs', skills, changed),
    ).rejects.toThrow(/different request/i);
    expect(f.sessions).toHaveBeenCalledTimes(6);
  });
  it('reaches configured-rate Codex phases and fences later rate/profile changes before another effect', async () => {
    f.provider = 'openai';
    f.rate = { inputPerMillion: 2, outputPerMillion: 9 };
    const ctx = context();
    ctx.paidReasoning.phaseSelections = selections.map((entry) => ({
      ...entry,
      model: 'selected-codex-test-model',
      binding: {
        ...entry.binding,
        account: { ...entry.binding.account, provider: 'openai' },
        harness: { implementation: 'codex' },
      },
    }));
    const result = await registry.execute('deliberate', 'Explain the tradeoffs', skills, ctx);
    expect(result?.content).toContain('selected-codex-test-model');
    expect(f.sessions).toHaveBeenCalledTimes(6);
    expect(f.sessions.mock.calls[0][1]).toMatchObject({
      accountId: 'proposer-account',
      model: 'selected-codex-test-model',
    });
    f.rate = { inputPerMillion: 3, outputPerMillion: 9 };
    f.revision = 'rate-revision-changed';
    await expect(
      registry.execute('deliberate', 'Explain the tradeoffs', skills, ctx),
    ).rejects.toThrow(/account changed/i);
    expect(f.sessions).toHaveBeenCalledTimes(6);
  });
  it('persists a stable sanitized unknown-cost event without replaying a cached native phase', async () => {
    f.sessions.mockImplementation(async (config: ModelSessionConfig): Promise<ModelSession> => ({
      provider: 'claude-sdk',
      async *turn() {
        yield {
          type: 'message_start',
          message: {
            id: 'controlled-native',
            model: config.model,
            role: 'assistant',
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 400 },
          },
        };
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Actual phase answer' },
        };
      },
    }));
    const ctx = context();
    expect(
      (await registry.execute('deliberate', 'Explain the tradeoffs', skills, ctx))?.content,
    ).toContain('uncertain');
    const errors = store.getEventsOfType('paid-stream', 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].payload).toMatchObject({
      code: 'paid_reasoning_cost_unknown',
      error: expect.stringMatching(/cached-token.*qualified cache rates/i),
    });
    expect(JSON.stringify(errors)).not.toContain('Actual phase answer');
    await registry.execute('deliberate', 'Explain the tradeoffs', skills, ctx);
    expect(f.sessions).toHaveBeenCalledOnce();
    expect(store.getEventsOfType('paid-stream', 'error')).toHaveLength(1);
  });
  it('revalidates the original operator before a deferred Gemini follow-up phase or credential factory', async () => {
    f.provider = 'google-vertex';
    f.sessions.mockImplementation(async (config: ModelSessionConfig): Promise<ModelSession> => ({
      provider: 'google-vertex',
      async *turn() {
        yield {
          type: 'message_start',
          message: {
            id: 'controlled-gemini',
            model: config.model,
            role: 'assistant',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        };
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Completed first phase' },
        };
        f.authorized = false;
      },
    }));
    const ctx = context();
    ctx.paidReasoning.phaseSelections = selections.map((entry) => ({
      ...entry,
      model: 'gemini-2.5-pro',
      binding: {
        ...entry.binding,
        account: { ...entry.binding.account, provider: 'google-vertex' },
        harness: { implementation: 'gemini' },
      },
    }));
    const result = await registry.execute('deliberate', 'Explain the tradeoffs', skills, ctx);
    expect(result?.content).toContain('failed');
    expect(f.sessions).toHaveBeenCalledOnce();
    const receipt = store.getExecutionAdmission('paid-stream', 'paid-command')!;
    expect(store.getProviderAttempts(receipt.token)).toHaveLength(1);
    expect(store.getProviderAttempts(receipt.token)[0].terminalReason).toBe('completed');
  });
  it.each(['operator', 'account-route'] as const)(
    'fences %s revocation while actual Gemini token acquisition awaits, before fetch',
    async (revocation) => {
      f.provider = 'google-vertex';
      let release!: () => void, tokenRequested!: () => void;
      const tokenPending = new Promise<void>((resolve) => {
        tokenRequested = resolve;
      });
      const tokenGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetcher = vi.fn(async () =>
        Response.json({
          candidates: [
            {
              finishReason: 'STOP',
              content: { role: 'model', parts: [{ text: 'Completed phase' }] },
            },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
        }),
      );
      vi.stubGlobal('fetch', fetcher);
      f.sessions.mockImplementation(
        async (config: ModelSessionConfig) =>
          new GeminiSession(config, {
            accountId: 'proposer-account',
            projectId: 'selected-project',
            region: 'global',
            textTranscript: true,
            getAccessToken: async () => {
              tokenRequested();
              await tokenGate;
              return 'fixture-private-token';
            },
          }),
      );
      const ctx = context();
      ctx.paidReasoning.phaseSelections = selections.map((entry) => ({
        ...entry,
        model: 'gemini-2.5-pro',
        binding: {
          ...entry.binding,
          account: { ...entry.binding.account, provider: 'google-vertex' },
          harness: { implementation: 'gemini' },
        },
      }));
      const pending = registry.execute('deliberate', 'Explain the tradeoffs', skills, ctx);
      await tokenPending;
      if (revocation === 'operator') f.authorized = false;
      else f.revision = 'changed-during-token-await';
      release();
      expect((await pending)?.content).toContain('uncertain');
      expect(fetcher).not.toHaveBeenCalled();
      expect(f.sessions).toHaveBeenCalledOnce();
    },
  );
  it('refuses unselected, unknown-price or unavailable exact-cap work before durable provider attempts or session allocation', async () => {
    for (const phaseSelections of [
      undefined,
      selections.map((entry) => ({ ...entry, model: 'unknown-price-model' })),
      selections.map((entry) => ({
        ...entry,
        outputPolicy: { kind: 'exact-token-ceiling' as const, maxTokens: 8192 },
      })),
    ]) {
      const ctx = {
        ...context(),
        paidReasoning: { operatorConnectionId: 'verified-operator', phaseSelections },
      };
      await expect(
        registry.execute('deliberate', 'Explain the tradeoffs', skills, ctx),
      ).rejects.toThrow();
      expect(store.getExecutionAdmission('paid-stream', 'paid-command')).toBeUndefined();
      expect(f.sessions).not.toHaveBeenCalled();
    }
  });
  it('cancels the exact native phase and leaves uncertainty without advancing or replaying on an exact retry', async () => {
    f.hold = true;
    const ctx = context();
    const pending = registry.execute('deliberate', 'Explain the tradeoffs', skills, ctx);
    await vi.waitFor(() => expect(f.sessions).toHaveBeenCalledOnce());
    expect(cancelDeliberation(store, 'paid-stream')).toBe(true);
    expect((await pending)?.content).toContain('cancelled');
    const receipt = store.getExecutionAdmission('paid-stream', 'paid-command')!;
    expect(store.getProviderAttempts(receipt.token)[0].terminalReason).toBe('ambiguous');
    await registry.execute('deliberate', 'Explain the tradeoffs', skills, ctx);
    expect(f.sessions).toHaveBeenCalledOnce();
  });
});

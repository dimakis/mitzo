import { describe, expect, it, vi } from 'vitest';
import type { ModelSession } from '@mitzo/harness';
import type { PaidReasoningPhaseSelection } from '@mitzo/protocol';
import { preparePaidReasoningHarness } from '../paid-reasoning-harness.js';
const phase = (
  role: PaidReasoningPhaseSelection['role'],
  accountId = 'selected-work',
): PaidReasoningPhaseSelection => ({
  role,
  binding: {
    version: 2,
    account: { accountId, provider: 'anthropic-vertex', profileRevision: `profile-${accountId}` },
    harness: { implementation: 'claude-sdk' },
    execution: { location: 'local', targetId: 'selected-mac', targetRevision: 'pinned-target' },
  },
  model: 'claude-sonnet-4-6',
  thinking: null,
  outputPolicy: { kind: 'native-default', acknowledgeProviderDefaults: true },
});
const owner = { authSessionId: 'operator', operatorConnectionId: 'verified-connection' };
function fixtures() {
  let current = true;
  const qualify = vi.fn(async () => ({
    assertCurrent() {
      if (!current) throw Error('changed');
    },
  }));
  const createSession = vi.fn(async (_config, request): Promise<ModelSession> => ({
    provider: 'claude-sdk',
    async *turn() {
      yield {
        type: 'message_start',
        message: {
          id: 'actual',
          model: request.model,
          role: 'assistant',
          usage: { input_tokens: 120, output_tokens: 0 },
        },
      };
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Selected phase answer' },
      };
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: 120, output_tokens: 45 },
      };
    },
  }));
  return {
    qualify,
    createSession,
    revoke() {
      current = false;
    },
  };
}
describe('selected paid reasoning harness phases', () => {
  it('keeps identical models on separate explicitly selected accounts and charges real usage at known rates', async () => {
    const f = fixtures();
    const runtime = await preparePaidReasoningHarness(
      {
        roles: ['proposer', 'challenger'],
        selections: [phase('proposer', 'one'), phase('challenger', 'two')],
        owner,
      },
      f,
    );
    const one = runtime.createProvider('claude-sonnet-4-6', 'proposer');
    const two = runtime.createProvider('claude-sonnet-4-6', 'challenger');
    const result = await one.call([
      { role: 'system', content: 'Role instructions' },
      { role: 'user', content: 'Separate phase request' },
    ]);
    await two.call([{ role: 'user', content: 'Critique the provided answer' }]);
    expect(f.createSession.mock.calls.map(([, request]) => request.accountId)).toEqual([
      'one',
      'two',
    ]);
    expect(result).toMatchObject({
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: 120, outputTokens: 45 },
      content: 'Selected phase answer',
    });
    expect(result.costUsd).toBeCloseTo((120 * 3 + 45 * 15) / 1_000_000);
    expect(f.createSession.mock.calls[0][2]).toMatchObject({
      ...owner,
      feature: { kind: 'paid-reasoning', phaseId: 'proposer' },
    });
  });
  it('supports configured Codex rates without inferring prices or another account', async () => {
    const f = fixtures();
    const selections = [phase('proposer'), phase('challenger')].map((selection) => ({
      ...selection,
      model: 'selected-native-model',
      binding: {
        ...selection.binding,
        account: { ...selection.binding.account, provider: 'openai' as const },
        harness: { implementation: 'codex' as const },
      },
    }));
    const qualify = vi.fn(async () => ({
      ...(await f.qualify()),
      rate: { inputPerMillion: 2, outputPerMillion: 9 },
    }));
    const runtime = await preparePaidReasoningHarness(
      { roles: ['proposer', 'challenger'], selections, owner },
      { ...f, qualify },
    );
    const result = await runtime
      .createProvider('selected-native-model', 'proposer')
      .call([{ role: 'user', content: 'selected native request' }]);
    expect(result.costUsd).toBeCloseTo((120 * 2 + 45 * 9) / 1_000_000);
    expect(f.createSession.mock.calls[0][1].accountId).toBe('selected-work');
    f.revoke();
    await expect(
      runtime
        .createProvider('selected-native-model', 'challenger')
        .call([{ role: 'user', content: 'next' }]),
    ).rejects.toThrow();
    expect(f.createSession).toHaveBeenCalledTimes(1);
  });
  it('includes actual cache usage in the configured estimate', async () => {
    const f = fixtures();
    f.createSession.mockResolvedValueOnce({
      provider: 'claude-sdk',
      async *turn() {
        yield {
          type: 'message_start',
          message: {
            id: 'actual',
            model: 'claude-sonnet-4-6',
            role: 'assistant',
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 50,
              cache_creation_input_tokens: 20,
            },
          },
        };
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Measured answer' },
        };
      },
    });
    const qualify = async () => ({
      ...(await f.qualify()),
      rate: {
        inputPerMillion: 3,
        outputPerMillion: 15,
        cacheReadPerMillion: 1,
        cacheCreationPerMillion: 4,
      },
    });
    const runtime = await preparePaidReasoningHarness(
      {
        roles: ['proposer', 'challenger'],
        selections: [phase('proposer'), phase('challenger')],
        owner,
      },
      { ...f, qualify },
    );
    const result = await runtime
      .createProvider('claude-sonnet-4-6', 'proposer')
      .call([{ role: 'user', content: 'request' }]);
    expect(result.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 50,
      cacheCreationTokens: 20,
    });
    expect(result.costUsd).toBeCloseTo((10 * 3 + 50 * 1 + 20 * 4 + 5 * 15) / 1_000_000);
    f.createSession.mockResolvedValueOnce({
      provider: 'claude-sdk',
      async *turn() {
        yield {
          type: 'message_start',
          message: {
            id: 'actual',
            model: 'claude-sonnet-4-6',
            role: 'assistant',
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 50 },
          },
        };
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Unpriced cached answer' },
        };
      },
    });
    const unpriced = await preparePaidReasoningHarness(
      {
        roles: ['proposer', 'challenger'],
        selections: [phase('proposer'), phase('challenger')],
        owner,
      },
      f,
    );
    await expect(
      unpriced
        .createProvider('claude-sonnet-4-6', 'proposer')
        .call([{ role: 'user', content: 'request' }]),
    ).rejects.toThrow(/cached-token.*rates/i);
  });
  it('rejects missing role selections, unknown prices and an unsupported required exact cap before a phase dispatch', async () => {
    for (const selections of [
      undefined,
      [phase('proposer')],
      [{ ...phase('proposer'), model: 'unknown-model' }, phase('challenger')],
      [
        { ...phase('proposer'), outputPolicy: { kind: 'exact-token-ceiling', maxTokens: 8192 } },
        phase('challenger'),
      ],
    ]) {
      const f = fixtures();
      await expect(
        preparePaidReasoningHarness({ roles: ['proposer', 'challenger'], selections, owner }, f),
      ).rejects.toThrow();
      expect(f.createSession).not.toHaveBeenCalled();
    }
  });
  it('fails closed for missing real usage, revocation and wrong factory role/model without fallback', async () => {
    const f = fixtures();
    const runtime = await preparePaidReasoningHarness(
      {
        roles: ['proposer', 'challenger'],
        selections: [phase('proposer'), phase('challenger')],
        owner,
      },
      f,
    );
    expect(() => runtime.createProvider('another-model', 'proposer')).toThrow();
    expect(() => runtime.createProvider('claude-sonnet-4-6')).toThrow();
    f.createSession.mockResolvedValueOnce({
      provider: 'claude-sdk',
      async *turn() {
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'No usage evidence' },
        };
      },
    });
    await expect(
      runtime
        .createProvider('claude-sonnet-4-6', 'proposer')
        .call([{ role: 'user', content: 'request' }]),
    ).rejects.toThrow(/usage/i);
    f.revoke();
    expect(runtime.routeRevision).toThrow();
    await expect(
      runtime
        .createProvider('claude-sonnet-4-6', 'challenger')
        .call([{ role: 'user', content: 'request' }]),
    ).rejects.toThrow();
    expect(f.createSession).toHaveBeenCalledTimes(1);
  });
});

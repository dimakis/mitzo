import { describe, expect, it } from 'vitest';
import { sessionListMetadata } from '../session-list-metadata.js';

describe('session list metadata', () => {
  const accountBinding = {
    accountId: 'personal',
    accountLabel: 'Personal',
    provider: 'openai-codex',
    model: 'gpt-6-sol',
    profileRevision: 'r1',
  };
  it('shows the saved model choice rather than the original binding model or engine', () => {
    expect(
      sessionListMetadata({ accountBinding, selectedModel: 'gpt-6.1-sol' }, null),
    ).toMatchObject({ model: 'gpt-6.1-sol', accountLabel: 'Personal' });
  });
  it('uses the recorded binding model for histories without a picker choice', () => {
    expect(sessionListMetadata({ accountBinding }, null)).toMatchObject({ model: 'gpt-6-sol' });
    expect(sessionListMetadata({}, null).model).toBeUndefined();
  });
  it('applies account aliases by ID without using a different account’s model', () => {
    expect(
      sessionListMetadata({ accountBinding, selectedModel: 'gpt-6.1-sol' }, null, (id, fallback) =>
        id === 'personal' ? 'Home' : fallback,
      ),
    ).toMatchObject({ model: 'gpt-6.1-sol', accountLabel: 'Home' });
  });
  it('exposes measured context separately from cumulative usage and retains the exact work link', () => {
    expect(
      sessionListMetadata(
        { telosTaskId: 'task-one', cwd: '/work/mgmt' },
        {
          payload: {
            agentContext: 48000,
            tokenLimits: { model: 'example', source: 'runtime', contextWindow: 200000 },
          },
          createdAt: 123,
        },
      ),
    ).toEqual({
      telosTaskId: 'task-one',
      cwd: '/work/mgmt',
      contextUsage: {
        used: 48000,
        measuredAt: 123,
        limits: { model: 'example', source: 'runtime', contextWindow: 200000, stale: false },
      },
    });
  });
  it('does not turn cumulative tokens or an unmeasured zero into context occupancy', () => {
    expect(
      sessionListMetadata({}, { payload: { sessionTotal: 990000, agentContext: 0 }, createdAt: 1 })
        .contextUsage?.used,
    ).toBeNull();
    expect(sessionListMetadata({}, null).contextUsage).toBeUndefined();
  });
  it('does not trust malformed capacity evidence', () => {
    expect(
      sessionListMetadata(
        {},
        {
          payload: { agentContext: 48000, tokenLimits: { source: 'runtime', contextWindow: -1 } },
          createdAt: 1,
        },
      ).contextUsage?.limits,
    ).toBeNull();
  });
});

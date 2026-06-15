import { describe, it, expect, vi } from 'vitest';
import { DeliberationOrchestrator, DEFAULT_DELIBERATION_CONFIG } from '../src/reasoning/deliberation.js';
import type { DeliberationConfig, ReasoningEvent } from '../src/reasoning/types.js';

// Track call counts per model to return appropriate responses
const proposerCalls: number[] = [];
const challengerCalls: number[] = [];

vi.mock('../src/providers/index.js', () => ({
  createProvider: vi.fn((model: string) => {
    const isChallenger = model === 'gemini-2.5-pro';

    return {
      name: isChallenger ? 'google-vertex' : 'anthropic-vertex',
      call: vi.fn(async () => {
        if (isChallenger) {
          challengerCalls.push(1);
          return {
            content: 'The proposal misses cache invalidation strategy and cold-start latency.',
            model,
            usage: { inputTokens: 600, outputTokens: 400 },
            costUsd: 0.03,
          };
        }

        // Proposer calls: propose → respond → converge
        proposerCalls.push(1);
        const callNum = proposerCalls.length;

        if (callNum === 1) {
          return {
            content: 'Initial proposal: use a caching layer with Redis.',
            model,
            usage: { inputTokens: 500, outputTokens: 300 },
            costUsd: 0.05,
          };
        } else if (callNum === 2) {
          return {
            content: JSON.stringify({
              response: 'Valid point. Adding TTL-based invalidation.',
              position_changed: true,
              change_detail: 'Added TTL-based cache invalidation with 5min default',
              revised_proposal: 'Updated proposal: Redis cache with TTL-based invalidation.',
            }),
            model,
            usage: { inputTokens: 700, outputTokens: 500 },
            costUsd: 0.06,
          };
        } else {
          return {
            content: 'Final: Redis caching with TTL invalidation and warm-up strategy.',
            model,
            usage: { inputTokens: 800, outputTokens: 600 },
            costUsd: 0.07,
          };
        }
      }),
    };
  }),
}));

describe('DeliberationOrchestrator', () => {
  beforeEach(() => {
    proposerCalls.length = 0;
    challengerCalls.length = 0;
  });

  it('runs full propose-challenge-respond-converge cycle', async () => {
    const events: ReasoningEvent[] = [];
    const config: DeliberationConfig = {
      ...DEFAULT_DELIBERATION_CONFIG,
      maxRounds: 1,
      budgetUsd: 10.0,
      onEvent: (e) => events.push(e),
    };

    const orchestrator = new DeliberationOrchestrator(config);
    const result = await orchestrator.run(
      'Design a caching layer',
      'We have a REST API with 1000 req/s.',
    );

    // Verify result structure
    expect(result.final).toBeTruthy();
    expect(result.proposal).toBeTruthy();
    expect(result.rounds).toHaveLength(1);
    expect(result.mindChanges).toBe(1);
    expect(result.totalCost).toBeGreaterThan(0);
    expect(result.transcript).toHaveLength(4); // propose + challenge + respond + converge

    // Verify round details
    expect(result.rounds[0].positionChanged).toBe(true);
    expect(result.rounds[0].changeDetail).toContain('TTL');

    // Verify events were emitted
    expect(events[0]).toEqual({
      type: 'reasoning_start',
      mode: 'deliberation',
      task: 'Design a caching layer',
    });
    expect(events[events.length - 1].type).toBe('reasoning_end');
  });
});

describe('DEFAULT_DELIBERATION_CONFIG', () => {
  it('has valid default values', () => {
    expect(DEFAULT_DELIBERATION_CONFIG.proposer.model).toBe('claude-opus-4-6');
    expect(DEFAULT_DELIBERATION_CONFIG.challenger.model).toBe('gemini-2.5-pro');
    expect(DEFAULT_DELIBERATION_CONFIG.maxRounds).toBe(2);
    expect(DEFAULT_DELIBERATION_CONFIG.budgetUsd).toBe(2.0);
    expect(DEFAULT_DELIBERATION_CONFIG.convergence).toBe('fixed-rounds');
  });

  it('has system prompts for both roles', () => {
    expect(DEFAULT_DELIBERATION_CONFIG.proposer.systemPrompt).toBeTruthy();
    expect(DEFAULT_DELIBERATION_CONFIG.challenger.systemPrompt).toBeTruthy();
    expect(DEFAULT_DELIBERATION_CONFIG.proposer.name).toBe('architect');
    expect(DEFAULT_DELIBERATION_CONFIG.challenger.name).toBe('critic');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FusionOrchestrator, DEFAULT_FUSION_CONFIG, SELF_FUSION_CONFIG } from '../src/reasoning/fusion.js';
import type { FusionConfig, ReasoningEvent } from '../src/reasoning/types.js';

// Mock provider factory
let callCount = 0;
vi.mock('../src/providers/index.js', () => ({
  createProvider: vi.fn(() => ({
    name: 'mock-provider',
    call: vi.fn(async () => {
      callCount++;
      // Return different content based on call order:
      // 1-3: panel responses, 4: judge analysis, 5: synthesis
      if (callCount <= 3) {
        return {
          content: `Panel ${callCount} response: Redis is a good caching solution with ${callCount === 2 ? 'Memcached as alternative' : 'built-in TTL support'}.`,
          model: `model-${callCount}`,
          usage: { inputTokens: 500, outputTokens: 300 },
          costUsd: 0.05,
        };
      } else if (callCount === 4) {
        return {
          content: JSON.stringify({
            consensus: ['Redis is a solid caching solution', 'TTL-based expiry is recommended'],
            contradictions: [
              {
                topic: 'Alternative caching layer',
                positions: [
                  { model: 'model-2', position: 'Memcached as alternative' },
                  { model: 'model-1', position: 'Redis only' },
                ],
              },
            ],
            partial_coverage: ['Cluster mode considerations'],
            unique_insights: [
              { model: 'model-3', insight: 'Built-in TTL support reduces complexity' },
            ],
            blind_spots: ['Cost analysis at scale'],
          }),
          model: 'judge-model',
          usage: { inputTokens: 2000, outputTokens: 1000 },
          costUsd: 0.10,
        };
      } else {
        return {
          content: 'Final synthesis: Use Redis with TTL-based caching. Consider Memcached for simple key-value at extreme scale.',
          model: 'synth-model',
          usage: { inputTokens: 1500, outputTokens: 800 },
          costUsd: 0.08,
        };
      }
    }),
  })),
}));

describe('FusionOrchestrator', () => {
  beforeEach(() => {
    callCount = 0;
  });

  it('runs full fan-out → judge → synthesize pipeline', async () => {
    const events: ReasoningEvent[] = [];
    const config: FusionConfig = {
      ...DEFAULT_FUSION_CONFIG,
      budgetUsd: 10.0,
      onEvent: (e) => events.push(e),
    };

    const orchestrator = new FusionOrchestrator(config);
    const result = await orchestrator.run(
      'Best caching strategy for our API',
      'REST API with 1000 req/s, 50ms p99 target.',
    );

    // Verify result structure
    expect(result.finalOutput).toBeTruthy();
    expect(result.finalOutput).toContain('Redis');
    expect(result.panelResponses).toHaveLength(3); // 3 panel members
    expect(result.totalCost).toBeGreaterThan(0);

    // Verify judge analysis was parsed
    expect(result.judgeAnalysis.consensus).toHaveLength(2);
    expect(result.judgeAnalysis.contradictions).toHaveLength(1);
    expect(result.judgeAnalysis.uniqueInsights).toHaveLength(1);
    expect(result.judgeAnalysis.blindSpots).toHaveLength(1);

    // Verify transcript has all phases
    const phases = result.transcript.map((t) => t.phase);
    expect(phases.filter((p) => p === 'fan-out')).toHaveLength(3);
    expect(phases).toContain('judge');
    expect(phases).toContain('synthesize');

    // Verify events
    expect(events[0]).toEqual({
      type: 'reasoning_start',
      mode: 'fusion',
      task: 'Best caching strategy for our API',
    });
    expect(events[events.length - 1].type).toBe('reasoning_end');
  });
});

describe('DEFAULT_FUSION_CONFIG', () => {
  it('has 3 panel members by default', () => {
    expect(DEFAULT_FUSION_CONFIG.panelModels).toHaveLength(3);
  });

  it('uses Opus as judge', () => {
    expect(DEFAULT_FUSION_CONFIG.judgeModel.model).toBe('claude-opus-4-6');
  });

  it('includes diverse models', () => {
    const models = DEFAULT_FUSION_CONFIG.panelModels.map((p) => p.model);
    expect(models).toContain('claude-opus-4-6');
    expect(models).toContain('gemini-2.5-pro');
    expect(models).toContain('claude-sonnet-4-6');
  });
});

describe('SELF_FUSION_CONFIG', () => {
  it('uses the same model for all roles', () => {
    const panelModels = SELF_FUSION_CONFIG.panelModels.map((p) => p.model);
    const allSame = panelModels.every((m) => m === panelModels[0]);
    expect(allSame).toBe(true);
    expect(SELF_FUSION_CONFIG.judgeModel.model).toBe(panelModels[0]);
  });

  it('has 2 panel members', () => {
    expect(SELF_FUSION_CONFIG.panelModels).toHaveLength(2);
  });
});

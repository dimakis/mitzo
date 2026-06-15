import { describe, it, expect } from 'vitest';
import { calculateCost, MODEL_COSTS, createProvider } from '../src/providers/index.js';
import type { TokenUsage } from '../src/providers/types.js';

describe('MODEL_COSTS', () => {
  it('contains cost rates for all supported models', () => {
    expect(MODEL_COSTS).toHaveProperty('claude-opus-4-6');
    expect(MODEL_COSTS).toHaveProperty('claude-sonnet-4-6');
    expect(MODEL_COSTS).toHaveProperty('claude-haiku-4-5');
    expect(MODEL_COSTS).toHaveProperty('gemini-2.5-pro');
    expect(MODEL_COSTS).toHaveProperty('gemini-2.5-flash');
  });

  it('has positive input and output rates', () => {
    for (const [model, rate] of Object.entries(MODEL_COSTS)) {
      expect(rate.inputPerMillion, `${model} input rate`).toBeGreaterThan(0);
      expect(rate.outputPerMillion, `${model} output rate`).toBeGreaterThan(0);
    }
  });
});

describe('calculateCost', () => {
  it('calculates cost for known model', () => {
    const usage: TokenUsage = { inputTokens: 1000, outputTokens: 500 };
    const cost = calculateCost('claude-opus-4-6', usage);

    // Opus: $15/M input, $75/M output
    // (1000/1M * 15) + (500/1M * 75) = 0.015 + 0.0375 = 0.0525
    expect(cost).toBeCloseTo(0.0525, 4);
  });

  it('calculates cost for Gemini model', () => {
    const usage: TokenUsage = { inputTokens: 10000, outputTokens: 2000 };
    const cost = calculateCost('gemini-2.5-pro', usage);

    // Gemini 2.5 Pro: $1.25/M input, $10/M output
    // (10000/1M * 1.25) + (2000/1M * 10) = 0.0125 + 0.02 = 0.0325
    expect(cost).toBeCloseTo(0.0325, 4);
  });

  it('returns 0 for unknown model', () => {
    const usage: TokenUsage = { inputTokens: 1000, outputTokens: 500 };
    expect(calculateCost('unknown-model', usage)).toBe(0);
  });

  it('returns 0 for zero token usage', () => {
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    expect(calculateCost('claude-opus-4-6', usage)).toBe(0);
  });
});

describe('createProvider', () => {
  it('creates an anthropic provider for Claude models', () => {
    const provider = createProvider('claude-opus-4-6');
    expect(provider.name).toBe('anthropic-vertex');
  });

  it('creates a google provider for Gemini models', () => {
    const provider = createProvider('gemini-2.5-pro');
    expect(provider.name).toBe('google-vertex');
  });

  it('defaults to anthropic for unknown models', () => {
    const provider = createProvider('unknown-model');
    expect(provider.name).toBe('anthropic-vertex');
  });
});

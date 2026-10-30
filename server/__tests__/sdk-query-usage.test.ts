import { expect, it } from 'vitest';
import { SdkQueryUsage } from '../sdk-query-usage.js';

it('accumulates accounting counters while preserving current result and model-capacity metadata', () => {
  const usage = new SdkQueryUsage();
  const first = Object.freeze({
    type: 'result',
    uuid: 'first',
    is_error: false,
    usage: Object.freeze({
      input_tokens: 100,
      output_tokens: 30,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 8,
      cache_creation: Object.freeze({ ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 3 }),
      server_tool_use: Object.freeze({ web_search_requests: 2, web_fetch_requests: 1 }),
      output_tokens_details: Object.freeze({ thinking_tokens: 10 }),
      service_tier: 'priority',
    }),
    total_cost_usd: 0.5,
    num_turns: 3,
    duration_ms: 1000,
    duration_api_ms: 800,
    modelUsage: Object.freeze({
      alpha: Object.freeze({
        inputTokens: 100,
        outputTokens: 30,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 8,
        webSearchRequests: 2,
        costUSD: 0.5,
        contextWindow: 200000,
        maxOutputTokens: 16000,
      }),
    }),
  });
  const prior = usage.include(first);
  const next = usage.include({
    type: 'result',
    uuid: 'second',
    is_error: true,
    subtype: 'error_max_turns',
    errors: ['Stopped'],
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 4,
      cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 3 },
      server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
      output_tokens_details: { thinking_tokens: 1 },
      service_tier: 'standard',
    },
    total_cost_usd: 0.2,
    num_turns: 1,
    duration_ms: 100,
    duration_api_ms: 80,
    modelUsage: {
      alpha: {
        inputTokens: 10,
        outputTokens: 3,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 4,
        webSearchRequests: 1,
        costUSD: 0.2,
        contextWindow: 100000,
        maxOutputTokens: 8000,
      },
    },
  });
  expect(next).toMatchObject({
    uuid: 'second',
    is_error: true,
    subtype: 'error_max_turns',
    errors: ['Stopped'],
    num_turns: 4,
    duration_ms: 1100,
    duration_api_ms: 880,
    usage: {
      input_tokens: 110,
      output_tokens: 33,
      cache_read_input_tokens: 22,
      cache_creation_input_tokens: 12,
      cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 6 },
      server_tool_use: { web_search_requests: 3, web_fetch_requests: 1 },
      output_tokens_details: { thinking_tokens: 11 },
      service_tier: 'standard',
    },
    modelUsage: {
      alpha: {
        inputTokens: 110,
        outputTokens: 33,
        cacheReadInputTokens: 22,
        cacheCreationInputTokens: 12,
        webSearchRequests: 3,
        contextWindow: 100000,
        maxOutputTokens: 8000,
      },
    },
  });
  expect(next.total_cost_usd).toBeCloseTo(0.7);
  expect((next.modelUsage as Record<string, { costUSD: number }>).alpha.costUSD).toBeCloseTo(0.7);
  expect(prior).toEqual(first);
});

it('retains earlier models and known totals when later results omit counters', () => {
  const usage = new SdkQueryUsage();
  expect(usage.include({ type: 'result', uuid: 'no-observation' })).toEqual({
    type: 'result',
    uuid: 'no-observation',
  });
  usage.include({
    usage: { input_tokens: 10 },
    total_cost_usd: 0.2,
    modelUsage: { alpha: { inputTokens: 10, contextWindow: 200000 } },
  });
  usage.include({ modelUsage: { beta: { inputTokens: 5, contextWindow: 100000 } } });
  const next = usage.include({ type: 'result', is_error: true, usage: null });
  expect(next).toMatchObject({
    usage: { input_tokens: 10 },
    total_cost_usd: 0.2,
    modelUsage: {
      alpha: { inputTokens: 10, contextWindow: 200000 },
      beta: { inputTokens: 5, contextWindow: 100000 },
    },
  });
  expect(next).not.toHaveProperty('num_turns');
});

it('does not turn invalid or overflowing observations into negative or non-finite totals', () => {
  const usage = new SdkQueryUsage();
  usage.include({ total_cost_usd: 1, usage: { input_tokens: 10 } });
  expect(
    usage.include({ total_cost_usd: -1, usage: { input_tokens: NaN, output_tokens: '3' } }),
  ).toMatchObject({
    total_cost_usd: 1,
    usage: { input_tokens: 10 },
  });
  const huge = new SdkQueryUsage();
  huge.include({ duration_ms: Number.MAX_VALUE });
  expect(huge.include({ duration_ms: Number.MAX_VALUE }).duration_ms).toBe(Number.MAX_VALUE);
});

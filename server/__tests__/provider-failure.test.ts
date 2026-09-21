import { describe, expect, it } from 'vitest';
import { classifyProviderFailure } from '../provider-failure.js';

describe('classifyProviderFailure', () => {
  it('classifies temporary OpenAI overload without retaining provider text', () => {
    expect(
      classifyProviderFailure(
        {
          message:
            'We are currently experiencing high demand. Bearer sk-secret https://private.example',
          type: 'service_unavailable_error',
          code: 'server_is_overloaded',
          retry_after: 12,
        },
        { attempt: 2, correlationId: 'turn-123' },
      ),
    ).toEqual({
      category: 'overloaded',
      code: 'server_is_overloaded',
      retryable: true,
      ambiguous: true,
      attempt: 2,
      correlationId: 'turn-123',
      retryAfterMs: 12_000,
      message:
        'OpenAI is temporarily overloaded. This turn is saved and can be retried when capacity is available.',
    });
  });

  it('distinguishes retryable rate limiting from non-retryable quota exhaustion', () => {
    expect(
      classifyProviderFailure(
        { message: 'Too many requests', type: 'rate_limit_error', code: 'slow_down' },
        { correlationId: 'turn-rate' },
      ),
    ).toMatchObject({ category: 'rate_limited', code: 'slow_down', retryable: true });

    expect(
      classifyProviderFailure(
        {
          message: 'Quota exhausted',
          type: 'insufficient_quota',
          code: 'project_spend_limit_exceeded',
        },
        { correlationId: 'turn-quota' },
      ),
    ).toMatchObject({
      category: 'rate_limited',
      code: 'project_spend_limit_exceeded',
      retryable: false,
    });

    expect(
      classifyProviderFailure(
        {
          message: 'Quota exhausted',
          type: 'rate_limit_error',
          error: { code: 'insufficient_quota' },
        },
        { correlationId: 'turn-nested-quota' },
      ),
    ).toMatchObject({ code: 'insufficient_quota', retryable: false });

    expect(
      classifyProviderFailure(
        { message: 'Quota exhausted. Update billing to continue.' },
        { correlationId: 'turn-quota-without-code' },
      ),
    ).toMatchObject({ category: 'rate_limited', retryable: false });
  });

  it.each([
    ['timeout', { message: 'request timed out' }, true],
    ['transport', { message: 'stream disconnected before completion' }, true],
    ['policy', { message: 'credential-bearing request body could not be inspected' }, false],
    ['context', { message: 'context_length_exceeded' }, false],
    ['authentication', { message: 'unauthorized credential' }, false],
    ['unknown', { message: 'something private happened at https://internal.invalid' }, false],
  ] as const)('classifies %s failures', (category, value, retryable) => {
    expect(classifyProviderFailure(value, { correlationId: `turn-${category}` })).toMatchObject({
      category,
      retryable,
      correlationId: `turn-${category}`,
      attempt: 1,
    });
  });

  it('drops unsafe provider codes and clamps invalid retry delays', () => {
    expect(
      classifyProviderFailure(
        {
          message: 'high demand',
          code: 'Bearer sk-secret https://private.example',
          retry_after: 999_999,
        },
        { correlationId: 'turn-safe' },
      ),
    ).toEqual(
      expect.objectContaining({
        category: 'overloaded',
        correlationId: 'turn-safe',
      }),
    );
    expect(
      classifyProviderFailure(
        {
          message: 'high demand',
          code: 'Bearer sk-secret https://private.example',
          retry_after: 999_999,
        },
        { correlationId: 'turn-safe' },
      ),
    ).not.toHaveProperty('code');
    expect(
      classifyProviderFailure(
        {
          message: 'high demand',
          code: 'Bearer sk-secret https://private.example',
          retry_after: 999_999,
        },
        { correlationId: 'turn-safe' },
      ),
    ).not.toHaveProperty('retryAfterMs');

    expect(
      classifyProviderFailure(
        { message: 'high demand', code: 'sk-secret' },
        { correlationId: 'turn-code-shaped-secret' },
      ),
    ).not.toHaveProperty('code');
  });
});

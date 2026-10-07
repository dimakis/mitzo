import { describe, expect, it } from 'vitest';
import { classifyProviderFailure, providerFailureTelemetry } from '../provider-failure.js';

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
        'The provider is temporarily unavailable or busy. Wait before trying a new turn. Inspect saved work before retrying.',
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

  it('classifies native Responses HTTP failures and honors both Retry-After forms', () => {
    expect(
      classifyProviderFailure(
        { status: 503, retryAfter: '4', code: 'service_unavailable_error' },
        { correlationId: 'message-overload' },
      ),
    ).toMatchObject({
      category: 'overloaded',
      retryable: true,
      retryAfterMs: 4_000,
      correlationId: 'message-overload',
    });

    const now = Date.now();
    const failure = classifyProviderFailure(
      { status: 429, retryAfter: new Date(now + 20_000).toUTCString() },
      { correlationId: 'message-rate-limit' },
    );
    expect(failure.category).toBe('rate_limited');
    expect(failure.retryable).toBe(true);
    expect(failure.retryAfterMs).toBeGreaterThanOrEqual(19_000);
    expect(failure.retryAfterMs).toBeLessThanOrEqual(20_000);

    expect(
      classifyProviderFailure(new TypeError('fetch failed'), {
        correlationId: 'message-network',
      }),
    ).toMatchObject({ category: 'transport', retryable: true, ambiguous: true });

    expect(
      classifyProviderFailure(
        { status: 403, message: 'OpenShell policy blocked the credential-bearing request' },
        { correlationId: 'message-policy' },
      ),
    ).toMatchObject({ category: 'policy', retryable: false });
  });

  it('produces only stable, sanitized telemetry fields', () => {
    expect(
      providerFailureTelemetry({
        category: 'authentication',
        retryable: false,
        ambiguous: false,
        attempt: 1,
        correlationId: 'message-auth',
        message: 'safe public text',
      }),
    ).toEqual({
      providerFailureCategory: 'authentication',
      providerFailureRetryable: false,
      providerFailureAmbiguous: false,
      providerFailureAttempt: 1,
      providerFailureCorrelationId: 'message-auth',
    });
  });
});

it.each([
  {
    message: 'Selected model is at capacity. Please try a different model.',
    codex_error_info: 'server_overloaded',
  },
  { codex_error_info: 'server_overloaded' },
  {
    message: 'Bearer sk-private credential at https://private.invalid',
    codex_error_info: 'server_overloaded',
  },
])('classifies structured native capacity failures without retaining raw diagnostics', (error) => {
  const failure = classifyProviderFailure(error, { correlationId: 'native-turn', attempt: 3 });
  expect(failure).toMatchObject({
    category: 'overloaded',
    code: 'server_overloaded',
    retryable: true,
    ambiguous: true,
    attempt: 3,
  });
  expect(failure.message).toBe(
    'The selected model is at capacity. Wait for capacity or choose another available model. Your progress is saved.',
  );
  expect(providerFailureTelemetry(failure)).toMatchObject({
    providerFailureCode: 'server_overloaded',
    providerFailureAmbiguous: true,
  });
  expect(JSON.stringify(failure)).not.toMatch(/sk-private|private.invalid|Bearer/);
});

it.each([
  ['serverOverloaded', 'overloaded', true],
  ['contextWindowExceeded', 'context', false],
  ['usageLimitExceeded', 'rate_limited', false],
  ['sessionBudgetExceeded', 'rate_limited', false],
  ['rateLimitExceeded', 'rate_limited', true],
  ['unauthorized', 'authentication', false],
  ['internalServerError', 'overloaded', true],
] as const)('uses allowlisted native %s ahead of raw messages', (code, category, retryable) => {
  const failure = classifyProviderFailure(
    { codexErrorInfo: code, message: 'Bearer secret credential' },
    { correlationId: 'turn-known' },
  );
  expect(failure).toMatchObject({ category, retryable });
  expect(failure).toHaveProperty('code');
  expect(failure.message).not.toContain('secret');
  if (code === 'internalServerError') expect(failure.message).not.toContain('model is at capacity');
});

it('keeps unknown structured tags and details private with an actionable fallback', () => {
  const failure = classifyProviderFailure(
    {
      codex_error_info: { other: { private: 'sk-private' } },
      message: 'unfamiliar detail at https://private.invalid',
    },
    { correlationId: 'turn-unknown' },
  );
  expect(failure.category).toBe('unknown');
  expect(failure).not.toHaveProperty('code');
  expect(failure.message).toMatch(/Unrecognized provider failure.*chat and time/);
  expect(JSON.stringify(failure)).not.toMatch(/sk-private|private.invalid/);
});

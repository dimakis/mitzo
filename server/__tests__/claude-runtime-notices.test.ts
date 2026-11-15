import { expect, it } from 'vitest';
import { claudeRuntimeNotice } from '../claude-runtime-notices.js';

const uuid = '693ad15b-2a21-4b33-94e7-8bfc5ed4fe72';
const retry = {
  type: 'system',
  subtype: 'api_retry',
  session_id: 'session',
  uuid,
  attempt: 2,
  max_retries: 5,
  retry_delay_ms: 1500,
  error_status: 429,
  error: 'PRIVATE_NATIVE_ERROR',
};
const rejected = {
  type: 'rate_limit_event',
  session_id: 'session',
  uuid,
  rate_limit_info: {
    status: 'rejected',
    rateLimitType: 'five_hour',
    resetsAt: 1794785400,
    utilization: 0.99,
    private: 'PRIVATE_ACCOUNT_DATA',
  },
};

it.each(['anthropic-claude', 'anthropic-vertex', 'anthropic-api'])(
  'shows actual SDK request retry without changing %s account or retrying a command',
  (provider) => {
    const notice = claudeRuntimeNotice(retry, 'session', provider);
    expect(notice).toMatchObject({ nonfatal: true, code: 'claude_api_retry', correlationId: uuid });
    expect(notice?.error).toMatch(/retry 2.*5/i);
    expect(notice?.error).toMatch(/2 seconds/);
    expect(JSON.stringify(notice)).not.toContain('PRIVATE');
  },
);

it.each([
  {},
  { attempt: -1, max_retries: Infinity, retry_delay_ms: NaN },
  { attempt: 'PRIVATE', max_retries: 5, retry_delay_ms: 'PRIVATE' },
])('does not invent missing or invalid attempt and timing data %#', (fields) => {
  const event = {
    ...retry,
    attempt: undefined,
    max_retries: undefined,
    retry_delay_ms: undefined,
    ...fields,
  };
  const notice = claudeRuntimeNotice(event, 'session', 'anthropic-vertex');
  expect(notice?.error).toMatch(/retrying/i);
  expect(notice?.error).toMatch(/timing.*unavailable/i);
  expect(JSON.stringify(notice)).not.toMatch(/PRIVATE|NaN|Infinity/);
});

it('reports a rejected Personal Claude limit with only its observed reset', () => {
  const notice = claudeRuntimeNotice(rejected, 'session', 'anthropic-claude');
  expect(notice).toMatchObject({ nonfatal: true, code: 'claude_rate_limit', correlationId: uuid });
  expect(notice?.error).toMatch(/rate limit/i);
  expect(notice?.error).toContain(new Date(1794785400000).toISOString());
  expect(JSON.stringify(notice)).not.toMatch(/PRIVATE|0\.99|99%/);
});

it.each([undefined, null, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER, 'PRIVATE'])(
  'keeps reset timing unknown for invalid or absent evidence %#',
  (resetsAt) => {
    const notice = claudeRuntimeNotice(
      { ...rejected, rate_limit_info: { status: 'rejected', resetsAt } },
      'session',
      'anthropic-claude',
    );
    expect(notice?.error).toMatch(/reset time.*not provided/i);
    expect(JSON.stringify(notice)).not.toMatch(/PRIVATE|NaN|Infinity/);
  },
);

it.each([
  [retry, 'foreign', 'anthropic-claude'],
  [retry, 'session', 'openai'],
  [{ ...retry, session_id: undefined }, 'session', 'anthropic-claude'],
  [{ ...retry, parent_tool_use_id: 'child' }, 'session', 'anthropic-claude'],
  [{ ...retry, subtype: 'unknown' }, 'session', 'anthropic-claude'],
  [rejected, 'session', 'anthropic-vertex'],
  [rejected, 'session', 'anthropic-api'],
  [rejected, 'session', undefined],
  [{ ...rejected, rate_limit_info: { status: 'allowed' } }, 'session', 'anthropic-claude'],
  [{ ...rejected, rate_limit_info: { status: 'allowed_warning' } }, 'session', 'anthropic-claude'],
  [{ ...rejected, rate_limit_info: null }, 'session', 'anthropic-claude'],
] as const)(
  'refuses foreign, child, unsupported account or nonfailure events %#',
  (event, sessionId, provider) => {
    expect(claudeRuntimeNotice(event, sessionId, provider)).toBeUndefined();
  },
);

it('replaces an unsafe correlation string instead of publishing it', () => {
  expect(
    claudeRuntimeNotice({ ...retry, uuid: 'PRIVATE' }, 'session', 'anthropic-claude')
      ?.correlationId,
  ).toMatch(/^[a-f0-9-]{36}$/i);
});

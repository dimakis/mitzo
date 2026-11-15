import { randomUUID } from 'node:crypto';

/** Read-only native evidence. This never requests a retry or changes account/model. */
export function claudeRuntimeNotice(
  event: Record<string, unknown>,
  sessionId: string,
  provider: string | undefined,
) {
  if (
    !sessionId ||
    event.session_id !== sessionId ||
    event.parent_tool_use_id != null ||
    !['anthropic-claude', 'anthropic-vertex', 'anthropic-api'].includes(provider ?? '')
  )
    return;
  const correlationId =
    typeof event.uuid === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(event.uuid)
      ? event.uuid
      : randomUUID();
  if (event.type === 'system' && event.subtype === 'api_retry') {
    const attempt = event.attempt,
      limit = event.max_retries,
      delay = event.retry_delay_ms;
    const counters =
      typeof attempt === 'number' &&
      Number.isSafeInteger(attempt) &&
      attempt >= 0 &&
      typeof limit === 'number' &&
      Number.isSafeInteger(limit) &&
      limit >= 1 &&
      limit <= 1000 &&
      attempt <= limit;
    const seconds =
      typeof delay === 'number' && Number.isFinite(delay) && delay >= 0 && delay <= 604800000
        ? Math.ceil(delay / 1000)
        : undefined;
    return {
      nonfatal: true as const,
      stage: 'provider_retry',
      code: 'claude_api_retry',
      correlationId,
      error: `${counters ? `Claude reported retry ${attempt} of up to ${limit}` : 'Claude is retrying'} after a failed request. ${seconds === undefined ? 'Retry timing is unavailable.' : `Reported delay: ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`} Your conversation and queued messages are retained.`,
    };
  }
  if (event.type === 'rate_limit_event' && provider === 'anthropic-claude') {
    const info = event.rate_limit_info;
    if (!info || typeof info !== 'object' || !('status' in info) || info.status !== 'rejected')
      return;
    const reset = 'resetsAt' in info ? info.resetsAt : undefined;
    const resetTime =
      typeof reset === 'number' &&
      Number.isSafeInteger(reset) &&
      reset > 0 &&
      reset <= 8640000000000
        ? new Date(reset * 1000).toISOString()
        : undefined;
    return {
      nonfatal: true as const,
      stage: 'provider_rate_limit',
      code: 'claude_rate_limit',
      correlationId,
      error: `Claude reported a rate limit. ${resetTime ? `Reported reset: ${resetTime}.` : 'A reset time was not provided.'} Your conversation and queued messages are retained; availability is not yet confirmed.`,
    };
  }
}

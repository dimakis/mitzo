import type { ProviderFailure, ProviderFailureCategory } from '@mitzo/protocol';

const SAFE_CODE = /^[a-z0-9][a-z0-9_.-]{0,79}$/i;
const MAX_RETRY_AFTER_SECONDS = 300;
const NON_RETRYABLE_LIMIT_CODES = new Set([
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'project_spend_limit_exceeded',
]);

const PUBLIC_MESSAGES: Record<ProviderFailureCategory, string> = {
  overloaded:
    'OpenAI is temporarily overloaded. This turn is saved and can be retried when capacity is available.',
  rate_limited: 'OpenAI is limiting requests. This turn is saved and can be retried later.',
  timeout: 'The provider request timed out. This turn is saved and can be retried.',
  transport: 'The provider connection ended before the turn completed. This turn is saved.',
  policy: 'OpenShell blocked the provider request because it did not satisfy the active policy.',
  context: 'The provider rejected the turn because its context is too large.',
  authentication: 'The provider rejected the configured account credentials or permissions.',
  unknown: 'The provider did not complete the turn. The failed turn was saved.',
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function diagnosticText(value: unknown, depth = 0): string {
  if (depth > 3) return '';
  if (typeof value === 'string') return value.slice(0, 2_000);
  const object = record(value);
  if (!object) return '';
  return ['message', 'type', 'code', 'status', 'error', 'details', 'additionalDetails']
    .map((key) => diagnosticText(object[key], depth + 1))
    .filter(Boolean)
    .join(' ');
}

function sanitizedCode(value: unknown): string | undefined {
  const object = record(value);
  if (!object) return undefined;
  for (const candidate of [object.code, object.type, record(object.error)?.code]) {
    if (typeof candidate === 'string' && SAFE_CODE.test(candidate)) return candidate;
  }
  return undefined;
}

function retryAfterMs(value: unknown): number | undefined {
  const object = record(value);
  if (!object) return undefined;
  const raw = object.retry_after ?? object.retryAfter ?? record(object.error)?.retry_after;
  const seconds = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_RETRY_AFTER_SECONDS)
    return undefined;
  return Math.ceil(seconds * 1_000);
}

function categoryFor(text: string): ProviderFailureCategory {
  if (
    /(?:server_is_overloaded|service_unavailable_error|temporar(?:ily)? overloaded|high demand)/i.test(
      text,
    )
  )
    return 'overloaded';
  if (
    /(?:rate[_ -]?limit|too many requests|slow_down|insufficient_quota|spend[_ -]?limit|usage[_ -]?limit|quota)/i.test(
      text,
    )
  )
    return 'rate_limited';
  if (/timed? out|timeout/i.test(text)) return 'timeout';
  if (
    /(?:stream.*disconnect|connection.*(?:closed|lost)|provider[_ -]?transport|transport.*(?:closed|lost|failed))/i.test(
      text,
    )
  )
    return 'transport';
  if (
    /(?:credential.*traffic.*denied|credential[ -]bearing.*cannot be inspected|request body.*could not be inspected|openshell.*(?:denied|blocked)|policy.*(?:denied|blocked))/i.test(
      text,
    )
  )
    return 'policy';
  if (/(?:context[_ -]length[_ -]exceeded|context.*too large|too many tokens)/i.test(text))
    return 'context';
  if (
    /(?:unauthenticated|unauthorized|forbidden|invalid[_ -]api[_ -]key|authentication|credential)/i.test(
      text,
    )
  )
    return 'authentication';
  return 'unknown';
}

export function classifyProviderFailure(
  value: unknown,
  context: { correlationId: string; attempt?: number },
): ProviderFailure {
  const text = diagnosticText(value);
  const category = categoryFor(text);
  const code = sanitizedCode(value);
  const retryable =
    category === 'overloaded' ||
    category === 'timeout' ||
    category === 'transport' ||
    (category === 'rate_limited' && (!code || !NON_RETRYABLE_LIMIT_CODES.has(code)));
  const delay = retryAfterMs(value);
  return {
    category,
    ...(code ? { code } : {}),
    retryable,
    ambiguous: retryable || category === 'unknown',
    attempt: Math.max(1, Math.trunc(context.attempt ?? 1)),
    correlationId: context.correlationId,
    ...(delay ? { retryAfterMs: delay } : {}),
    message: PUBLIC_MESSAGES[category],
  };
}

import type { ProviderFailure, ProviderFailureCategory } from '@mitzo/protocol';

const MAX_RETRY_AFTER_SECONDS = 300;
const SAFE_PROVIDER_CODES = new Set([
  'server_is_overloaded',
  'server_error',
  'service_unavailable_error',
  'rate_limit_error',
  'slow_down',
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'project_spend_limit_exceeded',
  'context_length_exceeded',
  'invalid_api_key',
  'authentication_error',
  'permission_denied',
  'request_timeout',
]);
const NON_RETRYABLE_LIMIT_CODES = new Set([
  'insufficient_quota',
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
  for (const candidate of [record(object.error)?.code, object.code, object.type]) {
    if (typeof candidate === 'string' && SAFE_PROVIDER_CODES.has(candidate)) return candidate;
  }
  return undefined;
}

function httpStatus(value: unknown): number | undefined {
  const object = record(value);
  if (!object) return undefined;
  const raw = object.status ?? object.statusCode ?? record(object.error)?.status;
  const status = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function retryAfterMs(value: unknown, now = Date.now()): number | undefined {
  const object = record(value);
  if (!object) return undefined;
  const raw = object.retry_after ?? object.retryAfter ?? record(object.error)?.retry_after;
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  const delayMs = Number.isFinite(numeric)
    ? numeric * 1_000
    : typeof raw === 'string'
      ? Date.parse(raw) - now
      : NaN;
  if (!Number.isFinite(delayMs) || delayMs <= 0 || delayMs > MAX_RETRY_AFTER_SECONDS * 1_000)
    return undefined;
  return Math.ceil(delayMs);
}

function categoryFor(text: string, status?: number): ProviderFailureCategory {
  if (
    /(?:server_is_overloaded|server_error|service_unavailable_error|temporar(?:ily)? overloaded|high demand)/i.test(
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
    /(?:fetch failed|network error|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|stream.*disconnect|connection.*(?:closed|lost)|provider[_ -]?transport|transport.*(?:closed|lost|failed))/i.test(
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
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'authentication';
  if (status !== undefined && status >= 500) return 'overloaded';
  return 'unknown';
}

export function classifyProviderFailure(
  value: unknown,
  context: { correlationId: string; attempt?: number },
): ProviderFailure {
  const text = diagnosticText(value);
  const category = categoryFor(text, httpStatus(value));
  const code = sanitizedCode(value);
  const permanentLimit =
    (!!code && NON_RETRYABLE_LIMIT_CODES.has(code)) ||
    /(?:insufficient[_ -]?quota|quota (?:exhausted|exceeded)|spend[_ -]?limit|usage[_ -]?limit|credit balance)/i.test(
      text,
    );
  const retryable =
    category === 'overloaded' ||
    category === 'timeout' ||
    category === 'transport' ||
    (category === 'rate_limited' && !permanentLimit);
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

/** Stable, secret-free fields shared by logs and traces on every OpenAI route. */
export function providerFailureTelemetry(failure: ProviderFailure) {
  return {
    providerFailureCategory: failure.category,
    ...(failure.code ? { providerFailureCode: failure.code } : {}),
    providerFailureRetryable: failure.retryable,
    providerFailureAmbiguous: failure.ambiguous,
    providerFailureAttempt: failure.attempt,
    providerFailureCorrelationId: failure.correlationId,
    ...(failure.retryAfterMs ? { providerFailureRetryAfterMs: failure.retryAfterMs } : {}),
  };
}

export class ProviderFailureError extends Error {
  constructor(
    readonly failure: ProviderFailure,
    diagnostic = failure.message,
  ) {
    super(diagnostic);
    this.name = 'ProviderFailureError';
  }
}

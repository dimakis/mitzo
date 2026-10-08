import type { ProviderFailure, ProviderFailureCategory } from '@mitzo/protocol';

const MAX_RETRY_AFTER_SECONDS = 300;
const SAFE_PROVIDER_CODES = new Set([
  'server_is_overloaded',
  'server_overloaded',
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
    'The provider is temporarily unavailable or busy. Wait before trying a new turn. Inspect saved work before retrying.',
  rate_limited:
    'The provider is limiting requests. Wait for the limit to reset. Inspect saved work before retrying.',
  timeout:
    'The provider request timed out. Its outcome may be unknown; inspect saved work before continuing.',
  transport: 'The provider connection ended before the turn completed. This turn is saved.',
  policy: 'OpenShell blocked the provider request because it did not satisfy the active policy.',
  context: 'The provider rejected the turn because its context is too large.',
  authentication: 'The provider rejected the configured account credentials or permissions.',
  unknown:
    'Unrecognized provider failure. Inspect saved work before continuing and report the chat and time if the problem persists.',
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
  for (const candidate of [
    object.codex_error_info,
    object.codexErrorInfo,
    record(object.error)?.codex_error_info,
    record(object.error)?.code,
    object.code,
    object.type,
  ]) {
    if (typeof candidate === 'string' && SAFE_PROVIDER_CODES.has(candidate)) return candidate;
  }
  return undefined;
}

// Only reviewed native tags become public codes; provider-controlled payloads
// and unknown tag details never enter messages or telemetry.
function nativeFailure(
  value: unknown,
): { category: ProviderFailureCategory; code: string; permanent?: boolean } | undefined {
  const object = record(value);
  const info =
    object?.codex_error_info ?? object?.codexErrorInfo ?? record(object?.error)?.codex_error_info;
  const known: Record<
    string,
    { category: ProviderFailureCategory; code: string; permanent?: boolean }
  > = {
    serverOverloaded: { category: 'overloaded', code: 'server_overloaded' },
    server_overloaded: { category: 'overloaded', code: 'server_overloaded' },
    contextWindowExceeded: { category: 'context', code: 'context_window_exceeded' },
    context_window_exceeded: { category: 'context', code: 'context_window_exceeded' },
    usageLimitExceeded: { category: 'rate_limited', code: 'usage_limit_exceeded', permanent: true },
    usage_limit_exceeded: {
      category: 'rate_limited',
      code: 'usage_limit_exceeded',
      permanent: true,
    },
    sessionBudgetExceeded: {
      category: 'rate_limited',
      code: 'session_budget_exceeded',
      permanent: true,
    },
    session_budget_exceeded: {
      category: 'rate_limited',
      code: 'session_budget_exceeded',
      permanent: true,
    },
    rateLimitExceeded: { category: 'rate_limited', code: 'rate_limit_exceeded' },
    rate_limit_exceeded: { category: 'rate_limited', code: 'rate_limit_exceeded' },
    unauthorized: { category: 'authentication', code: 'unauthorized' },
    internalServerError: { category: 'overloaded', code: 'internal_server_error' },
    internal_server_error: { category: 'overloaded', code: 'internal_server_error' },
  };
  return typeof info === 'string' && Object.hasOwn(known, info) ? known[info] : undefined;
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
    /(?:server_is_overloaded|server_overloaded|server_error|service_unavailable_error|temporar(?:ily)? overloaded|high demand|model is at capacity)/i.test(
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
  const native = nativeFailure(value);
  const code = native?.code ?? sanitizedCode(value);
  const codedCategory = code ? categoryFor(code) : 'unknown';
  const category =
    native?.category ??
    (codedCategory !== 'unknown' ? codedCategory : categoryFor(text, httpStatus(value)));
  const permanentLimit =
    native?.permanent === true ||
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
    message:
      code === 'server_overloaded' ||
      (category === 'overloaded' && /model is at capacity/i.test(text))
        ? 'The selected model is at capacity. Wait for capacity or choose another available model. Your progress is saved.'
        : permanentLimit && category === 'rate_limited'
          ? 'The selected account has reached a usage or budget limit. Check its limits or choose another available account. Inspect saved work before continuing.'
          : PUBLIC_MESSAGES[category],
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

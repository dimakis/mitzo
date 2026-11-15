import { SpanStatusCode, type Span } from '@opentelemetry/api';
import { findSessionRuntimeError } from './session-runtime-error.js';
import { createLogger } from './logger.js';

// Host call sites supply constant check names. Never derive these from provider
// messages, paths, credentials or request payloads. Keep original Error identity
// (especially reviewed runtime/auth failures) and retain non-Error causes too.
const checks = new WeakMap<Error, string[]>();
export function annotateAuthorityFailure(cause: unknown, check: string): Error {
  const error = cause instanceof Error ? cause : new Error('Runtime authority failed', { cause });
  const retained = checks.get(error) ?? [];
  if (retained[0] !== check && retained.length < 32) retained.unshift(check);
  checks.set(error, retained);
  return error;
}

const systemCodes = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EIO', 'ETIMEDOUT']);
/** Allowlisted diagnostics only; raw exceptions and stacks remain in memory. */
export function runtimeFailureDiagnostics(cause: unknown) {
  const seen = new Set<Error>();
  const authorityChecks: string[] = [];
  let causeType = 'unknown';
  let causeCode: string | undefined;
  for (let depth = 0; depth < 16 && cause instanceof Error && !seen.has(cause); depth++) {
    seen.add(cause);
    for (const check of checks.get(cause) ?? []) {
      if (authorityChecks.length < 32 && authorityChecks.at(-1) !== check)
        authorityChecks.push(check);
    }
    causeType =
      cause instanceof TypeError
        ? 'TypeError'
        : cause instanceof RangeError
          ? 'RangeError'
          : 'Error';
    const code = Object.getOwnPropertyDescriptor(cause, 'code')?.value;
    if (typeof code === 'string' && systemCodes.has(code)) causeCode = code;
    cause = cause.cause;
  }
  return {
    ...(authorityChecks.length ? { failedCheck: authorityChecks.at(-1)!, authorityChecks } : {}),
    causeType,
    ...(causeCode ? { causeCode } : {}),
  };
}

const failedSpans = new WeakSet<Span>();
export const hasRecordedRuntimeFailure = (span: Span) => failedSpans.has(span);

export function runtimeFailureAttributes(error: unknown): Record<string, string> {
  const failure = findSessionRuntimeError(error);
  if (!failure) return {};
  const diagnostic = runtimeFailureDiagnostics(error);
  return {
    'runtime.failure_code': failure.code,
    'runtime.diagnostic_id': failure.diagnosticId,
    'runtime.cause_type': diagnostic.causeType,
    ...(diagnostic.failedCheck
      ? {
          'runtime.failed_check': diagnostic.failedCheck,
          'runtime.authority_checks': diagnostic.authorityChecks!.join(' > '),
        }
      : {}),
    ...(diagnostic.causeCode ? { 'runtime.cause_code': diagnostic.causeCode } : {}),
  };
}

/** A handled failure is still a failed span. Do not serialize the raw cause. */
export function recordRuntimeFailure(span: Span, error: unknown) {
  const failure = findSessionRuntimeError(error);
  if (!failure) return;
  failedSpans.add(span);
  try {
    const attributes = runtimeFailureAttributes(error);
    span.setAttributes(attributes);
    span.addEvent('runtime.failure', attributes);
    span.setStatus({ code: SpanStatusCode.ERROR, message: failure.code });
  } catch (cause) {
    // Optional tracing cannot replace the original failure or skip finalization.
    createLogger('runtime-diagnostics').warn('Runtime failure trace unavailable', {
      code: 'runtime_failure_trace_unavailable',
      ...failure.telemetry(),
      ...runtimeFailureDiagnostics(cause),
    });
  }
}

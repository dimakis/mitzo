import { SpanStatusCode, SpanKind, type Span } from '@opentelemetry/api';
import { tracer, injectTraceparent } from './tracing';

/** Only the static route, status and duration are exported. */
export async function traceAuthenticationCheck<T>(
  check: (span: Span, headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan('http.auth.check', {
    kind: SpanKind.CLIENT,
    attributes: { 'http.request.method': 'GET', 'http.route': '/api/auth/check' },
  });
  try {
    return await check(span, injectTraceparent(span));
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

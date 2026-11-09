import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { CommandDeliveryDiagnosticEvent } from '@mitzo/client';
import { tracer, tracingReady } from './tracing';

/** Never export request/response bodies, raw exception messages or backend URLs. */
export function recordCommandDeliveryDiagnostic(
  event: CommandDeliveryDiagnosticEvent,
  cause?: unknown,
): void {
  const { diagnostic, clientMsgId, sessionId } = event;
  const exceptionType =
    cause instanceof TypeError
      ? 'TypeError'
      : cause instanceof SyntaxError
        ? 'SyntaxError'
        : 'Error';
  if (diagnostic.code !== 'receipt_pending')
    console.warn('[mitzo] Command delivery unconfirmed', { ...event, exceptionType });
  const record = () => {
    const span = tracer.startSpan('command.delivery.failure', {
      kind: SpanKind.CLIENT,
      startTime: diagnostic.startedAt,
      attributes: {
        'mitzo.command.id': clientMsgId,
        ...(sessionId ? { 'mitzo.session.id': sessionId } : {}),
        'mitzo.delivery.operation': diagnostic.operation,
        'mitzo.delivery.stage': diagnostic.stage,
        'mitzo.delivery.code': diagnostic.code,
        'mitzo.delivery.elapsed_ms': diagnostic.elapsedMs,
        'mitzo.delivery.diagnostic_persistence_failed': !!diagnostic.persistenceFailed,
        ...(diagnostic.httpStatus ? { 'http.response.status_code': diagnostic.httpStatus } : {}),
        'exception.type': exceptionType,
      },
    });
    if (diagnostic.code !== 'receipt_pending') span.setStatus({ code: SpanStatusCode.ERROR });
    span.end(diagnostic.startedAt + diagnostic.elapsedMs);
  };
  const unavailable = () =>
    console.warn('[mitzo] Command delivery tracing unavailable', {
      clientMsgId,
      code: 'delivery_trace_unavailable',
    });
  // A cold phone must never wait for optional telemetry before message delivery.
  if (tracingReady) void tracingReady.then(record).catch(unavailable);
  else {
    try {
      record();
    } catch {
      unavailable();
    }
  }
}

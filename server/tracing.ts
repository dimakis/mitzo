/**
 * OpenTelemetry tracing bootstrap — opt-in via OTEL_EXPORTER_OTLP_ENDPOINT.
 *
 * When the env var is set, initializes the OTel SDK with an OTLP exporter
 * (compatible with Jaeger, Grafana Tempo, etc.). When unset, tracing is a
 * no-op — the @opentelemetry/api returns noop spans, so instrumentation
 * code has zero overhead.
 */

import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace, context, type Span, type Context, SpanStatusCode } from '@opentelemetry/api';
import { createLogger } from './logger.js';

const log = createLogger('tracing');

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'mitzo',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? 'dev',
    }),
    // Let the exporter read OTEL_EXPORTER_OTLP_ENDPOINT natively — don't
    // append /v1/traces manually, the SDK handles path construction.
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();

  log.info('OTel tracing initialized', { endpoint });

  const shutdown = () => provider.shutdown().catch(() => {});
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * Get the Mitzo tracer instance. Returns a noop tracer when OTel is not
 * configured, so instrumentation code can call startSpan unconditionally.
 */
export const tracer = trace.getTracer('mitzo', '1.0.0');

/**
 * Run `fn` inside an OTel span with proper context propagation.
 * The span is set as the active context so:
 *  - pino's otelMixin injects trace_id/span_id into log lines
 *  - child spans created inside `fn` inherit this span as parent
 *
 * Handles status setting and span.end() automatically.
 * For async callbacks, use `withSpanAsync`.
 */
export function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (span: Span) => T,
  parentContext?: Context,
): T {
  const parent = parentContext ?? context.active();
  const span = tracer.startSpan(name, {}, parent);
  for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
  return context.with(trace.setSpan(parent, span), () => {
    try {
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.recordException(err instanceof Error ? err : new Error(message));
      span.end();
      throw err;
    }
  });
}

/**
 * Async variant of `withSpan` — awaits the callback and handles
 * rejection. Context propagation works across awaits within the callback.
 */
export async function withSpanAsync<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
  parentContext?: Context,
): Promise<T> {
  const parent = parentContext ?? context.active();
  const span = tracer.startSpan(name, {}, parent);
  for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
  return context.with(trace.setSpan(parent, span), async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.recordException(err instanceof Error ? err : new Error(message));
      span.end();
      throw err;
    }
  });
}

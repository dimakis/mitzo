/**
 * Browser-side OpenTelemetry tracing — opt-in via VITE_OTEL_ENDPOINT.
 *
 * When configured, initializes a browser tracer that exports spans via
 * OTLP HTTP to the same Jaeger instance as the server. When unconfigured,
 * the @opentelemetry/api returns noop spans — zero overhead.
 *
 * Usage:
 *   import { tracer, injectTraceparent } from './tracing';
 *   const span = tracer.startSpan('ws.send');
 *   const msg = { type: 'send', prompt, ...injectTraceparent(span) };
 *   span.end();
 */

import { trace, context } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { browserTelemetryConfig } from './telemetry-config';

const endpoint = import.meta.env.VITE_OTEL_ENDPOINT as string | undefined;

export const tracingReady = endpoint
  ? // Dynamic import to keep the bundle small when tracing is off
    (async () => {
      const { WebTracerProvider, BatchSpanProcessor } =
        await import('@opentelemetry/sdk-trace-web');
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
      const { resourceFromAttributes } = await import('@opentelemetry/resources');
      const { ATTR_SERVICE_NAME } = await import('@opentelemetry/semantic-conventions');

      const config = browserTelemetryConfig(endpoint, import.meta.env.VITE_API_BASE_URL || '', () =>
        localStorage.getItem('mitzo_auth_token'),
      )!;
      const provider = new WebTracerProvider({
        resource: resourceFromAttributes({
          [ATTR_SERVICE_NAME]: 'mitzo-frontend',
        }),
        spanProcessors: [
          new BatchSpanProcessor(new OTLPTraceExporter({ ...config, timeoutMillis: 2000 }), {
            scheduledDelayMillis: 1000,
            maxExportBatchSize: 64,
            maxQueueSize: 256,
          }),
        ],
      });
      provider.register();
    })().catch((err) => {
      console.warn('[mitzo] browser tracing init failed', err);
    })
  : undefined;

/**
 * Browser tracer instance. Returns noop spans when OTel is not configured.
 */
export const tracer = trace.getTracer('mitzo-frontend', '1.0.0');

/**
 * Build a W3C traceparent string from the current span context.
 * Returns an object with { traceparent } that can be spread into WS messages.
 * Returns empty object if tracing is inactive (noop span).
 */
export function injectTraceparent(span?: Span): { traceparent?: string } {
  const s = span ?? trace.getSpan(context.active());
  if (!s) return {};

  const ctx = s.spanContext();
  // Noop spans have all-zero traceId
  if (ctx.traceId === '00000000000000000000000000000000') return {};

  const flags = ctx.traceFlags.toString(16).padStart(2, '0');
  return {
    traceparent: `00-${ctx.traceId}-${ctx.spanId}-${flags}`,
  };
}

/**
 * OpenTelemetry tracing bootstrap — opt-in via OTEL_EXPORTER_OTLP_ENDPOINT.
 *
 * When the env var is set, initializes the OTel SDK with an OTLP exporter
 * (compatible with Jaeger, Grafana Tempo, etc.). When unset, tracing is a
 * no-op — the @opentelemetry/api returns noop spans, so instrumentation
 * code has zero overhead.
 */

import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace } from '@opentelemetry/api';
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
    spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter())],
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

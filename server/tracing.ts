/**
 * OpenTelemetry tracing bootstrap — opt-in via OTEL_EXPORTER_OTLP_ENDPOINT.
 *
 * When the env var is set, initializes the OTel SDK with an OTLP exporter
 * (compatible with Jaeger, Grafana Tempo, etc.). When unset, tracing is a
 * no-op — the @opentelemetry/api returns noop spans, so instrumentation
 * code has zero overhead.
 *
 * Import this module at the top of server/index.ts (before other imports)
 * so the SDK is initialized before any instrumented code runs.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace } from '@opentelemetry/api';
import { createLogger } from './logger.js';

const log = createLogger('tracing');

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  const sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: 'mitzo',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? 'dev',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  });

  sdk.start();
  log.info('OTel tracing initialized', { endpoint });

  process.on('SIGTERM', () => sdk.shutdown());
  process.on('SIGINT', () => sdk.shutdown());
}

/**
 * Get the Mitzo tracer instance. Returns a noop tracer when OTel is not
 * configured, so instrumentation code can call startSpan unconditionally.
 */
export const tracer = trace.getTracer('mitzo', '1.0.0');

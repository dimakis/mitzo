import { SpanStatusCode, SpanKind, type Span } from '@opentelemetry/api';
import { Capacitor } from '@capacitor/core';
import { tracer, injectTraceparent, tracingReady } from './tracing';

function untilAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  const cancelled = () => new Error('Authentication check cancelled');
  if (signal.aborted) return Promise.reject(cancelled());
  let onAbort!: () => void;
  const abort = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, abort]).finally(() => signal.removeEventListener('abort', onAbort));
}

/** Only the static route, status and duration are exported. */
export async function traceAuthenticationCheck<T>(
  check: (span: Span, headers: Record<string, string>) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const startedAt = Date.now();
  const options = {
    kind: SpanKind.CLIENT,
    startTime: startedAt,
    attributes: {
      'http.request.method': 'GET',
      'http.route': '/api/auth/check',
      'mitzo.client.platform': Capacitor.getPlatform(),
    },
  };
  if (signal?.aborted) throw new Error('Authentication check cancelled');
  const span = tracer.startSpan('http.auth.check', options);
  // Cold telemetry imports are optional. Authentication must reach the server
  // immediately even if the provider cannot initialize on a suspended phone.
  const headers = injectTraceparent(span);
  const attributes: Record<string, string | number | boolean> = {};
  let failed = false;
  const recording: Span = headers.traceparent
    ? span
    : new Proxy(span, {
        get(target, property) {
          if (property === 'setAttribute') {
            return (key: string, value: string | number | boolean) => {
              attributes[key] = value;
              target.setAttribute(key, value);
              return recording;
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
  try {
    return await untilAbort(check(recording, headers), signal);
  } catch (error) {
    failed = true;
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    const finishedAt = Date.now();
    span.end();
    // Preserve the measured cold request after initialization, without sending
    // another auth request or extending the caller's network deadline.
    if (tracingReady && !headers.traceparent) {
      void tracingReady
        .then(() => {
          const cold = tracer.startSpan('http.auth.check', options);
          cold.setAttribute('mitzo.auth.phase', 'telemetry_pending');
          for (const [key, value] of Object.entries(attributes)) cold.setAttribute(key, value);
          if (failed) cold.setStatus({ code: SpanStatusCode.ERROR });
          cold.end(finishedAt);
        })
        .catch(() => {
          /* Telemetry failure must not affect authorization. */
        });
    }
  }
}

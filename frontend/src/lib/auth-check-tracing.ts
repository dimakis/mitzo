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
  const initializationStartedAt = performance.now();
  const options = {
    kind: SpanKind.CLIENT,
    startTime: Date.now(),
    attributes: {
      'http.request.method': 'GET',
      'http.route': '/api/auth/check',
      'mitzo.client.platform': Capacitor.getPlatform(),
    },
  };
  if (tracingReady) {
    try {
      await untilAbort(tracingReady, signal);
    } catch (error) {
      const finishedAt = Date.now();
      // If initialization eventually succeeds, retain the failed cold-start
      // duration without starting an obsolete authentication request.
      void tracingReady.then(() => {
        const failed = tracer.startSpan('http.auth.check', options);
        failed.setAttribute('mitzo.auth.phase', 'tracing_initialization');
        failed.setStatus({ code: SpanStatusCode.ERROR });
        failed.end(finishedAt);
      });
      throw error;
    }
  }
  if (signal?.aborted) throw new Error('Authentication check cancelled');
  const span = tracer.startSpan('http.auth.check', options);
  span.setAttribute(
    'mitzo.auth.tracing_initialization_ms',
    performance.now() - initializationStartedAt,
  );
  try {
    return await untilAbort(check(span, injectTraceparent(span)), signal);
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

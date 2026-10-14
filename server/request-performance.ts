import type { RequestHandler } from 'express';
import { performance } from 'node:perf_hooks';
import { context, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { contextFromTraceparent } from './trace-context.js';
import { tracer } from './tracing.js';

type Warn = (message: string, fields: Record<string, unknown>) => void;

/** Shared HTTP timing: no raw URLs, credentials, bodies or provider/model labels. */
export function requestPerformance(warn: Warn, now = () => performance.now()): RequestHandler {
  return (req, res, next) => {
    if (
      !req.path.startsWith('/api/') ||
      req.path.startsWith('/api/telemetry/') ||
      req.path === '/api/auth/check'
    )
      return next();
    const start = now();
    const parent = contextFromTraceparent(
      typeof req.headers.traceparent === 'string' ? req.headers.traceparent : undefined,
    );
    const span = tracer.startSpan(
      'http.request',
      { kind: SpanKind.SERVER, attributes: { 'http.request.method': req.method } },
      parent,
    );
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      const durationMs = Math.round((now() - start) * 100) / 100;
      // Only Express's declared template is safe to record, never req.path/baseUrl.
      const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
      const streaming = String(res.getHeader('content-type') ?? '').startsWith('text/event-stream');
      const failed = res.statusCode >= 500 || (!streaming && !res.writableFinished);
      span.setAttribute('http.route', route);
      span.setAttribute('http.response.status_code', res.statusCode);
      span.setAttribute('http.streaming', streaming);
      if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      if (!streaming && (failed || durationMs >= 500))
        warn(failed ? 'API request failed' : 'Slow API request', {
          route,
          method: req.method,
          status: res.statusCode,
          durationMs,
          aborted: !res.writableFinished,
        });
    };
    res.once('finish', finish);
    res.once('close', finish);
    context.with(trace.setSpan(parent, span), next);
  };
}

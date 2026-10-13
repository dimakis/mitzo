import type { RequestHandler } from 'express';
import { context, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { contextFromTraceparent } from './trace-context.js';
import { tracer } from './tracing.js';

/** Include verification time, without capturing tokens, cookies or query strings. */
export const traceAuthCheck: RequestHandler = (req, res, next) => {
  if (req.method !== 'GET' || req.path !== '/api/auth/check') return next();
  const parent = contextFromTraceparent(
    typeof req.headers.traceparent === 'string' ? req.headers.traceparent : undefined,
  );
  const span = tracer.startSpan(
    'http.auth.check',
    {
      kind: SpanKind.SERVER,
      attributes: { 'http.request.method': 'GET', 'http.route': '/api/auth/check' },
    },
    parent,
  );
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    span.setAttribute('http.response.status_code', res.statusCode);
    if (!res.writableFinished || res.statusCode >= 500)
      span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  };
  res.once('finish', finish);
  res.once('close', finish);
  context.with(trace.setSpan(parent, span), next);
};

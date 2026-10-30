import type { Express, RequestHandler } from 'express';
import type { RouteParameters } from 'express-serve-static-core';
import { performance } from 'node:perf_hooks';
import { context, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { contextFromTraceparent } from './trace-context.js';
import { tracer } from './tracing.js';

const routerMounts = new WeakMap<object, string>();

/** Supply only the declared mount template, never a request-derived path.
 * Install the original middleware in order, restoring the outer label if the
 * router declines the request. Nested route templates remain separate evidence. */
export function mountObservedRouter<Mount extends string>(
  app: Pick<Express, 'use'>,
  mount: Mount,
  ...handlers: RequestHandler<RouteParameters<Mount>>[]
): void {
  const previous = new WeakMap<object, string | undefined>();
  app.use(
    mount,
    (req, _res, next) => {
      previous.set(req, routerMounts.get(req));
      routerMounts.set(req, mount);
      next();
    },
    ...handlers,
    (req, _res, next) => {
      const outer = previous.get(req);
      if (outer === undefined) routerMounts.delete(req);
      else routerMounts.set(req, outer);
      previous.delete(req);
      next();
    },
  );
}

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
      const routerMount = routerMounts.get(req);
      if (routerMount) span.setAttribute('http.router.mount', routerMount);
      span.setAttribute('http.response.status_code', res.statusCode);
      span.setAttribute('http.streaming', streaming);
      if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      if (!streaming && (failed || durationMs >= 500))
        warn(failed ? 'API request failed' : 'Slow API request', {
          route,
          ...(routerMount ? { routerMount } : {}),
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

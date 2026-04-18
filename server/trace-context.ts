/**
 * W3C Trace Context helpers for WebSocket messages.
 *
 * WS doesn't have per-message HTTP headers, so we embed a `traceparent`
 * field in the JSON payload. These helpers parse it into an OTel Context
 * so backend spans can join the same trace as the frontend.
 */

import { trace, context, SpanContext, TraceFlags, ROOT_CONTEXT } from '@opentelemetry/api';

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * Parse a W3C traceparent string and return an OTel Context with the
 * remote span as parent. Returns ROOT_CONTEXT if the string is missing
 * or malformed — callers don't need to guard.
 */
export function contextFromTraceparent(
  traceparent: string | undefined,
): ReturnType<typeof context.active> {
  if (!traceparent) return ROOT_CONTEXT;

  const match = TRACEPARENT_RE.exec(traceparent);
  if (!match) return ROOT_CONTEXT;

  const spanContext: SpanContext = {
    traceId: match[1],
    spanId: match[2],
    traceFlags: parseInt(match[3], 16) as TraceFlags,
    isRemote: true,
  };

  return trace.setSpanContext(ROOT_CONTEXT, spanContext);
}

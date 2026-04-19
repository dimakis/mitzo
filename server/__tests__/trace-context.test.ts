import { describe, it, expect } from 'vitest';
import { trace, ROOT_CONTEXT, TraceFlags } from '@opentelemetry/api';
import { contextFromTraceparent } from '../trace-context.js';

describe('contextFromTraceparent', () => {
  it('returns ROOT_CONTEXT for undefined', () => {
    expect(contextFromTraceparent(undefined)).toBe(ROOT_CONTEXT);
  });

  it('returns ROOT_CONTEXT for empty string', () => {
    expect(contextFromTraceparent('')).toBe(ROOT_CONTEXT);
  });

  it('returns ROOT_CONTEXT for malformed traceparent', () => {
    expect(contextFromTraceparent('not-a-traceparent')).toBe(ROOT_CONTEXT);
    expect(contextFromTraceparent('00-abc-def-01')).toBe(ROOT_CONTEXT);
  });

  it('parses a valid traceparent into a context with remote span', () => {
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const spanId = 'b7ad6b7169203331';
    const traceparent = `00-${traceId}-${spanId}-01`;

    const ctx = contextFromTraceparent(traceparent);
    expect(ctx).not.toBe(ROOT_CONTEXT);

    const spanContext = trace.getSpanContext(ctx);
    expect(spanContext).toBeDefined();
    expect(spanContext!.traceId).toBe(traceId);
    expect(spanContext!.spanId).toBe(spanId);
    expect(spanContext!.traceFlags).toBe(TraceFlags.SAMPLED);
    expect(spanContext!.isRemote).toBe(true);
  });

  it('handles traceFlags 00 (not sampled)', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00';
    const ctx = contextFromTraceparent(traceparent);
    const spanContext = trace.getSpanContext(ctx);
    expect(spanContext!.traceFlags).toBe(TraceFlags.NONE);
  });
});

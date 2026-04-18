import { describe, it, expect } from 'vitest';
import { TraceFlags } from '@opentelemetry/api';

// Import with no VITE_OTEL_ENDPOINT — should get noop tracer
const { tracer, injectTraceparent } = await import('../tracing.js');

describe('frontend tracing module', () => {
  it('exports a tracer that creates spans without VITE_OTEL_ENDPOINT', () => {
    expect(tracer).toBeDefined();
    expect(typeof tracer.startSpan).toBe('function');

    const span = tracer.startSpan('test.noop');
    expect(span).toBeDefined();
    span.end();
  });

  it('injectTraceparent returns empty object for noop span', () => {
    const span = tracer.startSpan('test.noop');
    const result = injectTraceparent(span);
    expect(result).toEqual({});
    span.end();
  });

  it('injectTraceparent returns empty object when no span is provided', () => {
    const result = injectTraceparent();
    expect(result).toEqual({});
  });

  it('injectTraceparent returns traceparent for a real span context', () => {
    // Create a context with a known span context, then read it
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const spanId = 'b7ad6b7169203331';

    // Use the OTel API to create a span-like object with a real context
    const spanContext = {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    };

    const fakeSpan = {
      spanContext: () => spanContext,
      end: () => {},
    } as unknown as import('@opentelemetry/api').Span;

    const result = injectTraceparent(fakeSpan);
    expect(result.traceparent).toBe(`00-${traceId}-${spanId}-01`);
  });
});

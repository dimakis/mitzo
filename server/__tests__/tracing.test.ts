import { describe, it, expect } from 'vitest';

describe('tracing module', () => {
  it('exports a tracer that can create spans without OTEL_EXPORTER_OTLP_ENDPOINT', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const { tracer } = await import('../tracing.js');

    expect(tracer).toBeDefined();
    expect(typeof tracer.startSpan).toBe('function');

    const span = tracer.startSpan('test.noop');
    expect(span).toBeDefined();
    span.end();
  });
});

import { describe, it, expect, vi } from 'vitest';
import type { Span } from '@opentelemetry/api';
import { SessionRuntimeError } from '../session-runtime-error.js';
import { recordRuntimeFailure } from '../runtime-failure-diagnostics.js';

describe('tracing module', () => {
  it('does not overwrite a handled runtime failure with OK when its callback resolves', async () => {
    const { tracer, withSpanAsync } = await import('../tracing.js');
    const span = {
      setAttributes: vi.fn(),
      setAttribute: vi.fn(),
      addEvent: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const spy = vi.spyOn(tracer, 'startSpan').mockReturnValue(span as unknown as Span);
    try {
      await withSpanAsync('chat.start', {}, async (active) =>
        recordRuntimeFailure(active, new SessionRuntimeError('input_not_dispatched')),
      );
      expect(span.setStatus).toHaveBeenLastCalledWith({ code: 2, message: 'input_not_dispatched' });
      expect(span.end).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
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

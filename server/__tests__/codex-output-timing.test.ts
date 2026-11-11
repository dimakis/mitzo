import { ROOT_CONTEXT, type Span } from '@opentelemetry/api';
import { afterEach, expect, it, vi } from 'vitest';
import { tracer } from '../tracing.js';
import { CodexOutputTiming } from '../codex-output-timing.js';

afterEach(() => vi.restoreAllMocks());
it.each(['terminal_before_output', 'failed_before_output'] as const)(
  'ends silent spans once with %s',
  (result) => {
    const spans: { setAttribute: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }[] = [];
    vi.spyOn(tracer, 'startSpan').mockImplementation(() => {
      const span = { setAttribute: vi.fn(), end: vi.fn() };
      spans.push(span);
      return span as unknown as Span;
    });
    const timing = new CodexOutputTiming(ROOT_CONTEXT);
    timing.observe('item/agentMessage/delta', { delta: '' });
    timing.observe('item/started', { item: { type: 'userMessage' } });
    expect(spans.every((s) => s.end.mock.calls.length === 0)).toBe(true);
    timing.close(result);
    timing.close(result);
    for (const s of spans) {
      expect(s.end).toHaveBeenCalledOnce();
      expect(s.setAttribute.mock.calls[0][1]).toBe(result);
    }
  },
);

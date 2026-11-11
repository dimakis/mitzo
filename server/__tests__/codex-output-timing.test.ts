import { ROOT_CONTEXT, type Span } from '@opentelemetry/api';
import { afterEach, expect, it, vi } from 'vitest';
import { tracer } from '../tracing.js';
import { CodexOutputTiming } from '../codex-output-timing.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const spans: { setAttribute: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }[] = [];
  vi.spyOn(tracer, 'startSpan').mockImplementation(() => {
    const span = { setAttribute: vi.fn(), end: vi.fn() };
    spans.push(span);
    return span as unknown as Span;
  });
  return { timing: new CodexOutputTiming(ROOT_CONTEXT), spans };
}
it.each([
  { summary: ['Completed reasoning summary'], activity: true },
  { summary: ['', 'Completed reasoning summary'], activity: true },
  { summary: [], activity: false },
  { summary: [''], activity: false },
  { summary: [null, 42], activity: false },
])(
  'recognizes completed reasoning activity without assistant text: $summary',
  ({ summary, activity }) => {
    const { timing, spans } = fixture();
    timing.observe('item/completed', { item: { type: 'reasoning', summary } });
    expect(spans[0].end).toHaveBeenCalledTimes(activity ? 1 : 0);
    expect(spans[1].end).not.toHaveBeenCalled();
    timing.close('terminal_before_output');
    expect(spans[0].setAttribute).toHaveBeenCalledWith(
      'mitzo.first_activity.result',
      activity ? 'output' : 'terminal_before_output',
    );
    expect(spans[1].setAttribute).toHaveBeenCalledWith(
      'mitzo.first_text.result',
      'terminal_before_output',
    );
    expect(spans[0].end).toHaveBeenCalledOnce();
    expect(spans[1].end).toHaveBeenCalledOnce();
  },
);
it.each(['terminal_before_output', 'failed_before_output'] as const)(
  'ends silent spans once with %s',
  (result) => {
    const { timing, spans } = fixture();
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

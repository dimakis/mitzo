import { describe, expect, it, vi } from 'vitest';
const span = vi.hoisted(() => ({ end: vi.fn(), setStatus: vi.fn(), setAttribute: vi.fn() }));
vi.mock('../tracing', () => ({
  tracer: { startSpan: vi.fn(() => span) },
  injectTraceparent: () => ({
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  }),
}));
import { traceAuthenticationCheck } from '../auth-check-tracing';

describe('phone authentication tracing', () => {
  it('passes the trace context into the request and waits until the check finishes', async () => {
    span.end.mockClear();
    let finish!: (value: boolean) => void;
    const pending = traceAuthenticationCheck((active, headers) => {
      expect(active).toBe(span);
      expect(headers.traceparent).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    });
    expect(span.end).not.toHaveBeenCalled();
    finish(true);
    expect(await pending).toBe(true);
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it('ends a timed-out check as an error without exporting error text', async () => {
    span.end.mockClear();
    span.setStatus.mockClear();
    await expect(
      traceAuthenticationCheck(async () => {
        throw new Error('private request detail');
      }),
    ).rejects.toThrow('private request detail');
    expect(span.setStatus).toHaveBeenCalledWith({ code: 2 });
    expect(span.end).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
const span = vi.hoisted(() => ({ end: vi.fn(), setStatus: vi.fn(), setAttribute: vi.fn() }));
const initialization = vi.hoisted(() => ({ ready: undefined as Promise<void> | undefined }));
const startSpan = vi.hoisted(() => vi.fn());
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'ios' } }));
vi.mock('../tracing', () => ({
  tracer: {
    startSpan: (...args: unknown[]) => {
      startSpan(...args);
      return span;
    },
  },
  get tracingReady() {
    return initialization.ready;
  },
  injectTraceparent: () =>
    initialization.ready
      ? {}
      : {
          traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        },
}));
import { traceAuthenticationCheck } from '../auth-check-tracing';
afterEach(() => {
  initialization.ready = undefined;
  vi.useRealTimers();
});

describe('phone authentication tracing', () => {
  it('starts authentication immediately while telemetry initialization is still pending', async () => {
    vi.useFakeTimers();
    startSpan.mockClear();
    let initialize!: () => void;
    initialization.ready = new Promise<void>((resolve) => {
      initialize = resolve;
    });
    const check = vi.fn().mockResolvedValue(true);
    const startedAt = Date.now();
    const result = traceAuthenticationCheck(check);
    expect(check).toHaveBeenCalledOnce();
    expect(await result).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    initialize();
    await vi.advanceTimersByTimeAsync(0);
    expect(startSpan).toHaveBeenCalledWith(
      'http.auth.check',
      expect.objectContaining({ startTime: startedAt }),
    );
    expect(check).toHaveBeenCalledOnce();
  });

  it('does not wait for a telemetry provider that never initializes', async () => {
    initialization.ready = new Promise(() => {});
    const check = vi.fn().mockResolvedValue(true);
    expect(await traceAuthenticationCheck(check)).toBe(true);
    expect(check).toHaveBeenCalledOnce();
  });

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

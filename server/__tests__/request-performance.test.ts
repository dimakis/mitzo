import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
const span = vi.hoisted(() => ({ setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() }));
const startSpan = vi.hoisted(() => vi.fn());
vi.mock('../tracing.js', () => ({ tracer: { startSpan } }));
import { requestPerformance } from '../request-performance.js';

function setup(path = '/api/sessions/private-id/messages?token=secret') {
  vi.clearAllMocks();
  startSpan.mockReturnValue(span);
  let now = 0;
  const warn = vi.fn();
  const req = {
    path,
    method: 'GET',
    headers: {},
    route: { path: '/api/sessions/:id/messages' },
  } as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableFinished: true,
    getHeader: vi.fn(),
  }) as unknown as Response;
  const next = vi.fn();
  requestPerformance(warn, () => now)(req, res, next);
  return {
    req,
    res,
    next,
    warn,
    advance: (ms: number) => {
      now = ms;
    },
  };
}

describe('shared API performance evidence', () => {
  it('records handler lifetime with normalized route, no session ids or query values', () => {
    const { res, warn, next, advance } = setup();
    expect(next).toHaveBeenCalledOnce();
    advance(1500);
    res.emit('finish');
    res.emit('close');
    expect(span.end).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'Slow API request',
      expect.objectContaining({
        durationMs: 1500,
        route: '/api/sessions/:id/messages',
        status: 200,
      }),
    );
    expect(
      JSON.stringify([startSpan.mock.calls, span.setAttribute.mock.calls, warn.mock.calls]),
    ).not.toMatch(/private-id|secret/);
  });
  it('records fast server errors and aborted requests', () => {
    const { res, warn } = setup();
    res.statusCode = 503;
    res.emit('finish');
    expect(warn).toHaveBeenCalledWith(
      'API request failed',
      expect.objectContaining({ status: 503 }),
    );
    expect(span.setStatus).toHaveBeenCalled();
  });
  it('does not recursively trace telemetry exports', () => {
    const { next, res } = setup('/api/telemetry/v1/traces');
    res.emit('finish');
    expect(next).toHaveBeenCalledOnce();
    expect(startSpan).not.toHaveBeenCalled();
  });
  it('does not label long-lived SSE as a slow request', () => {
    const { res, advance, warn } = setup('/api/notifications/events');
    vi.mocked(res.getHeader).mockReturnValue('text/event-stream');
    advance(120000);
    res.emit('close');
    expect(warn).not.toHaveBeenCalled();
    expect(span.end).toHaveBeenCalledOnce();
  });
});

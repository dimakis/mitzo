import express from 'express';
import request from 'supertest';
import { trace } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

const spans = vi.hoisted(() => ({ startSpan: vi.fn() }));
vi.mock('../tracing.js', () => ({ tracer: spans }));
import { traceAuthCheck } from '../auth-check-tracing.js';

describe('authentication request tracing', () => {
  it('joins the phone trace, records denial and ends exactly once without recording credentials', async () => {
    const span = { setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
    spans.startSpan.mockReturnValueOnce(span);
    const app = express();
    app.use(traceAuthCheck);
    app.get('/api/auth/check', (_req, res) => res.sendStatus(401));
    await request(app)
      .get('/api/auth/check?private=value')
      .set('Authorization', 'Bearer secret')
      .set('traceparent', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    expect(spans.startSpan).toHaveBeenCalledWith(
      'http.auth.check',
      expect.objectContaining({
        attributes: { 'http.request.method': 'GET', 'http.route': '/api/auth/check' },
      }),
      expect.anything(),
    );
    expect(span.setAttribute).toHaveBeenCalledWith('http.response.status_code', 401);
    expect(span.end).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spans.startSpan.mock.calls[0])).not.toContain('secret');
    expect(trace.getSpanContext(spans.startSpan.mock.calls[0][2])?.traceId).toBe(
      '0af7651916cd43dd8448eb211c80319c',
    );
  });

  it('does not turn arbitrary URLs or telemetry exports into trace attributes', async () => {
    spans.startSpan.mockClear();
    const app = express();
    app.use(traceAuthCheck);
    app.get('/api/telemetry/v1/traces', (_req, res) => res.sendStatus(200));
    await request(app).get('/api/telemetry/v1/traces');
    expect(spans.startSpan).not.toHaveBeenCalled();
  });
});

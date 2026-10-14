import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createTelemetryRelay } from '../telemetry-relay.js';

function fixture(endpoint = 'http://localhost:4318') {
  const forward = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  const app = express();
  app.use(
    '/api/telemetry',
    (req, res, next) => {
      if (req.headers.authorization !== 'Bearer phone-token') return res.sendStatus(401);
      next();
    },
    createTelemetryRelay(endpoint, forward),
  );
  return { app, forward };
}

describe('authenticated telemetry relay', () => {
  it('forwards only trace bytes to the configured collector without browser credentials', async () => {
    const { app, forward } = fixture();
    const body = '{"resourceSpans":[]}';
    const response = await request(app)
      .post('/api/telemetry/v1/traces')
      .set('Authorization', 'Bearer phone-token')
      .set('Cookie', 'cc_auth=private')
      .set('Content-Type', 'application/json')
      .send(body);
    expect(response.status).toBe(200);
    const [url, init] = forward.mock.calls[0];
    expect(url).toBe('http://localhost:4318/v1/traces');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(new Headers(init?.headers).get('cookie')).toBeNull();
    expect(Buffer.from(init?.body as Uint8Array).toString()).toBe(body);
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('authenticates before parsing and cannot select a different upstream path', async () => {
    const { app, forward } = fixture();
    expect((await request(app).post('/api/telemetry/v1/traces').send('denied')).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/telemetry/v1/logs')
          .set('Authorization', 'Bearer phone-token')
          .send('{}')
      ).status,
    ).toBe(404);
    expect(forward).not.toHaveBeenCalled();
  });

  it('rejects unsupported content and oversized batches without forwarding', async () => {
    const { app, forward } = fixture();
    expect(
      (
        await request(app)
          .post('/api/telemetry/v1/traces')
          .set('Authorization', 'Bearer phone-token')
          .set('Content-Type', 'text/plain')
          .send('bad')
      ).status,
    ).toBe(415);
    expect(
      (
        await request(app)
          .post('/api/telemetry/v1/traces')
          .set('Authorization', 'Bearer phone-token')
          .set('Content-Type', 'application/json')
          .send('x'.repeat(1024 * 1024 + 1))
      ).status,
    ).toBe(413);
    expect(forward).not.toHaveBeenCalled();
  });

  it('bounds collector failures and never returns its private error text', async () => {
    const { app, forward } = fixture();
    forward.mockRejectedValueOnce(new Error('private collector details'));
    const response = await request(app)
      .post('/api/telemetry/v1/traces')
      .set('Authorization', 'Bearer phone-token')
      .send({ resourceSpans: [] });
    expect(response.status).toBe(502);
    expect(response.text).not.toContain('private');
  });

  it('stays disabled when server tracing is unconfigured', async () => {
    const { app, forward } = fixture('');
    expect(
      (
        await request(app)
          .post('/api/telemetry/v1/traces')
          .set('Authorization', 'Bearer phone-token')
          .send({})
      ).status,
    ).toBe(404);
    expect(forward).not.toHaveBeenCalled();
  });

  it('releases a request even if the collector transport ignores cancellation', async () => {
    const { app, forward } = fixture();
    forward.mockImplementationOnce(() => new Promise(() => {}));
    const response = await request(app)
      .post('/api/telemetry/v1/traces')
      .set('Authorization', 'Bearer phone-token')
      .send({});
    expect(response.status).toBe(502);
    expect(forward.mock.calls[0][1]?.signal?.aborted).toBe(true);
  }, 4000);
});

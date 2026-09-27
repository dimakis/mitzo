import { expect, it, vi } from 'vitest';
import express from 'express';
import { authMiddleware, operatorAuthMiddleware } from '../auth.js';
import { requireRecentConnectionAuthorization } from '../connections-router.js';
import { dispatchCustodianHttp } from '../symposium-custodian-http.js';
const command = () => ({
  epoch: 1,
  requestId: 'one',
  operation: 'source.import' as const,
  sessionId: 's1',
  body: { operationId: 'keep-original' },
  query: {},
  authorization: {
    id: 'jti-from-verified-controller',
    expiresAt: Date.now() + 30_000,
    recentUntil: Date.now() + 10_000,
  },
});
it('reuses actual Express auth and recent-authorization middleware without forwarding credentials', async () => {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(operatorAuthMiddleware);
  app.post('/api/sessions/:id/symposium/source/import', (req, res) => {
    if (!requireRecentConnectionAuthorization(res, '')) return;
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers.cookie).toBeUndefined();
    res.json({
      owner: res.locals.authSession.id,
      operationId: req.body.operationId,
      sessionId: req.params.id,
    });
  });
  const result = await dispatchCustodianHttp(app, command(), () => {});
  expect(result).toEqual({
    status: 200,
    body: { owner: 'jti-from-verified-controller', operationId: 'keep-original', sessionId: 's1' },
  });
});
it('rejects expired channel authority before existing route mutation', async () => {
  const app = express();
  const mutate = vi.fn();
  app.use(authMiddleware);
  app.post('/api/sessions/s1/symposium/source/import', mutate);
  await expect(
    dispatchCustodianHttp(app, command(), () => {
      throw Error('epoch lost');
    }),
  ).rejects.toThrow('epoch');
  expect(mutate).not.toHaveBeenCalled();
});
it('fails closed when recent approval is absent instead of inventing it from the body', async () => {
  const app = express();
  app.use(authMiddleware);
  app.post('/api/sessions/s1/symposium/source/import', (_req, res) => {
    if (requireRecentConnectionAuthorization(res, '')) res.json({ wrong: true });
  });
  const request = command();
  delete (request.authorization as { recentUntil?: number }).recentUntil;
  expect((await dispatchCustodianHttp(app, request, () => {})).status).toBe(403);
});

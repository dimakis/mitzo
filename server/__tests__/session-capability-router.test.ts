import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { capabilityFixture } from './fixtures/session-capabilities.js';
import { createSessionCapabilityRouter } from '../session-capability-router.js';
function fixture(auth = true) {
  const { grants } = capabilityFixture();
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (auth) res.locals.authSession = { id: 'operator', expiresAt: Date.now() + 60000 };
    next();
  });
  app.use(
    '/api/sessions/:id/access-grants',
    createSessionCapabilityRouter({
      grants,
      hasSession: (id) => ['one', 'two', 'foreign'].includes(id),
    }),
  );
  return { app, grants };
}
it('requires interactive authentication and a browser intent header for mutations', async () => {
  expect((await request(fixture(false).app).get('/api/sessions/one/access-grants')).status).toBe(
    401,
  );
  const { app } = fixture();
  expect((await request(app).post('/api/sessions/one/access-grants').send({})).status).toBe(403);
  expect((await request(app).get('/api/sessions/foreign/access-grants')).status).toBe(409);
  expect((await request(app).get('/api/sessions/missing/access-grants')).status).toBe(404);
});
it('creates and revokes one explicit grant for selected same-operator conversations', async () => {
  const { app, grants } = fixture();
  const initial = await request(app).get('/api/sessions/one/access-grants');
  const expectedContexts = Object.fromEntries(
    initial.body.sessions.map((s: { sessionId: string; revision: string }) => [
      s.sessionId,
      s.revision,
    ]),
  );
  const response = await request(app)
    .post('/api/sessions/one/access-grants')
    .set('X-Mitzo-Access-Intent', 'manage-grants')
    .send({
      sessionIds: ['one', 'two'],
      capability: { kind: 'public-web' },
      durationMinutes: 60,
      expectedContexts,
    });
  expect(response.status).toBe(201);
  expect(grants.list('operator', 'two')).toHaveLength(1);
  const inventory = await request(app).get('/api/sessions/one/access-grants');
  expect(inventory.body.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([
    'one',
    'two',
  ]);
  expect(inventory.body.automaticReview.state).toBe('unavailable');
  expect(
    (
      await request(app)
        .delete('/api/sessions/one/access-grants/' + response.body.id)
        .set('X-Mitzo-Access-Intent', 'manage-grants')
    ).status,
  ).toBe(204);
  expect(grants.list('operator', 'two')).toEqual([]);
});

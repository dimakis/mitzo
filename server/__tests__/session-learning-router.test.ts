import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { EventStore } from '../event-store.js';
import { createSessionLearningRouter } from '../session-learning-router.js';
function fixture(auth = true) {
  const events = new EventStore(':memory:');
  events.upsertSession({ sessionId: 'chat', cwd: '/offline' });
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (auth) res.locals.authSession = { id: 'operator', expiresAt: Date.now() + 60000 };
    next();
  });
  app.use('/api/sessions/:id/learning', createSessionLearningRouter(events));
  return { app, events };
}
it('requires interactive auth, browser intent and exact revision; returns honest foundation status', async () => {
  const denied = fixture(false);
  try {
    expect((await request(denied.app).get('/api/sessions/chat/learning')).status).toBe(401);
  } finally {
    denied.events.close();
  }
  const { app, events } = fixture();
  try {
    expect(
      (
        await request(app)
          .patch('/api/sessions/chat/learning')
          .send({ mode: 'off', expectedRevision: 0 })
      ).status,
    ).toBe(403);
    const response = await request(app)
      .patch('/api/sessions/chat/learning')
      .set('X-Mitzo-Learning-Intent', 'set-mode')
      .send({ mode: 'deep', expectedRevision: 0 });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      policy: { mode: 'deep', historyRequest: { status: 'pending_worker' } },
      integration: { deepWorker: 'not_implemented', downstreamOffEnforcement: 'pending_mgmt' },
    });
    expect(
      (
        await request(app)
          .patch('/api/sessions/chat/learning')
          .set('X-Mitzo-Learning-Intent', 'set-mode')
          .send({ mode: 'off', expectedRevision: 0 })
      ).status,
    ).toBe(409);
    expect((await request(app).get('/api/sessions/missing/learning')).status).toBe(404);
  } finally {
    events.close();
  }
});

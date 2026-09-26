import express from 'express';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import { createSymposiumReviewRouter } from '../symposium-review-routes.js';
const stores: SymposiumReviewStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function fixture(owner?: string) {
  const store = new SymposiumReviewStore(':memory:');
  stores.push(store);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (owner) res.locals.authSession = { id: owner };
    next();
  });
  app.use(
    '/api/sessions/:id/symposium/reviews',
    createSymposiumReviewRouter({
      store,
      getHost: () => null,
      hasSession: (id) => id === 'session',
    }),
  );
  return { app, store };
}
it('requires an interactive identity even when an internal caller reaches the router', async () => {
  expect((await request(fixture().app).get('/api/sessions/session/symposium/reviews')).status).toBe(
    403,
  );
});
it('reports missing native review authority without creating a workflow or dispatching', async () => {
  const { app } = fixture('owner');
  const response = await request(app)
    .post('/api/sessions/session/symposium/reviews')
    .send({
      workflowId: 'workflow',
      acceptanceCriteria: ['criterion'],
      limits: { maxReviewRounds: 2, maxTokens: 100, maxCostUsd: null },
    });
  expect(response.status).toBe(409);
  expect(response.body.code).toBe('trusted_review_host_unavailable');
  expect((await request(app).get('/api/sessions/session/symposium/reviews')).body).toEqual({
    available: false,
    workflows: [],
  });
});
it('rejects caller fabricated findings and owner identities', async () => {
  const { app } = fixture('owner');
  expect(
    (
      await request(app)
        .post('/api/sessions/session/symposium/reviews')
        .send({ owner: 'victim', findings: [] })
    ).status,
  ).toBe(400);
  expect((await request(app).get('/api/sessions/other/symposium/reviews')).status).toBe(404);
});

it('rejects actions without the artifact the user actually inspected', async () => {
  const { app } = fixture('owner');
  expect(
    (
      await request(app)
        .post('/api/sessions/session/symposium/reviews/flow/actions')
        .send({ action: 'review' })
    ).status,
  ).toBe(400);
});

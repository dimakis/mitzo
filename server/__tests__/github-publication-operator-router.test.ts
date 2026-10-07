import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createGithubPublicationOperatorRouter } from '../github-publication-operator-router.js';
it('requires a live interactive operator, same-origin JSON and an exact ordinary session', async () => {
  const invoke = vi.fn(async () => ({ content: 'approved-result', isError: false }));
  let authenticated = false;
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (authenticated) res.locals.authSession = { id: 'operator', expiresAt: Date.now() + 60000 };
    next();
  });
  app.use(
    '/sessions/:id/publication',
    createGithubPublicationOperatorRouter({
      hasOrdinarySession: (id) => id === 'ordinary',
      invoke,
    }),
  );
  const input = {
    repositoryPath: '/sandbox/workspaces/mgmt',
    baseBranch: 'main',
    title: 'Publish',
    body: 'Review',
    draft: true,
  };
  expect((await request(app).post('/sessions/ordinary/publication').send(input)).status).toBe(401);
  authenticated = true;
  expect(
    (
      await request(app)
        .post('/sessions/ordinary/publication')
        .set('Origin', 'https://evil.invalid')
        .send(input)
    ).status,
  ).toBe(403);
  expect((await request(app).post('/sessions/symposium/publication').send(input)).status).toBe(404);
  expect(
    (
      await request(app)
        .post('/sessions/ordinary/publication')
        .send({ ...input, accountId: 'fallback' })
    ).status,
  ).toBe(400);
  expect(invoke).not.toHaveBeenCalled();
  const response = await request(app).post('/sessions/ordinary/publication').send(input);
  expect(response.status).toBe(200);
  expect(invoke).toHaveBeenCalledWith('ordinary', input, expect.any(AbortSignal));
});

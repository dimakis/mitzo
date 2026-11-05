import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { login, operatorAuthMiddleware } from '../auth.js';
import { createTelosSourceRouter } from '../telos-source-routes.js';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';

const close: (() => void)[] = [];
afterEach(() =>
  close
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
it('requires authentication and exact feedback at the HTTP boundary, then returns the retained receipt on retry', async () => {
  const f = createTelosSourceApprovalData();
  close.push(() => f.close());
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  const app = express();
  app.use(express.json());
  app.use(
    createTelosSourceRouter({
      dbPath: () => f.dbPath,
      events: f.events,
      operatorAuth: operatorAuthMiddleware,
      ordinaryConversation: (id) => id === 'planning',
      createOutcome: f.createOutcome,
    }),
  );
  const permission = await f.request({ kind: 'create', marker: 'native' });
  const path = '/api/telos/work/source/permissions/' + permission.permId;
  const review = await request(app)
    .get(path)
    .query({ sessionId: 'planning' })
    .set('Authorization', 'Bearer ' + token);
  expect(review.status).toBe(200);
  const input = {
    sessionId: 'planning',
    toolUseId: review.body.toolUseId,
    proposalSha256: review.body.proposalSha256,
    requestId: randomUUID(),
    feedback: 'Focus on mobile first.',
  };
  expect(
    (
      await request(app)
        .post(path + '/request-changes')
        .send(input)
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post(path + '/request-changes')
        .set('Authorization', 'Bearer ' + token)
        .send({ ...input, feedback: ' ' })
    ).status,
  ).toBe(400);
  const first = await request(app)
    .post(path + '/request-changes')
    .set('Authorization', 'Bearer ' + token)
    .send(input);
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({
    kind: 'telos_outcome_changes_requested',
    feedback: input.feedback,
    originalOutcome: { summary: 'Studio acoustic treatment' },
  });
  const again = await request(app)
    .post(path + '/request-changes')
    .set('Authorization', 'Bearer ' + token)
    .send(input);
  expect(again.status).toBe(200);
  expect(again.body).toEqual(first.body);
  await f.settled();
  expect(f.denialMessage()).toContain(input.feedback);
  expect(f.counts().canonicalCreates).toBe(0);
});

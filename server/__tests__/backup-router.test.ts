import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createBackupRouter } from '../backup/router.js';
it('requires interactive authentication for reads and actions; accepts no paths or configuration', async () => {
  const service = {
    overview: vi.fn(async () => ({
      ready: false,
      busy: false,
      setup: [],
      runs: [],
      lastCapture: null,
      lastCloudUpload: null,
      coverage: [],
    })),
    start: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/backups',
    createBackupRouter(service, (req, res, next) => {
      if (req.headers.authorization !== 'operator') {
        res.sendStatus(403);
        return;
      }
      res.locals.authSession = { id: 'operator' };
      next();
    }),
  );
  expect((await request(app).get('/api/backups')).status).toBe(403);
  expect((await request(app).post('/api/backups/run').send({})).status).toBe(403);
  expect(
    (
      await request(app)
        .post('/api/backups/run')
        .set('Authorization', 'operator')
        .send({ destination: '/tmp/leak' })
    ).status,
  ).toBe(400);
  expect(service.start).not.toHaveBeenCalled();
  expect(
    (await request(app).post('/api/backups/run').set('Authorization', 'operator').send({})).status,
  ).toBe(202);
  service.start.mockRejectedValue(Error('/secret/path'));
  const failed = await request(app)
    .post('/api/backups/run')
    .set('Authorization', 'operator')
    .send({});
  expect(failed.status).toBe(409);
  expect(failed.text).not.toContain('/secret');
});

import express from 'express';
import { expect, it } from 'vitest';
import { requestApplication } from './fixtures/symposium-application-http.js';

it('exercises Express JSON, cookie and error middleware without a listening server', async () => {
  const app = express();
  app.use(express.json());
  app.post('/echo', (req, res) => {
    res.cookie('fixture', 'synthetic', { httpOnly: true });
    res.status(201).json({ body: req.body, cookie: req.header('cookie'), ip: req.ip });
  });
  const result = await requestApplication(app, 'POST', '/echo', {
    body: { exact: 'UTF-8 — reviewed' },
    headers: { cookie: 'cc_auth=synthetic' },
  });
  expect(result.status).toBe(201);
  expect(result.body).toEqual({
    body: { exact: 'UTF-8 — reviewed' },
    cookie: 'cc_auth=synthetic',
    ip: '127.0.0.1',
  });
  expect(String(result.headers['set-cookie'])).toContain('fixture=synthetic');
  await expect(requestApplication(app, 'GET', '/missing')).rejects.toThrow(
    'Application route unavailable',
  );
});

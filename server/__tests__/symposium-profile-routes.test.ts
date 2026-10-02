import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { login, operatorAuthMiddleware } from '../auth.js';
import { INTERNAL_TOKEN } from '../internal-token.js';
import { SymposiumProfileStore } from '../symposium-profiles.js';
import { createSymposiumProfileRouter } from '../symposium-profile-routes.js';

const definition = {
  name: 'Reviewer',
  role: 'reviewer',
  instructions: 'Review code',
  expectedOutput: 'Findings',
  acceptanceCriteria: ['Evidence for each issue'],
  modelPolicyRole: 'reviewer',
};
let directory: string;
let store: SymposiumProfileStore;
let app: express.Express;
let token: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mitzo-profile-routes-'));
  store = new SymposiumProfileStore(join(directory, 'events.db'));
  app = express();
  app.use(express.json());
  app.use('/api/symposium/profiles', operatorAuthMiddleware, createSymposiumProfileRouter(store));
  token = (await login(process.env.AUTH_PASSPHRASE!))!;
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('owner-authenticated Symposium profile catalog', () => {
  it('rejects unauthenticated and internal-token requests', async () => {
    expect((await request(app).get('/api/symposium/profiles')).status).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/symposium/profiles')
          .set('x-internal-token', INTERNAL_TOKEN)
          .send({})
      ).status,
    ).toBe(403);
  });
  it('saves, lists, exports, imports and reads immutable portable revisions', async () => {
    const root = '/api/symposium/profiles';
    const first = await request(app).post(root).set('Authorization', `Bearer ${token}`).send({
      profileId: 'reviewer',
      expectedRevision: 0,
      idempotencyKey: 'create',
      definition,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ profileId: 'reviewer', revision: 1, definition });
    expect((await request(app).get(root).set('Authorization', `Bearer ${token}`)).body).toEqual([
      first.body,
    ]);
    const anotherLogin = (await login(process.env.AUTH_PASSPHRASE!))!;
    expect(
      (await request(app).get(root).set('Authorization', `Bearer ${anotherLogin}`)).body,
    ).toEqual([first.body]);
    const exported = await request(app)
      .get(`${root}/reviewer/1/export`)
      .set('Authorization', `Bearer ${token}`);
    expect(exported.body).toEqual(first.body);
    expect(JSON.stringify(exported.body)).not.toMatch(/accountBinding|authorityGrant|credential/);
    const imported = await request(app)
      .post(`${root}/import`)
      .set('Authorization', `Bearer ${token}`)
      .send({ artifact: exported.body, idempotencyKey: 'import-exact' });
    expect(imported.body).toEqual(first.body);
    expect(
      (await request(app).get(`${root}/reviewer/1`).set('Authorization', `Bearer ${token}`)).body,
    ).toEqual(first.body);
    expect(
      (await request(app).get(`${root}/reviewer/2`).set('Authorization', `Bearer ${token}`)).status,
    ).toBe(404);
    const conflict = await request(app)
      .post(root)
      .set('Authorization', `Bearer ${token}`)
      .send({ profileId: 'reviewer', expectedRevision: 0, idempotencyKey: 'stale', definition });
    expect(conflict.status).toBe(409);
    const second = await request(app)
      .post(root)
      .set('Authorization', `Bearer ${token}`)
      .send({
        profileId: 'reviewer',
        expectedRevision: 1,
        idempotencyKey: 'revise',
        definition: { ...definition, instructions: 'Review the revised code' },
      });
    expect(second.status).toBe(200);
    expect((await request(app).get(root).set('Authorization', `Bearer ${token}`)).body).toEqual([
      second.body,
      first.body,
    ]);
  });
  it('rejects runtime grants in portable definitions', async () => {
    const response = await request(app)
      .post('/api/symposium/profiles')
      .set('Authorization', `Bearer ${token}`)
      .send({
        profileId: 'bad',
        expectedRevision: 0,
        idempotencyKey: 'bad',
        definition: { ...definition, authorityGrant: { filesystem: 'write' } },
      });
    expect(response.status).toBe(400);
  });
});

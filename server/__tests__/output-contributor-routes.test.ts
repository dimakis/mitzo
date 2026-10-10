import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createOutputContributorRouter } from '../output-contributor-routes.js';
import {
  type OutputContributors,
  UnsupportedOutputContributorContextError,
  UNSUPPORTED_OUTPUT_CONTRIBUTOR_CONTEXT_MESSAGE,
} from '../output-contributors.js';

function fixture() {
  const contributor = {
    id: 'coordinator',
    label: 'Writer',
    accountLabel: 'Personal',
    model: 'offline',
    sessionId: null,
    outputId: '00000000-0000-4000-8000-000000000001',
    outputRevision: 1,
    status: 'idle',
    messages: [],
  };
  const service = {
    list: vi.fn(async () => ({
      contributors: [contributor],
      eligibility: { available: false, accountIds: [], reason: 'Offline fixture' },
    })),
    add: vi.fn(async () => contributor),
    message: vi.fn(async () => ({ contributor, delivery: { deliveryId: 'delivery' } })),
    stop: vi.fn(async () => contributor),
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/sessions/:id/contributors',
    (req, res, next) => {
      if (req.header('x-operator') !== 'private-owner') {
        res.sendStatus(403);
        return;
      }
      next();
    },
    createOutputContributorRouter({
      service: service as unknown as OutputContributors,
      hasSession: (id) => id === 'source',
    }),
  );
  const input = {
    requestId: 'add',
    outputId: contributor.outputId,
    outputRevision: 1,
    contextPackageDigest: 'a'.repeat(64),
    accountId: 'personal',
    model: 'offline',
    label: 'Writer',
    instructions: '',
    mode: 'ask',
    profileSelection: { profileId: 'writer', revision: 1 },
  };
  const post = (path: string, body: object) =>
    request(app)
      .post(path)
      .set('x-operator', 'private-owner')
      .set('x-connection-id', 'profile-lookup-hint')
      .send(body);
  return { app, service, contributor, input, post };
}
describe('operator-scoped output contributor routes', () => {
  it('mounts under the operator/session boundary before consulting authority or dispatch', async () => {
    const { app, service, post, input } = fixture();
    expect((await request(app).get('/api/sessions/source/contributors')).status).toBe(403);
    expect((await post('/api/sessions/missing/contributors', input)).status).toBe(404);
    expect(service.list).not.toHaveBeenCalled();
    expect(service.add).not.toHaveBeenCalled();
    const listed = await request(app)
      .get('/api/sessions/source/contributors')
      .set('x-operator', 'private-owner');
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('private, no-store');
  });
  it('forwards exact profile selection and request identities, and returns concrete contributor receipts', async () => {
    const { service, contributor, input, post } = fixture();
    const add = await post('/api/sessions/source/contributors', input);
    expect(add.body).toEqual({ contributor });
    expect(service.add).toHaveBeenCalledWith('source', input, 'profile-lookup-hint');
    const message = await post('/api/sessions/source/contributors/coordinator/messages', {
      requestId: 'turn-one',
      text: 'Continue',
    });
    expect(message.body).toEqual({ contributor, delivery: { deliveryId: 'delivery' } });
    expect(service.message).toHaveBeenCalledWith('source', 'coordinator', {
      requestId: 'turn-one',
      text: 'Continue',
    });
    const stop = await post('/api/sessions/source/contributors/coordinator/stop', {
      requestId: 'stop-one',
    });
    expect(stop.body).toEqual({ contributor });
    expect(service.stop).toHaveBeenCalledWith('source', 'coordinator', { requestId: 'stop-one' });
  });
  it('rejects caller ownership, unknown fields and malformed Stop without service effects', async () => {
    const { post, service, input } = fixture();
    expect(
      (await post('/api/sessions/source/contributors', { ...input, owner: 'other' })).status,
    ).toBe(400);
    expect(
      (
        await post('/api/sessions/source/contributors/coordinator/messages', {
          requestId: 'turn',
          text: 'Write',
          mode: 'auto',
        })
      ).status,
    ).toBe(400);
    expect((await post('/api/sessions/source/contributors/coordinator/stop', {})).status).toBe(400);
    expect(service.add).not.toHaveBeenCalled();
    expect(service.message).not.toHaveBeenCalled();
    expect(service.stop).not.toHaveBeenCalled();
  });
  it('keeps conflict details private and does not replay rejected dispatch', async () => {
    const { post, service, input } = fixture();
    service.add.mockRejectedValueOnce(
      new Error('Private credential /private/token password=secret'),
    );
    const response = await post('/api/sessions/source/contributors', input);
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).not.toContain('secret');
    expect(service.add).toHaveBeenCalledTimes(1);
  });
  it('explains unsupported profile recipes using only the fixed safe message', async () => {
    const { post, service, input } = fixture();
    const error = new UnsupportedOutputContributorContextError();
    error.message = 'Private recipe /private/token password=secret';
    service.add.mockRejectedValueOnce(error);
    const response = await post('/api/sessions/source/contributors', input);
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: UNSUPPORTED_OUTPUT_CONTRIBUTOR_CONTEXT_MESSAGE });
    expect(service.add).toHaveBeenCalledTimes(1);
  });
});

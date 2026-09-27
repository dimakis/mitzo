import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createSubscriptionLoginHandler } from '../symposium-subscription-login-route.js';

function fixture() {
  const beginLogin = vi.fn().mockResolvedValue({
    authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=fake-state',
    completed: Promise.resolve(),
  });
  const app = express();
  app.use(express.json());
  app.post(
    '/login',
    createSubscriptionLoginHandler(() => ({ beginLogin })),
  );
  return { app, beginLogin };
}

describe('personal login callback workflow (no provider calls)', () => {
  it.each([{}, { callbackTransport: 'remote' }, { callbackTransport: ['host-local'] }])(
    'refuses unprepared clients before starting OAuth: %j',
    async (body) => {
      const { app, beginLogin } = fixture();
      const response = await request(app).post('/login').send(body);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('callback_transport_required');
      expect(response.body.authorizationUrl).toBeUndefined();
      expect(response.body.transports['ssh-forwarded']).toContain(
        '-L 127.0.0.1:1455:127.0.0.1:1455',
      );
      expect(response.body.limitation).toContain('phone');
      expect(beginLogin).not.toHaveBeenCalled();
    },
  );

  it('does not infer browser reachability from loopback requests or forwarded headers', async () => {
    const { app, beginLogin } = fixture();
    const response = await request(app)
      .post('/login')
      .set('Host', 'localhost')
      .set('X-Forwarded-For', '127.0.0.1')
      .send({});
    expect(response.status).toBe(409);
    expect(beginLogin).not.toHaveBeenCalled();
  });

  it.each(['host-local', 'ssh-forwarded'])(
    'starts the explicitly prepared %s flow',
    async (mode) => {
      const { app, beginLogin } = fixture();
      const response = await request(app).post('/login').send({ callbackTransport: mode });
      expect(response.status).toBe(200);
      expect(beginLogin).toHaveBeenCalledTimes(1);
      expect(response.body.authorizationUrl).toMatch(/^https:\/\/auth.openai.com\//);
      expect(response.body.callbackUrl).toBe('http://localhost:1455/auth/callback');
      expect(response.body.callbackTransport).toBe(mode);
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it('sanitizes listener failures and gives an actionable port diagnostic', async () => {
    const { app, beginLogin } = fixture();
    beginLogin.mockRejectedValue(new Error('EADDRINUSE fake-secret'));
    const response = await request(app).post('/login').send({ callbackTransport: 'host-local' });
    expect(response.status).toBe(503);
    expect(response.body.error).toContain('port 1455');
    expect(JSON.stringify(response.body)).not.toContain('fake-secret');
  });
});

it('tracks pending/completed without exposing URLs and reports an unknown receipt after restart', async () => {
  const { createSubscriptionLoginController } =
    await import('../symposium-subscription-login-route.js');
  let finish!: () => void;
  const beginLogin = vi.fn().mockResolvedValue({
    authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=private',
    completed: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  });
  const controller = createSubscriptionLoginController(() => ({ beginLogin }));
  const app = express();
  app.use(express.json());
  app.post('/login', controller.start);
  app.get('/status', controller.status);
  expect((await request(app).get('/status')).body.state).toBe('idle');
  const start = await request(app).post('/login').send({ callbackTransport: 'host-local' });
  expect(start.body.attemptId).toEqual(expect.any(String));
  const status = await request(app).get('/status').query({ attemptId: start.body.attemptId });
  expect(status.body).toEqual({ state: 'pending', attemptId: start.body.attemptId });
  expect(status.headers['cache-control']).toBe('no-store');
  expect((await request(app).post('/login').send({ callbackTransport: 'host-local' })).status).toBe(
    409,
  );
  expect(beginLogin).toHaveBeenCalledTimes(1);
  finish();
  expect(
    (await request(app).get('/status').query({ attemptId: start.body.attemptId })).body.state,
  ).toBe('completed');
  const restarted = express();
  restarted.get('/status', createSubscriptionLoginController(() => ({ beginLogin })).status);
  expect(
    (await request(restarted).get('/status').query({ attemptId: start.body.attemptId })).body.state,
  ).toBe('unknown');
});

it('sanitizes failed completions and prevents a stale receipt from reporting a new attempt', async () => {
  const { createSubscriptionLoginController } =
    await import('../symposium-subscription-login-route.js');
  const beginLogin = vi.fn().mockImplementation(async () => ({
    authorizationUrl: 'https://auth.openai.com/oauth/authorize',
    completed: Promise.reject(new Error('token=secret')),
  }));
  const controller = createSubscriptionLoginController(() => ({ beginLogin }));
  const app = express();
  app.use(express.json());
  app.post('/login', controller.start);
  app.get('/status', controller.status);
  const first = await request(app).post('/login').send({ callbackTransport: 'host-local' });
  expect(
    (await request(app).get('/status').query({ attemptId: first.body.attemptId })).body,
  ).toEqual({ state: 'failed', attemptId: first.body.attemptId });
  const next = await request(app).post('/login').send({ callbackTransport: 'ssh-forwarded' });
  expect(next.body.attemptId).not.toBe(first.body.attemptId);
  expect(
    (await request(app).get('/status').query({ attemptId: first.body.attemptId })).body,
  ).toEqual({ state: 'unknown' });
});

it('recovers device instructions only for the owner and strips them on completion', async () => {
  const { createSubscriptionLoginController } =
    await import('../symposium-subscription-login-route.js');
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const controller = createSubscriptionLoginController(
    () => ({
      beginDeviceLogin: async () => ({
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-1234',
        expiresAt: Date.now() + 60000,
        completed,
        cancel: async () => {},
      }),
    }),
    (req) => req.header('x-owner') ?? 'one',
  );
  const app = express();
  app.use(express.json());
  app.post('/login', controller.start);
  app.get('/status', controller.status);
  app.post('/cancel', controller.cancel);
  const start = await request(app).post('/login').send({ method: 'device-code' });
  expect(start.status).toBe(200);
  expect(start.body).not.toHaveProperty('callbackUrl');
  expect((await request(app).get('/status')).body.userCode).toBe('ABCD-1234');
  expect((await request(app).get('/status').set('x-owner', 'two')).body).toEqual({
    state: 'unknown',
  });
  expect(
    (
      await request(app)
        .post('/cancel')
        .set('x-owner', 'two')
        .send({ attemptId: start.body.attemptId })
    ).body,
  ).toEqual({ state: 'unknown' });
  finish();
  const status = await request(app).get('/status');
  expect(status.body.state).toBe('completed');
  expect(status.body).not.toHaveProperty('userCode');
  expect(status.body).not.toHaveProperty('verificationUrl');
});

it('waits for allocation and physical cancellation before allowing another device attempt', async () => {
  const { createSubscriptionLoginController } =
    await import('../symposium-subscription-login-route.js');
  let allocate!: (value: unknown) => void;
  let reaped!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    reaped = resolve;
  });
  const cancel = vi.fn(() => cleanup);
  const beginDeviceLogin = vi.fn(
    () =>
      new Promise((resolve) => {
        allocate = resolve;
      }),
  );
  const controller = createSubscriptionLoginController(() => ({
    beginDeviceLogin: beginDeviceLogin as never,
  }));
  const app = express();
  app.use(express.json());
  app.post('/login', controller.start);
  app.get('/status', controller.status);
  app.post('/cancel', controller.cancel);
  const starting = request(app)
    .post('/login')
    .send({ method: 'device-code' })
    .then((response) => response);
  await vi.waitFor(() => expect(beginDeviceLogin).toHaveBeenCalledOnce());
  const pending = (await request(app).get('/status')).body;
  const cancelling = request(app)
    .post('/cancel')
    .send({ attemptId: pending.attemptId })
    .then((response) => response);
  await vi.waitFor(async () =>
    expect((await request(app).get('/status')).body.state).toBe('pending'),
  );
  expect((await request(app).post('/login').send({ method: 'device-code' })).status).toBe(409);
  let secondFinished = false;
  const secondCancel = request(app)
    .post('/cancel')
    .send({ attemptId: pending.attemptId })
    .then((response) => {
      secondFinished = true;
      return response;
    });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(secondFinished).toBe(false);
  expect((await request(app).get('/status')).body.state).toBe('pending');
  allocate({
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-1234',
    expiresAt: Date.now() + 60000,
    completed: Promise.resolve(),
    cancel,
  });
  expect((await starting).body).not.toHaveProperty('userCode');
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  expect((await request(app).post('/login').send({ method: 'device-code' })).status).toBe(409);
  reaped();
  expect((await secondCancel).body.state).toBe('cancelled');
  expect((await cancelling).body.state).toBe('cancelled');
  expect((await request(app).get('/status')).body.state).toBe('cancelled');
});

it('quarantines unconfirmed cancellation and expires receipts without claiming success', async () => {
  const { createSubscriptionLoginController } =
    await import('../symposium-subscription-login-route.js');
  const beginDeviceLogin = vi.fn(async () => ({
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-1234',
    expiresAt: Date.now() + 1000,
    completed: new Promise(() => {}),
    cancel: async () => {
      throw new Error('private failure');
    },
  }));
  const controller = createSubscriptionLoginController(() => ({ beginDeviceLogin }));
  const app = express();
  app.use(express.json());
  app.post('/login', controller.start);
  app.get('/status', controller.status);
  app.post('/cancel', controller.cancel);
  const start = await request(app).post('/login').send({ method: 'device-code' });
  const cancelled = await request(app).post('/cancel').send({ attemptId: start.body.attemptId });
  expect(cancelled.body.state).toBe('unknown');
  expect(JSON.stringify(cancelled.body)).not.toMatch(/private|ABCD/);
  expect((await request(app).post('/login').send({ method: 'device-code' })).status).toBe(409);
  expect(beginDeviceLogin).toHaveBeenCalledOnce();
});

it('expires a device allocation before its handle is available without exposing a late code', async () => {
  const { createSubscriptionLoginController } =
    await import('../symposium-subscription-login-route.js');
  let allocate!: (value: unknown) => void;
  const cancel = vi.fn(async () => {});
  const beginDeviceLogin = vi.fn(
    () =>
      new Promise((resolve) => {
        allocate = resolve;
      }),
  );
  const controller = createSubscriptionLoginController(() => ({
    beginDeviceLogin: beginDeviceLogin as never,
  }));
  const app = express();
  app.use(express.json());
  app.post('/login', controller.start);
  app.get('/status', controller.status);
  const starting = request(app)
    .post('/login')
    .send({ method: 'device-code' })
    .then((response) => response);
  await vi.waitFor(() => expect(beginDeviceLogin).toHaveBeenCalledOnce());
  const pending = (await request(app).get('/status')).body;
  const now = vi.spyOn(Date, 'now').mockReturnValue(pending.expiresAt + 1);
  try {
    const status = request(app)
      .get('/status')
      .then((response) => response);
    await new Promise((resolve) => setTimeout(resolve, 20));
    allocate({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
      expiresAt: Date.now() + 60000,
      completed: Promise.resolve(),
      cancel,
    });
    expect((await starting).body).not.toHaveProperty('userCode');
    expect((await status).body.state).toBe('expired');
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    now.mockRestore();
  }
});

it('returns only verified display identity from an already completed device start', async () => {
  const { createSubscriptionLoginController } =
    await import('../symposium-subscription-login-route.js');
  const controller = createSubscriptionLoginController(() => ({
    beginDeviceLogin: async () => ({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
      expiresAt: Date.now() + 60000,
      cancel: async () => {},
      completed: Promise.resolve({
        email: 'verified@example.invalid',
        planType: 'pro',
        binding: { accountLabel: 'Personal' },
        access_token: 'secret-never-export',
      }),
    }),
  }));
  const app = express();
  app.use(express.json());
  app.post('/login', controller.start);
  app.get('/status', controller.status);
  await request(app).post('/login').send({ method: 'device-code' });
  const status = await request(app).get('/status');
  expect(status.body).toMatchObject({
    state: 'completed',
    account: { email: 'verified@example.invalid', planType: 'pro', label: 'Personal' },
  });
  expect(JSON.stringify(status.body)).not.toMatch(/secret|ABCD|access_token/);
});

it.each([
  ['cancel', true],
  ['expire', true],
  ['cancel', false],
  ['expire', false],
] as const)(
  'handles allocation failure during %s with confirmed cleanup %s',
  async (action, clean) => {
    const { createSubscriptionLoginController } =
      await import('../symposium-subscription-login-route.js');
    let reject!: (error: Error) => void;
    const beginDeviceLogin = vi.fn(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const controller = createSubscriptionLoginController(() => ({
      beginDeviceLogin: beginDeviceLogin as never,
    }));
    const app = express();
    app.use(express.json());
    app.post('/login', controller.start);
    app.get('/status', controller.status);
    app.post('/cancel', controller.cancel);
    const starting = request(app)
      .post('/login')
      .send({ method: 'device-code' })
      .then((r) => r);
    await vi.waitFor(() => expect(beginDeviceLogin).toHaveBeenCalledOnce());
    const pending = (await request(app).get('/status')).body;
    const now = vi.spyOn(Date, 'now');
    if (action === 'expire') now.mockReturnValue(pending.expiresAt + 1);
    const stopping = (
      action === 'cancel'
        ? request(app).post('/cancel').send({ attemptId: pending.attemptId })
        : request(app).get('/status')
    ).then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { DeviceLoginCleanupError } = await import('../symposium-device-login.js');
    reject(
      clean
        ? new Error('Allocation failed after confirmed cleanup')
        : new DeviceLoginCleanupError(),
    );
    expect((await starting).status).toBe(503);
    expect((await stopping).body).toMatchObject({
      state: clean ? (action === 'cancel' ? 'cancelled' : 'expired') : 'unknown',
      ...(!clean ? { retryBlocked: true } : {}),
    });
    now.mockRestore();
    beginDeviceLogin.mockRejectedValue(new Error('Clean allocation failure'));
    expect((await request(app).post('/login').send({ method: 'device-code' })).status).toBe(
      clean ? 503 : 409,
    );
    expect(beginDeviceLogin).toHaveBeenCalledTimes(clean ? 2 : 1);
  },
);

it('keeps concurrent cancellation pending until cleanup failure is known', async () => {
  const { createSubscriptionLoginController } =
    await import('../symposium-subscription-login-route.js');
  let fail!: (error: Error) => void;
  const cancel = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      }),
  );
  const controller = createSubscriptionLoginController(() => ({
    beginDeviceLogin: async () => ({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
      expiresAt: Date.now() + 60000,
      completed: new Promise(() => {}),
      cancel,
    }),
  }));
  const app = express();
  app.use(express.json());
  app.post('/login', controller.start);
  app.get('/status', controller.status);
  app.post('/cancel', controller.cancel);
  const started = (await request(app).post('/login').send({ method: 'device-code' })).body;
  const stopping = request(app)
    .post('/cancel')
    .send({ attemptId: started.attemptId })
    .then((r) => r);
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  const pending = (await request(app).get('/status')).body;
  expect(pending.state).toBe('pending');
  expect(pending).not.toHaveProperty('userCode');
  fail(new Error('Cleanup unconfirmed'));
  expect((await stopping).body).toMatchObject({ state: 'unknown', retryBlocked: true });
  expect((await request(app).post('/login').send({ method: 'device-code' })).status).toBe(409);
});

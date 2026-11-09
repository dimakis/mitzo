import './fixtures/offline-user-home.js';
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { login, authMiddleware } from '../auth.js';
import { NotificationStore } from '../notification-store.js';
import { NotificationCenter } from '../notification-center.js';
import { UnifiedInbox } from '../unified-inbox.js';
import { notificationRouter } from '../notification-routes.js';
import { INTERNAL_TOKEN } from '../internal-token.js';
import { registerPending, removePending } from '../permissions.js';

async function setup(path = ':memory:') {
  const store = new NotificationStore(path);
  const center = new NotificationCenter(store, {
    push: vi.fn().mockResolvedValue({ status: 'accepted', acceptedDevices: [] }),
    changed: vi.fn(),
    configured: () => false,
    devices: () => 0,
    sessionTitle: () => undefined,
  });
  const app = express();
  app.use(express.json(), cookieParser(), authMiddleware);
  app.use('/api/notifications', notificationRouter(center));
  const token = await login(process.env.AUTH_PASSPHRASE!);
  return {
    app,
    store,
    center,
    token,
    close() {
      center.close();
      store.close();
    },
  };
}
describe('notification API', () => {
  it('rechecks a replaced live permission scope instead of trusting the stored banner', async () => {
    const s = await setup();
    const resolver = vi.fn();
    const permId = 'changed-live-scope';
    const original = { permId, toolName: 'Bash', toolInput: 'npm test', sessionId: 's1' };
    registerPending(permId, 'Bash', resolver, { command: 'npm test' }, 'elevated', 's1', original);
    registerPending(permId, 'Bash', resolver, { command: 'npm test' }, 'elevated', 's1', {
      ...original,
      allowSessionGrant: false,
    });
    try {
      const result = await request(s.app)
        .post(`/api/notifications/permission:${permId}/respond`)
        .set('Authorization', `Bearer ${s.token}`)
        .send({
          sessionId: 's1',
          decision: 'always',
          requestId: 'a0d3463d-b88c-46b0-9c9b-b63b1666da21',
          nativeAction: 'ALLOW_SESSION_ACTION',
          reviewed: { toolName: 'Bash', toolInput: 'npm test' },
        });
      expect(result.status).toBe(409);
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      removePending(permId);
      s.close();
    }
  });
  it.each([
    ['ALLOW_ONCE_ACTION', 'once', 'request', 'Bash'],
    ['ALLOW_SESSION_ACTION', 'always', 'request', 'Bash'],
    ['ALLOW_CONVERSATION_ACTION', 'always', 'conversation', 'GrantIntegration'],
    ['ALLOW_SEARCH_SESSION_ACTION', 'always', 'session', 'RequestWebAccess'],
    ['DENY_PERMISSION_ACTION', 'deny', 'request', 'Bash'],
  ] as const)(
    'settles %s with its original owning-adapter scope',
    async (nativeAction, decision, scope, toolName) => {
      const s = await setup();
      const resolver = vi.fn();
      const permId = 'native-scope';
      const toolInput = toolName === 'Bash' ? 'npm test' : JSON.stringify({ operation: 'search' });
      registerPending(
        permId,
        toolName,
        resolver,
        toolName === 'Bash' ? { command: 'npm test' } : { operation: 'search' },
        'unknown',
        's1',
        { permId, toolName, toolInput, sessionId: 's1', approvalScope: scope },
      );
      try {
        const result = await request(s.app)
          .post(`/api/notifications/permission:${permId}/respond`)
          .set('Authorization', `Bearer ${s.token}`)
          .send({
            sessionId: 's1',
            decision,
            requestId: '0cb76542-541b-4e4b-a36a-176b4b24cabc',
            nativeAction,
            reviewed: { toolName, toolInput },
          });
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({
          ok: true,
          receipt: {
            nativeAction,
            decision,
            status: 'settled',
            resolution: decision === 'deny' ? 'denied' : 'allowed',
          },
        });
        expect(resolver).toHaveBeenCalledWith(
          expect.objectContaining({
            decisionClassification:
              decision === 'deny'
                ? 'user_reject'
                : decision === 'once'
                  ? 'user_temporary'
                  : 'user_permanent',
          }),
        );
      } finally {
        removePending(permId);
        s.close();
      }
    },
  );

  it.each(['received', 'settled'] as const)(
    'reopens a durable %s receipt and never replays its approval',
    async (status) => {
      const root = mkdtempSync(join(tmpdir(), 'native-response-recovery-'));
      const path = join(root, 'notifications.db');
      let s = await setup(path);
      const resolver = vi.fn();
      const permId = 'durable-native';
      const id = `permission:${permId}`;
      const body = {
        sessionId: 's1',
        decision: 'always',
        requestId: 'f6a4394f-cf30-4c10-8429-16d1c5dfeb70',
        nativeAction: 'ALLOW_SESSION_ACTION',
        reviewed: { toolName: 'Bash', toolInput: 'npm test' },
      };
      registerPending(permId, 'Bash', resolver, { command: 'npm test' }, 'elevated', 's1', {
        permId,
        toolName: 'Bash',
        toolInput: 'npm test',
        sessionId: 's1',
      });
      try {
        if (status === 'received') {
          s.store.responses.begin(
            {
              requestId: body.requestId,
              notificationId: id,
              sessionId: 's1',
              nativeAction: body.nativeAction,
              decision: 'always',
              receivedAt: Date.now(),
              status,
            },
            createHash('sha256').update(JSON.stringify(body)).digest('hex'),
          );
        } else {
          const result = await request(s.app)
            .post(`/api/notifications/${id}/respond`)
            .set('Authorization', `Bearer ${s.token}`)
            .send(body);
          expect(result.body.ok).toBe(true);
        }
        const count = resolver.mock.calls.length;
        s.close();
        s = await setup(path);
        const result = await request(s.app)
          .post(`/api/notifications/${id}/respond`)
          .set('Authorization', `Bearer ${s.token}`)
          .send(body);
        expect(result.body).toMatchObject({
          ok: status === 'settled',
          receipt: { status, decision: 'always', nativeAction: body.nativeAction },
        });
        expect(resolver).toHaveBeenCalledTimes(count);
        const recovered = await request(s.app)
          .get(`/api/notifications/${id}/responses/${body.requestId}?sessionId=s1`)
          .set('Authorization', `Bearer ${s.token}`);
        expect(recovered.body).toEqual(result.body);
      } finally {
        removePending(permId);
        s.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it('retains the exact native session action and settled receipt without replaying it', async () => {
    const s = await setup();
    const resolver = vi.fn(() => ({ behavior: 'allow' }));
    const permId = 'native-session-receipt';
    const requestId = '46b3a339-3307-4b37-82d4-d2776d4c3c10';
    registerPending(permId, 'Bash', resolver, { command: 'npm test' }, 'elevated', 's1', {
      permId,
      toolName: 'Bash',
      toolInput: 'npm test',
      sessionId: 's1',
      approvalScope: 'request',
      sessionGrantDescription: 'Workspace commands for this session',
    });
    const path = `/api/notifications/permission:${permId}`;
    const body = {
      sessionId: 's1',
      decision: 'always',
      requestId,
      nativeAction: 'ALLOW_SESSION_ACTION',
      reviewed: {
        toolName: 'Bash',
        toolInput: 'npm test',
        sessionGrantDescription: 'Workspace commands for this session',
      },
    };
    const auth = { Authorization: `Bearer ${s.token}` };
    try {
      const first = await request(s.app)
        .post(path + '/respond')
        .set(auth)
        .send(body);
      expect(first.status).toBe(200);
      expect(first.body.receipt).toMatchObject({
        requestId,
        nativeAction: 'ALLOW_SESSION_ACTION',
        decision: 'always',
        sessionId: 's1',
        status: 'settled',
        resolution: 'allowed',
      });
      const retry = await request(s.app)
        .post(path + '/respond')
        .set(auth)
        .send(body);
      expect(retry.body).toEqual(first.body);
      expect(resolver).toHaveBeenCalledOnce();
      const recovered = await request(s.app)
        .get(path + `/responses/${requestId}?sessionId=s1`)
        .set(auth);
      expect(recovered.body.receipt).toEqual(first.body.receipt);
      expect(
        (
          await request(s.app)
            .post(path + '/respond')
            .set(auth)
            .send({ ...body, decision: 'once' })
        ).status,
      ).toBe(409);
      expect(
        (
          await request(s.app)
            .get(path + `/responses/${requestId}?sessionId=other`)
            .set(auth)
        ).status,
      ).toBe(404);
      expect((await request(s.app).get(path + `/responses/${requestId}?sessionId=s1`)).status).toBe(
        401,
      );
    } finally {
      removePending(permId);
      s.close();
    }
  });

  it.each(['revoked', 'throw', 'expired', 'changed-scope'])(
    'never confirms a native allow when %s',
    async (failure) => {
      const s = await setup();
      const resolver = vi.fn(() => {
        if (failure === 'throw') throw Error('private cause with credential');
        return { behavior: 'deny' };
      });
      const permId = 'native-' + failure;
      const requestId = '891d6bdd-88d6-4868-b83f-73e1215cf611';
      registerPending(permId, 'Bash', resolver, { command: 'npm test' }, 'elevated', 's1', {
        permId,
        toolName: 'Bash',
        toolInput: 'npm test',
        sessionId: 's1',
        allowSessionGrant: failure !== 'changed-scope',
        expiresAt: Date.now() + (failure === 'expired' ? -1 : 60000),
      });
      const path = `/api/notifications/permission:${permId}`;
      const body = {
        sessionId: 's1',
        decision: 'always',
        requestId,
        nativeAction: 'ALLOW_SESSION_ACTION',
        reviewed: { toolName: 'Bash', toolInput: 'npm test' },
      };
      const auth = { Authorization: `Bearer ${s.token}` };
      try {
        const response = await request(s.app)
          .post(path + '/respond')
          .set(auth)
          .send(body);
        expect(response.body.ok).not.toBe(true);
        expect(JSON.stringify(response.body)).not.toContain('private cause');
        const receipt = await request(s.app)
          .get(path + `/responses/${requestId}?sessionId=s1`)
          .set(auth);
        expect(receipt.status).toBe(200);
        expect(receipt.body.receipt).toMatchObject({
          requestId,
          decision: 'always',
          nativeAction: 'ALLOW_SESSION_ACTION',
        });
        expect(receipt.body.receipt.resolution).not.toBe('allowed');
        await request(s.app)
          .post(path + '/respond')
          .set(auth)
          .send(body);
        expect(resolver).toHaveBeenCalledTimes(
          failure === 'expired' || failure === 'changed-scope' ? 0 : 1,
        );
      } finally {
        removePending(permId);
        s.close();
      }
    },
  );
  it.each(['/inbox:changed.md/archive', '/archive-resolved'])(
    'refreshes newly actionable inbox sources before %s',
    async (path) => {
      const s = await setup();
      const root = mkdtempSync(join(tmpdir(), 'notification-archive-source-'));
      const inbox = new UnifiedInbox(s.store, () => root);
      s.center.setAsyncInboxReconciler(() => inbox.reconcileAsync());
      const source = join(root, 'changed.md');
      try {
        writeFileSync(source, '---\nstatus: pending\n---\n# Report\nInformational update');
        await s.center.reconcileAsync();
        expect(s.store.get('inbox:changed.md')?.inbox?.needsAttention).toBe(false);
        writeFileSync(
          source,
          '---\nstatus: pending\naction: review\n---\n# Report\nReview required',
        );
        const response = await request(s.app)
          .post('/api/notifications' + path)
          .set('Authorization', `Bearer ${s.token}`);
        expect(response.status).toBe(path === '/archive-resolved' ? 200 : 409);
        if (path === '/archive-resolved') expect(response.body.archived).toBe(0);
        expect(s.store.get('inbox:changed.md')).toMatchObject({
          archivedAt: null,
          inbox: { needsAttention: true },
        });
      } finally {
        s.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it.each(['/done/archive', '/archive-resolved'])(
    'retains notifications when source reconciliation fails before %s',
    async (path) => {
      const s = await setup();
      s.store.record({ id: 'done', kind: 'session', title: 'Done', body: '' });
      s.center.setAsyncInboxReconciler(async () => {
        throw Error('unreadable source');
      });
      try {
        const response = await request(s.app)
          .post('/api/notifications' + path)
          .set('Authorization', `Bearer ${s.token}`);
        expect(response.status).toBe(503);
        expect(s.store.get('done')?.archivedAt).toBeNull();
      } finally {
        s.close();
      }
    },
  );
  it('keeps permission responses, preferences and receipts available when inbox scans fail', async () => {
    const s = await setup();
    const scan = vi.fn(async () => {
      throw Error('unreadable archive');
    });
    s.center.setAsyncInboxReconciler(scan);
    const resolver = vi.fn();
    const permId = 'inbox-independent-permission';
    registerPending(permId, 'Bash', resolver, {}, 'elevated', 's1', {
      permId,
      toolName: 'Bash',
      toolInput: 'offline command',
      sessionId: 's1',
    });
    const auth = `Bearer ${s.token}`;
    try {
      expect(
        (
          await request(s.app)
            .put('/api/notifications/preferences')
            .set('Authorization', auth)
            .send({ updates: false })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(s.app)
            .post(`/api/notifications/permission:${permId}/read`)
            .set('Authorization', auth)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(s.app)
            .get(`/api/notifications/permission:${permId}`)
            .set('Authorization', auth)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(s.app)
            .post(`/api/notifications/permission:${permId}/respond`)
            .set('Authorization', auth)
            .send({ sessionId: 's1', decision: 'deny' })
        ).status,
      ).toBe(200);
      expect(resolver).toHaveBeenCalledOnce();
      expect(scan).not.toHaveBeenCalled();
      expect(
        (await request(s.app).get('/api/notifications').set('Authorization', auth)).status,
      ).toBe(503);
      expect(
        (await request(s.app).get('/api/notifications/inbox:missing.md').set('Authorization', auth))
          .status,
      ).toBe(503);
    } finally {
      removePending(permId);
      s.close();
    }
  });
  it('keeps structured questions answer-only and denies untrusted session grants', async () => {
    const s = await setup();
    const resolver = vi.fn();
    const permId = 'question-retain';
    try {
      registerPending(permId, 'AskUserQuestion', resolver, {}, 'unknown', 's1', {
        permId,
        toolName: 'AskUserQuestion',
        toolInput: '{}',
        sessionId: 's1',
        questions: [
          {
            id: 'q',
            question: 'Choose?',
            header: 'Choice',
            multiSelect: false,
            options: [{ label: 'Yes', description: '' }],
          },
        ],
      });
      const path = `/api/notifications/permission:${permId}/respond`;
      const body = { sessionId: 's1', decision: 'always', answers: { q: ['Yes'] } };
      expect((await request(s.app).post(path).send(body)).status).toBe(401);
      expect(
        (await request(s.app).post(path).set('X-Internal-Token', INTERNAL_TOKEN).send(body)).status,
      ).toBe(403);
      expect(
        (await request(s.app).post(path).set('Authorization', `Bearer ${s.token}`).send(body))
          .status,
      ).toBe(400);
      expect(resolver).not.toHaveBeenCalled();
      expect(
        (
          await request(s.app)
            .post(path)
            .set('Authorization', `Bearer ${s.token}`)
            .send({ ...body, decision: 'once' })
        ).status,
      ).toBe(200);
      expect(resolver).toHaveBeenCalledWith(
        expect.objectContaining({ decisionClassification: 'user_temporary' }),
      );
    } finally {
      removePending(permId);
      s.close();
    }
  });

  it('requires login and rejects invalid preferences', async () => {
    const s = await setup();
    expect((await request(s.app).get('/api/notifications')).status).toBe(401);
    expect(
      (
        await request(s.app)
          .put('/api/notifications/preferences')
          .set('Authorization', `Bearer ${s.token}`)
          .send({ quietStart: '25:00' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(s.app)
          .put('/api/notifications/preferences')
          .set('Authorization', `Bearer ${s.token}`)
          .send({ timezone: 'Mars' })
      ).status,
    ).toBe(400);
    s.close();
  });
  it('keeps internal agents out and reads older linked items independently of pagination', async () => {
    const s = await setup();
    s.store.record({ id: 'old', kind: 'session', title: 'Older result', body: 'Summary' }, 1);
    expect(
      (await request(s.app).get('/api/notifications/old').set('X-Internal-Token', INTERNAL_TOKEN))
        .status,
    ).toBe(403);
    const response = await request(s.app)
      .get('/api/notifications/old')
      .set('Authorization', `Bearer ${s.token}`);
    expect(response.status).toBe(200);
    expect(response.body.title).toBe('Older result');
    s.close();
  });
  it.each([
    { toolName: 'RequestWebAccess', operation: 'search' },
    { toolName: 'RequestWebAccess', operation: 'fetch' },
    { toolName: 'Bash', operation: 'shell' },
    { toolName: 'Write', operation: 'write' },
    { toolName: 'ExecuteProviderCapability', operation: 'capability' },
    { toolName: 'mcp__telos__TelosSaveArtifact', operation: 'artifact' },
  ])(
    'accepts authenticated session retention for $toolName $operation approvals',
    async ({ toolName, operation }) => {
      const s = await setup();
      const resolver = vi.fn();
      const permId = `session-${operation}`;
      const input = { operation, query: 'Pricing', reason: 'Research' };
      registerPending(permId, toolName, resolver, input, 'unknown', 's1', {
        permId,
        toolName,
        toolInput: JSON.stringify(input),
        sessionId: 's1',
        approvalScope: operation === 'search' ? 'session' : 'request',
      });
      const response = await request(s.app)
        .post(`/api/notifications/permission:${permId}/respond`)
        .set('Authorization', `Bearer ${s.token}`)
        .send({ sessionId: 's1', decision: 'always' });
      expect(response.status).toBe(200);
      expect(resolver).toHaveBeenCalledWith(
        expect.objectContaining({ decisionClassification: 'user_permanent' }),
      );
      removePending(permId);
      s.close();
    },
  );
  it('permits session retention while durable conversation grants require session review', async () => {
    const s = await setup();
    const resolver = vi.fn();
    const permId = 'durable-grant';
    registerPending(permId, 'GrantIntegration', resolver, {}, 'elevated', 's1', {
      permId,
      toolName: 'GrantIntegration',
      toolInput: '{}',
      sessionId: 's1',
      approvalScope: 'conversation',
    });
    const response = await request(s.app)
      .post(`/api/notifications/permission:${permId}/respond`)
      .set('Authorization', `Bearer ${s.token}`)
      .send({ sessionId: 's1', decision: 'once' });
    expect(response.status).toBe(400);
    expect(resolver).not.toHaveBeenCalled();
    const sessionResponse = await request(s.app)
      .post(`/api/notifications/permission:${permId}/respond`)
      .set('Authorization', `Bearer ${s.token}`)
      .send({ sessionId: 's1', decision: 'always' });
    expect(sessionResponse.status).toBe(200);
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({ decisionClassification: 'user_permanent' }),
    );
    removePending(permId);
    s.close();
  });
  it('reads without resolving and rejects stale or cross-session approvals', async () => {
    const s = await setup();
    const resolver = vi.fn();
    const permId = 'route-perm';
    registerPending(permId, 'Bash', resolver, {}, 'elevated', 's1', {
      permId,
      toolName: 'Bash',
      toolInput: 'npm test',
      sessionId: 's1',
      expiresAt: Date.now() + 60000,
    });
    const auth = `Bearer ${s.token}`;
    expect(
      (
        await request(s.app)
          .post(`/api/notifications/permission:${permId}/read`)
          .set('Authorization', auth)
      ).status,
    ).toBe(200);
    expect(s.store.feed('needs').needsYou).toBe(1);
    expect(
      (
        await request(s.app)
          .post(`/api/notifications/permission:${permId}/respond`)
          .set('Authorization', auth)
          .send({ sessionId: 'other', decision: 'once' })
      ).status,
    ).toBe(409);
    expect(resolver).not.toHaveBeenCalled();
    expect(
      (
        await request(s.app)
          .post(`/api/notifications/permission:${permId}/respond`)
          .set('Authorization', auth)
          .send({ sessionId: 's1', decision: 'once' })
      ).status,
    ).toBe(200);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(
      (
        await request(s.app)
          .post(`/api/notifications/permission:${permId}/respond`)
          .set('Authorization', auth)
          .send({ sessionId: 's1', decision: 'once' })
      ).status,
    ).toBe(409);
    removePending(permId);
    s.close();
  });
});

it('archives and restores for operators without hiding a live approval or granting consent', async () => {
  const s = await setup();
  const resolver = vi.fn();
  const permId = 'archive-live';
  try {
    registerPending(permId, 'Bash', resolver, {}, 'elevated', 's1', {
      permId,
      toolName: 'Bash',
      toolInput: 'npm test',
      sessionId: 's1',
      expiresAt: Date.now() + 60000,
    });
    s.store.record({ id: 'done', kind: 'session', title: 'Done', body: '' });
    s.store.markRead('done');
    for (const path of ['/archive-resolved', '/done/archive', '/done/restore']) {
      expect((await request(s.app).post('/api/notifications' + path)).status).toBe(401);
      expect(
        (
          await request(s.app)
            .post('/api/notifications' + path)
            .set('X-Internal-Token', INTERNAL_TOKEN)
        ).status,
      ).toBe(403);
    }
    const auth = { Authorization: `Bearer ${s.token}` };
    expect(
      (await request(s.app).post(`/api/notifications/permission:${permId}/archive`).set(auth))
        .status,
    ).toBe(409);
    expect((await request(s.app).post('/api/notifications/missing/archive').set(auth)).status).toBe(
      404,
    );
    expect(
      (await request(s.app).post('/api/notifications/archive-resolved').set(auth)).body.archived,
    ).toBe(1);
    const feed = await request(s.app).get('/api/notifications?filter=archived').set(auth);
    expect(feed.status).toBe(200);
    expect(feed.body.items.map((i: { id: string }) => i.id)).toEqual(['done']);
    expect((await request(s.app).get('/api/notifications/done').set(auth)).body.archivedAt).toEqual(
      expect.any(Number),
    );
    expect((await request(s.app).post('/api/notifications/done/restore').set(auth)).status).toBe(
      200,
    );
    expect(s.store.feed().items.some((i) => i.id === 'done')).toBe(true);
    expect(resolver).not.toHaveBeenCalled();
  } finally {
    removePending(permId);
    s.close();
  }
});

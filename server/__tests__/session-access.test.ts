import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { projectSessionAccess, createSessionAccessRouter } from '../session-access.js';
import type { ManagedSession } from '@mitzo/harness';
import { reviewedHandlerSourceArtifacts } from '../connections/reviewed-handler-artifacts.js';

const live = () =>
  ({
    sessionId: 'one',
    model: 'actual-model',
    mode: 'auto',
    accountBinding: {
      accountId: 'account',
      accountLabel: 'Account',
      provider: 'anthropic-vertex',
      model: 'initial-model',
      profileRevision: 'profile-1',
    },
    sessionAllowList: new Set(['Bash']),
    activeSkillPolicy: new Set(['Read']),
    pendingPermissionModes: new Map([[Symbol(), 'ask']]),
  }) as ManagedSession;

describe('ordinary session Access evidence', () => {
  it('includes the read-only operator projection in the reviewed composition source inventory', () => {
    expect(reviewedHandlerSourceArtifacts).toHaveProperty('../session-access.ts');
    expect(reviewedHandlerSourceArtifacts).toHaveProperty('../runtime-readiness.ts');
    expect(reviewedHandlerSourceArtifacts).toHaveProperty(
      '../../packages/protocol/src/runtime-readiness.ts',
    );
  });
  it('projects actual binding, restrictive effective mode and scoped grants, never configuration as availability', () => {
    const value = projectSessionAccess(
      'one',
      live(),
      [
        {
          permId: 'p',
          sessionId: 'one',
          toolName: 'Bash',
          toolInput: 'SECRET',
          approvalScope: 'request',
        },
      ],
      123,
    );
    expect(value).toMatchObject({
      sessionId: 'one',
      observedAt: 123,
      state: 'current',
      model: 'actual-model',
      mode: 'ask',
      grants: ['Bash'],
      skillCeiling: ['Read'],
      attachments: null,
      tools: null,
      limits: null,
      pending: [{ permId: 'p', toolName: 'Bash', scope: 'request' }],
    });
    expect(JSON.stringify(value)).not.toContain('SECRET');
  });
  it('fails closed for missing, mismatched and invalid live owners', () => {
    for (const owner of [
      undefined,
      { ...live(), sessionId: 'other' },
      { ...live(), accountBinding: { ...live().accountBinding!, provider: 'unavailable' } },
    ]) {
      expect(
        projectSessionAccess('one', owner as ManagedSession | undefined, [], 123),
      ).toMatchObject({ state: 'unknown', mode: null, grants: null, pending: null, tools: null });
    }
  });
  it.each(['openai', 'openai-codex', 'anthropic-vertex', 'google-vertex'])(
    'includes shared observations for %s without implying service readiness',
    (provider) => {
      const owner = live();
      owner.accountBinding!.provider = provider;
      const value = projectSessionAccess('one', owner, [], 123);
      expect(value).toMatchObject({
        state: 'current',
        account: { provider },
        model: 'actual-model',
      });
      expect(value.readiness).toMatchObject({
        version: 1,
        session: { state: 'observed', account: { provider }, mode: 'ask' },
        execution: { state: 'unknown', reason: 'not_observed' },
        capabilities: { state: 'unknown', reason: 'not_observed' },
      });
    },
  );
  it('projects the persisted runtime as configuration through the same contract', () => {
    const binding = {
      version: 2,
      account: { accountId: 'account', provider: 'anthropic-vertex', profileRevision: 'profile-1' },
      harness: { implementation: 'claude-sdk' },
      execution: { location: 'local', targetId: 'mac', targetRevision: 'revision-1' },
    };
    const value = projectSessionAccess('one', live(), [], 123, { binding });
    expect(value.readiness.execution).toEqual({ state: 'configured', binding });
    expect(value.readiness.capabilities.state).toBe('unknown');
  });
  it.each([
    ['257 permissions', Array.from({ length: 257 }, (_, i) => `Tool${i}`)],
    ['long permission names', [`mcp__${'long_name_'.repeat(25)}__read`]],
  ])('keeps Access available for valid harness state with %s', async (_name, permissions) => {
    const owner = live();
    owner.sessionAllowList = new Set(permissions);
    owner.activeSkillPolicy = new Set(permissions);
    const app = express();
    app.use((_req, res, next) => {
      res.locals.authSession = { id: 'test', expiresAt: Date.now() + 60000 };
      next();
    });
    app.use(
      '/api/sessions/:id/access',
      createSessionAccessRouter({
        hasSession: () => true,
        read: () =>
          projectSessionAccess('one', owner, [
            {
              permId: 'pending',
              sessionId: 'one',
              toolName: 'Bash',
              toolInput: '{}',
              approvalScope: 'request',
            },
          ]),
      }),
    );
    const response = await request(app).get('/api/sessions/one/access');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      state: 'current',
      account: { accountId: 'account' },
      grants: [...permissions].sort(),
      skillCeiling: [...permissions].sort(),
      pending: [{ permId: 'pending', toolName: 'Bash', scope: 'request' }],
      readiness: {
        session: {
          state: 'observed',
          grants: [...permissions].sort(),
          skillCeiling: [...permissions].sort(),
        },
      },
    });
  });
  it('requires operator authentication and visible ordinary session; no mutation route or provider calls', async () => {
    const read = vi.fn(() => projectSessionAccess('one', live(), [], 123));
    const app = express();
    app.use((req, res, next) => {
      if (req.header('x-browser') === 'yes')
        res.locals.authSession = { id: 'test', expiresAt: Date.now() + 60000 };
      next();
    });
    app.use(
      '/api/sessions/:id/access',
      createSessionAccessRouter({ hasSession: (id) => id === 'one', read }),
    );
    expect((await request(app).get('/api/sessions/one/access')).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    const response = await request(app).get('/api/sessions/one/access').set('x-browser', 'yes');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.readiness.capabilities).toEqual({
      state: 'unknown',
      reason: 'not_observed',
    });
    const injected = await request(app)
      .get('/api/sessions/one/access?ownerRevision=fake&observation=ready')
      .set('x-browser', 'yes');
    expect(injected.body.readiness.capabilities.state).toBe('unknown');
    expect(
      (await request(app).get('/api/sessions/hidden/access').set('x-browser', 'yes')).status,
    ).toBe(404);
    expect(
      (await request(app).post('/api/sessions/one/access').set('x-browser', 'yes')).status,
    ).toBe(404);
  });
});

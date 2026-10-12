import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { projectSessionAccess, createSessionAccessRouter } from '../session-access.js';
import type { ManagedSession } from '@mitzo/harness';

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
    },
    sessionAllowList: new Set(['Bash']),
    activeSkillPolicy: new Set(['Read']),
    pendingPermissionModes: new Map([[Symbol(), 'ask']]),
  }) as ManagedSession;

describe('ordinary session Access evidence', () => {
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
  it('fails closed for missing, mismatched and unsupported live owners', () => {
    for (const owner of [
      undefined,
      { ...live(), sessionId: 'other' },
      { ...live(), accountBinding: { ...live().accountBinding!, provider: 'openai-codex' } },
    ]) {
      expect(
        projectSessionAccess('one', owner as ManagedSession | undefined, [], 123),
      ).toMatchObject({ state: 'unknown', mode: null, grants: null, pending: null, tools: null });
    }
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
    expect(
      (await request(app).get('/api/sessions/hidden/access').set('x-browser', 'yes')).status,
    ).toBe(404);
    expect(
      (await request(app).post('/api/sessions/one/access').set('x-browser', 'yes')).status,
    ).toBe(404);
  });
});

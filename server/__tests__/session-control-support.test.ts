import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ManagedSession } from '@mitzo/harness';
import { SessionControlSupportSchema } from '@mitzo/protocol';
import { createSessionAccessRouter, projectSessionAccess } from '../session-access.js';

function selected(provider = 'openai-codex', harness = 'codex', location = 'local') {
  const account = { accountId: 'selected', provider, profileRevision: 'profile-1' };
  const binding = {
    version: 2,
    account,
    harness: { implementation: harness },
    execution: { location, targetId: 'target', targetRevision: 'target-1' },
  };
  const session = {
    sessionId: 'chat',
    accountBinding: { ...account, accountLabel: 'Selected account', model: 'offline-fixture' },
    ordinaryRuntimeOwner: { location },
    abortController: new AbortController(),
    mode: 'auto',
    cwd: '/task',
    sessionAllowList: new Set(['Bash']),
  } as ManagedSession;
  return { session, binding };
}

describe('session controls through the existing Access owner', () => {
  it.each([
    ['openai-codex', 'codex', 'local'],
    ['openai-codex', 'codex', 'openshell'],
    ['openai', 'codex', 'local'],
    ['openai', 'codex', 'openshell'],
    ['anthropic-claude', 'claude-sdk', 'local'],
    ['anthropic-vertex', 'claude-sdk', 'local'],
    ['anthropic-api', 'claude-sdk', 'local'],
  ])('bounds %s / %s / %s to recorded inspection', (provider, harness, location) => {
    const { session, binding } = selected(provider, harness, location);
    const access = projectSessionAccess('chat', session, [], 123, { binding });
    expect(access.controls).toEqual({
      policyRevision: 'session-controls-2026-11-13',
      readinessRevision: access.readiness.revision,
      branching: { state: 'unavailable', reason: 'not_integrated' },
      contextInspection: { state: 'limited', reason: 'recorded_usage_only' },
      rewind: { state: 'unavailable', reason: 'not_integrated' },
    });
    expect(SessionControlSupportSchema.safeParse(access.controls).success).toBe(true);
    expect(session.sessionAllowList).toEqual(new Set(['Bash']));
  });

  it.each([
    ['anthropic-claude', 'claude-sdk', 'openshell'],
    ['anthropic-vertex', 'claude-sdk', 'openshell'],
    ['openai', 'responses', 'local'],
    ['google-vertex', 'gemini', 'local'],
  ])('does not substitute another route for %s / %s / %s', (provider, harness, location) => {
    const { session, binding } = selected(provider, harness, location);
    const { controls } = projectSessionAccess('chat', session, [], 123, { binding });
    for (const control of [controls.branching, controls.contextInspection, controls.rewind])
      expect(control).toEqual({ state: 'unavailable', reason: 'route_not_qualified' });
  });

  it('does not infer controls from an account, grants, malformed or mismatched binding', () => {
    const { session, binding } = selected();
    for (const route of [
      undefined,
      { ...binding, credential: 'PRIVATE' },
      { ...binding, account: { ...binding.account, accountId: 'other' } },
      { ...binding, execution: { ...binding.execution, location: 'openshell' } },
    ]) {
      const access = projectSessionAccess('chat', session, [], 123, { binding: route });
      expect(access.controls.readinessRevision).toBe(access.readiness.revision);
      const execution = access.readiness.execution;
      if (execution.state !== 'unknown') throw Error('Unverified execution must remain unknown');
      for (const control of [
        access.controls.branching,
        access.controls.contextInspection,
        access.controls.rewind,
      ])
        expect(control).toEqual({ state: 'unknown', reason: execution.reason });
      expect(JSON.stringify(access.controls)).not.toContain('PRIVATE');
    }
    session.abortController.abort();
    const stopped = projectSessionAccess('chat', session, [], 124, { binding });
    expect(stopped.controls.contextInspection).toEqual({
      state: 'unknown',
      reason: 'session_unavailable',
    });
    expect(projectSessionAccess('chat', undefined, [], 124, { binding }).controls).toEqual(
      stopped.controls,
    );
  });

  it('keeps policy reads stable across reconnects and never authorizes native operations', () => {
    const { session, binding } = selected();
    const first = projectSessionAccess('chat', session, [], 123, { binding });
    const reconnected = projectSessionAccess('chat', session, [], 456, { binding });
    expect(reconnected.controls).toEqual(first.controls);
    expect(
      SessionControlSupportSchema.safeParse({
        ...first.controls,
        branching: { state: 'available', reason: 'sdk_api_present' },
      }).success,
    ).toBe(false);
    expect(
      SessionControlSupportSchema.safeParse({
        ...first.controls,
        contextInspection: { state: 'limited', reason: 'native_context' },
      }).success,
    ).toBe(false);
  });

  it('delivers decisions through authenticated Access without adding a mutation path', async () => {
    const { session, binding } = selected();
    const app = express();
    app.use((req, res, next) => {
      if (req.get('x-operator') === 'yes')
        res.locals.authSession = { id: 'operator', expiresAt: Date.now() + 60000 };
      next();
    });
    app.use(
      '/api/sessions/:id/access',
      createSessionAccessRouter({
        hasSession: (id) => id === 'chat',
        read: () => projectSessionAccess('chat', session, [], 123, { binding }),
      }),
    );
    expect((await request(app).get('/api/sessions/chat/access')).status).toBe(401);
    const response = await request(app)
      .get('/api/sessions/chat/access?fork=true&rewind=true')
      .set('x-operator', 'yes');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(SessionControlSupportSchema.parse(response.body.controls)).toEqual(
      projectSessionAccess('chat', session, [], 123, { binding }).controls,
    );
    expect(
      (await request(app).post('/api/sessions/chat/access').set('x-operator', 'yes')).status,
    ).toBe(404);
    expect(
      (await request(app).get('/api/sessions/hidden/access').set('x-operator', 'yes')).status,
    ).toBe(404);
  });
});

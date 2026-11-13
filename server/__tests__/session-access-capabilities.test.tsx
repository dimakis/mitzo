import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ManagedSession } from '@mitzo/harness';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionCapabilities } from '../../frontend/src/components/SessionCapabilities.js';
import { SessionHelperSupportSchema } from '@mitzo/protocol';
import { assertAgentToolRoute, bindAgentToolSelection } from '../agent-tool-selection.js';
import { projectSessionAccess, createSessionAccessRouter } from '../session-access.js';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../logger.js', () => ({ createLogger: () => ({ warn }) }));

function fixture(provider = 'anthropic-claude', location = 'local', profile?: { tools: [] }) {
  const session = {
    sessionId: 'chat',
    model: 'selected-model',
    mode: 'agent',
    cwd: '/task',
    accountBinding: {
      accountId: 'account',
      accountLabel: 'Selected account',
      provider,
      profileRevision: 'profile-1',
      model: 'selected-model',
    },
    abortController: new AbortController(),
    sessionAllowList: new Set(),
    ordinaryRuntimeOwner: { location },
  } as ManagedSession;
  bindAgentToolSelection(
    session,
    profile as never,
    provider.startsWith('anthropic') ? 'claude-sdk' : 'codex-owned-local',
  );
  const binding = {
    version: 2,
    account: {
      accountId: 'account',
      provider,
      profileRevision: 'profile-1',
    },
    harness: { implementation: provider.startsWith('anthropic') ? 'claude-sdk' : 'codex' },
    execution: { location, targetId: 'target', targetRevision: 'target-1' },
  };
  return {
    session,
    binding,
    read: () => projectSessionAccess('chat', session, [], 150, { binding }),
  };
}

describe('Session Access configured helper support', () => {
  it.each(['anthropic-claude', 'anthropic-vertex', 'openai-codex', 'openai'])(
    'projects the real catalog for %s without turning support into verification or grants',
    (provider) => {
      const f = fixture(provider);
      const value = f.read();
      expect(value.helperSupport.state).toBe('configured');
      if (value.helperSupport.state !== 'configured') throw Error('Missing support');
      const tools = value.helperSupport.tools;
      expect(tools.find((t) => t.name === 'ListConnections')?.state).toBe('supported');
      expect(tools.find((t) => t.name === 'ConnectionRequest')?.state).toBe(
        provider.startsWith('anthropic') ? 'unsupported' : 'supported',
      );
      expect(tools.find((t) => t.name === 'GoogleWorkspaceRead')?.state).toBe(
        provider.startsWith('anthropic') ? 'unsupported' : 'supported',
      );
      expect(value.readiness.capabilities).toEqual({ state: 'unknown', reason: 'not_observed' });
      expect(value.grants).toEqual([]);
      expect(f.session.sessionAllowList.size).toBe(0);
      const html = renderToStaticMarkup(
        createElement(SessionCapabilities, {
          evidence: value,
          stale: false,
          now: 150,
        }),
      );
      expect(html).toContain('ListConnections');
      expect(html).toContain('execution not verified');
      expect(html).toContain('this runtime has not supplied capability observations');
    },
  );
  it('retains published profile exclusion, required helpers and the active skill ceiling', () => {
    const f = fixture('anthropic-claude', 'local', { tools: [] });
    let value = f.read();
    expect(value.helperSupport).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'ListConnections', state: 'excluded' }),
        expect.objectContaining({ name: 'AskUserQuestion', state: 'supported' }),
      ]),
    });
    f.session.activeSkillPolicy = new Set(['Read']);
    value = f.read();
    expect(value.helperSupport).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'AskUserQuestion', state: 'restricted' }),
      ]),
    });
  });
  it.each([
    [
      'anthropic-claude',
      'AskUserQuestion',
      'AskUserQuestion',
      'mcp__mitzo-connections__AskUserQuestion',
    ],
    [
      'anthropic-claude',
      'RequestWebAccess',
      'RequestWebAccess',
      'mcp__mitzo-web-access__RequestWebAccess',
    ],
    [
      'anthropic-claude',
      'TelosCreateSession',
      'mcp__mitzo-connections__TelosCreateSession',
      'TelosCreateSession',
    ],
    [
      'anthropic-claude',
      'CaptureMemoryCandidate',
      'mcp__mitzo-connections__CaptureMemoryCandidate',
      'CaptureMemoryCandidate',
    ],
    ['openai-codex', 'TaskStatus', 'mcp__task-board__TaskStatus', 'TaskStatus'],
  ])('uses the executor policy identity for %s %s', (provider, name, allowed, wrong) => {
    const f = fixture(provider);
    f.session.activeSkillPolicy = new Set([allowed]);
    expect(f.read().helperSupport).toMatchObject({
      tools: expect.arrayContaining([expect.objectContaining({ name, state: 'supported' })]),
    });
    f.session.activeSkillPolicy = new Set([wrong]);
    expect(f.read().helperSupport).toMatchObject({
      tools: expect.arrayContaining([expect.objectContaining({ name, state: 'restricted' })]),
    });
  });
  it.each(['RequestWebAccess', 'SymposiumReadProfiles', 'SymposiumProposeProfile'])(
    'distinguishes default SDK exposure from explicit-profile eligibility for %s',
    (name) => {
      const f = fixture();
      expect(f.read().helperSupport).toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ name, state: 'supported' })]),
      });
      const explicit = fixture('anthropic-claude', 'local', { tools: [] });
      expect(explicit.read().helperSupport).toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ name, state: 'excluded' })]),
      });
      expect(() =>
        assertAgentToolRoute(
          { tools: [{ id: `mitzo:${name}`, version: 1 }] } as never,
          'claude-sdk',
        ),
      ).toThrow(/unavailable/);
    },
  );
  it('keeps unqualified routes, lost owners and mismatched identities unknown', () => {
    const shell = fixture('anthropic-claude', 'openshell');
    expect(shell.read().helperSupport.state).toBe('unknown');
    const f = fixture();
    f.binding.account.profileRevision = 'other';
    expect(f.read().helperSupport.state).toBe('unknown');
    f.binding.account.profileRevision = 'profile-1';
    f.session.abortController.abort();
    expect(f.read().helperSupport.state).toBe('unknown');
  });
  it('does not interpret an uncaptured profile or a different captured route as default access', () => {
    const f = fixture();
    const replacement = { ...f.session };
    const value = projectSessionAccess('chat', replacement, [], 150, { binding: f.binding });
    expect(value.helperSupport).toEqual({ state: 'unknown', reason: 'selection_unavailable' });
    bindAgentToolSelection(replacement, undefined, 'codex-owned-local');
    expect(
      projectSessionAccess('chat', replacement, [], 150, { binding: f.binding }).helperSupport
        .state,
    ).toBe('unknown');
  });
  it('delivers scoped observations and rejects replaced owners through the real projector and consumer', () => {
    const f = fixture();
    const observation = {
      scope: {
        sessionId: 'chat',
        accountId: 'account',
        profileRevision: 'profile-1',
        model: 'selected-model',
        binding: f.binding,
        ownerRevision: 'owner-1',
      },
      observedAt: 100,
      expiresAt: 200,
      process: 'ready',
      roots: { task: '/task', knowledge: null },
      tools: [],
      executables: [],
      services: [
        {
          id: 'Documents',
          revision: 'service-1',
          configured: 'yes',
          approval: 'unknown',
          attachment: 'unknown',
          operations: [
            {
              operation: 'list',
              policy: 'allowed',
              verification: { state: 'succeeded', observedAt: 100, expiresAt: 160 },
            },
            { operation: 'read text', policy: 'unknown', verification: { state: 'unknown' } },
          ],
        },
      ],
    };
    const render = (ownerRevision: string, now: number) => {
      const value = projectSessionAccess('chat', f.session, [], now, {
        binding: f.binding,
        ownerRevision,
        observation,
      });
      return renderToStaticMarkup(
        createElement(SessionCapabilities, { evidence: value, stale: false, now }),
      );
    };
    const current = render('owner-1', 150);
    expect(current).toContain('Succeeded');
    expect(current).toContain('Not verified');
    const expired = render('owner-1', 170);
    expect(expired).toContain('Verification expired');
    expect(expired).not.toContain('Succeeded');
    const replaced = render('owner-2', 150);
    expect(replaced).toContain('evidence does not match the current session or runtime');
    expect(replaced).not.toContain('Succeeded');
  });
  it('delivers through the authenticated router, with sanitized correlated failure diagnostics', async () => {
    const f = fixture();
    const read = vi.fn(f.read);
    const app = express();
    app.use((_req, res, next) => {
      res.locals.authSession = { id: 'browser', expiresAt: Date.now() + 60000 };
      next();
    });
    app.use(
      '/api/sessions/:id/access',
      createSessionAccessRouter({ hasSession: () => true, read }),
    );
    const result = await request(app).get('/api/sessions/chat/access');
    expect(result.status).toBe(200);
    expect(result.body.helperSupport.state).toBe('configured');
    expect(SessionHelperSupportSchema.safeParse(result.body.helperSupport).success).toBe(true);
    const cause = new Error('SECRET account payload');
    read.mockImplementationOnce(() => {
      throw cause;
    });
    const failed = await request(app).get('/api/sessions/chat/access');
    expect(failed.status).toBe(503);
    expect(failed.body).toMatchObject({
      code: 'session_access_read_failed',
      stage: 'read',
      sessionId: 'chat',
    });
    expect(JSON.stringify(failed.body)).not.toContain('SECRET');
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        code: 'session_access_read_failed',
        stage: 'read',
        sessionId: 'chat',
        cause: 'Error',
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  });
});

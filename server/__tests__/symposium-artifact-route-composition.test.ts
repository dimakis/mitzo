import express from 'express';
import { readFileSync } from 'node:fs';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { authMiddleware, login } from '../auth.js';
import { EventStore } from '../event-store.js';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import { SymposiumReviewActionAuthority } from '../symposium-review-action-authority.js';
import {
  mountSymposiumArtifactRoutes,
  type SymposiumArtifactRouteDependencies,
} from '../symposium-artifact-route-composition.js';
import { mountArtifactRoutesBeforeExtraction } from './fixtures/symposium-artifact-routes-before-extraction.js';

vi.mock('../internal-token.js', () => ({
  isValidInternalToken: (token: unknown) => token === 'offline-internal',
  isValidSignalCallbackToken: () => false,
}));
vi.mock('../app.js', () => {
  throw Error('Application bootstrap imported');
});
vi.mock('../chat.js', () => {
  throw Error('Chat bootstrap imported');
});
vi.mock('../logger.js', () => ({ createLogger: () => ({ error: vi.fn() }) }));
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
const base = '/api/sessions/session/symposium';
type Host = ReturnType<SymposiumArtifactRouteDependencies['currentHost']>;

async function fixture(before: boolean) {
  const events = new EventStore(':memory:');
  const store = new SymposiumReviewStore(':memory:');
  cleanups.push(
    () => events.close(),
    () => store.close(),
  );
  const config = {
    version: 2 as const,
    revision: 4,
    state: 'draft' as const,
    anchorSeatId: 'architect',
    activeSeatCap: 1,
    seats: [
      {
        id: 'architect',
        name: 'Architect',
        role: 'architect',
        model: 'offline-only',
        systemPrompt: '',
        color: '#335577',
      },
    ],
    turnRules: { mode: 'directed' as const, maxTurns: 4 },
    interceptMode: 'manual' as const,
  };
  events.upsertSession({ sessionId: 'session' });
  events.setSymposiumConfig('session', config);
  events.upsertSession({ sessionId: 'ordinary' });
  let host: Host;
  let registration: ReturnType<SymposiumArtifactRouteDependencies['publication']['registration']>;
  let repositories = { selected: '/private/never-disclose' };
  const runtime = vi.fn((): object | null => ({}));
  const currentHost = vi.fn(() => host);
  const approval = vi.fn(() => undefined);
  const app = express();
  app.use(express.json(), cookieParser(), authMiddleware);
  // Ordinary publication precedes the selected block; the Director follows it.
  app.get('/api/sessions/:id/github-publication', (req, res) =>
    res.json({ ordinary: req.params.id }),
  );
  const deps: SymposiumArtifactRouteDependencies = {
    events,
    currentHost,
    repositories: () => repositories,
    publication: { registration: () => registration, approval },
    reviews: { store, actionAuthority: new SymposiumReviewActionAuthority(), runtime },
  };
  const mounts = vi.spyOn(app, 'use');
  if (before) mountArtifactRoutesBeforeExtraction(app, deps);
  else mountSymposiumArtifactRoutes(app, deps);
  const artifactMounts = mounts.mock.calls.map((args) => ({
    path: args[0],
    handlers: args.length - 1,
  }));
  mounts.mockRestore();
  app.use('/api/sessions/:id/symposium', (req, res) =>
    res.json({ fallback: req.params.id, path: req.path }),
  );
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  return {
    app,
    artifactMounts,
    events,
    config,
    runtime,
    currentHost,
    approval,
    selectHost(value: Host) {
      host = value;
    },
    selectRegistration(value: typeof registration) {
      registration = value;
    },
    selectRepositories(value: typeof repositories) {
      repositories = value;
    },
    send(
      path: string,
      auth: 'bearer' | 'internal' | 'none' = 'bearer',
      method: 'get' | 'post' = 'get',
      body = {},
    ) {
      const sent = request(app)[method](path);
      if (auth === 'bearer') sent.set('Authorization', `Bearer ${token}`);
      if (auth === 'internal') sent.set('x-internal-token', 'offline-internal');
      return method === 'post' ? sent.send(body) : sent;
    },
  };
}

it.each(['publication', 'reviews', 'source'])(
  'preserves %s interactive auth and rejects internal callers',
  async (route) => {
    const old = await fixture(true);
    const next = await fixture(false);
    for (const auth of ['none', 'internal', 'bearer'] as const) {
      const a = await old.send(`${base}/${route}`, auth);
      const b = await next.send(`${base}/${route}`, auth);
      expect({ status: b.status, body: b.body }).toEqual({ status: a.status, body: a.body });
      expect(b.status).toBe(auth === 'none' ? 401 : auth === 'internal' ? 403 : 200);
    }
  },
);

it.each(['publication', 'reviews', 'source'])(
  'preserves %s ordinary/missing session rejection',
  async (route) => {
    for (const id of ['ordinary', 'missing']) {
      const old = await fixture(true);
      const next = await fixture(false);
      const a = await old.send(`/api/sessions/${id}/symposium/${route}`);
      const b = await next.send(`/api/sessions/${id}/symposium/${route}`);
      expect({ status: b.status, body: b.body }).toEqual({ status: a.status, body: a.body });
      expect(b.status).toBe(route === 'source' ? 409 : 404);
    }
  },
);

it.each([true, false])(
  'selects source host, repository configuration and session revision after mount (before=%s)',
  async (before) => {
    const f = await fixture(before);
    expect(f.currentHost).not.toHaveBeenCalled();
    expect(f.runtime).not.toHaveBeenCalled();
    expect((await f.send(`${base}/source`)).body).toEqual({
      repositories: ['selected'],
      expectedRevision: 4,
      artifact: { available: false, state: 'unavailable' },
    });
    const status = vi.fn((id: string) => ({
      available: true,
      volumeGeneration: `generation-${id}`,
    }));
    f.selectHost({ sourceImport: { status } } as unknown as Host);
    f.selectRepositories({ selected: '/second/private/path' });
    f.events.setSymposiumConfig('session', { ...f.config, revision: 5 });
    const response = await f.send(`${base}/source`);
    expect(response.body).toEqual({
      repositories: ['selected'],
      expectedRevision: 5,
      artifact: { available: true, volumeGeneration: 'generation-session' },
    });
    expect(status).toHaveBeenLastCalledWith('session');
    expect(JSON.stringify(response.body)).not.toContain('/private');
    f.selectHost(undefined);
    expect((await f.send(`${base}/source`)).body.artifact.state).toBe('unavailable');
  },
);

it.each([true, false])(
  'selects publication registration after mount and clears it without fabricating availability (before=%s)',
  async (before) => {
    const f = await fixture(before);
    expect((await f.send(`${base}/publication`)).body).toEqual({
      available: false,
      code: 'PUBLICATION_CREDENTIAL_REGISTRATION_REQUIRED',
      credentials: [],
    });
    f.selectRegistration({
      service: { availability: () => ({ available: true, code: 'offline-only' }) },
      custodian: { list: () => [{ id: 'offline' }] },
    } as never);
    expect((await f.send(`${base}/publication`)).body).toEqual({
      available: true,
      code: 'offline-only',
      credentials: [{ id: 'offline' }],
    });
    f.selectRegistration(undefined);
    expect((await f.send(`${base}/publication`)).body.available).toBe(false);
  },
);

it.each([true, false])(
  'keeps route precedence and authenticated unknown-subpath fallthrough (before=%s)',
  async (before) => {
    const f = await fixture(before);
    expect((await f.send('/api/sessions/ordinary/github-publication')).body).toEqual({
      ordinary: 'ordinary',
    });
    for (const route of ['publication', 'reviews', 'source']) {
      const response = await f.send(`${base}/${route}/unhandled/extra`, 'bearer', 'post');
      expect(response.body).toEqual({ fallback: 'session', path: `/${route}/unhandled/extra` });
    }
  },
);

it.each(['source/preview', 'publication/preview', 'reviews'])(
  'preserves the existing cross-origin contract for %s',
  async (route) => {
    const old = await fixture(true);
    const next = await fixture(false);
    const a = await old
      .send(`${base}/${route}`, 'bearer', 'post')
      .set('Origin', 'https://foreign.invalid');
    const b = await next
      .send(`${base}/${route}`, 'bearer', 'post')
      .set('Origin', 'https://foreign.invalid');
    expect({ status: b.status, body: b.body }).toEqual({ status: a.status, body: a.body });
    expect(b.status).toBe(route === 'reviews' ? 400 : 403);
  },
);

it.each([true, false])(
  'selects the current review host and runtime (before=%s)',
  async (before) => {
    const f = await fixture(before);
    const refresh = vi.fn(async () => {});
    const first = {
      reviewHost: { refreshArtifact: refresh, criterionChecks: () => [] },
    } as unknown as Host;
    f.selectHost(first);
    expect((await f.send(`${base}/reviews`)).body.available).toBe(true);
    expect(f.runtime).toHaveBeenLastCalledWith('session');
    expect(refresh).toHaveBeenCalledTimes(1);
    f.runtime.mockReturnValue(null);
    expect((await f.send(`${base}/reviews`)).body.available).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    const secondRefresh = vi.fn(async () => {});
    f.selectHost({
      reviewHost: { refreshArtifact: secondRefresh, criterionChecks: () => [] },
    } as unknown as Host);
    f.runtime.mockReturnValue({});
    expect((await f.send(`${base}/reviews`)).body.available).toBe(true);
    expect(secondRefresh).toHaveBeenCalledTimes(1);
    f.selectHost(undefined);
    expect((await f.send(`${base}/reviews`)).body.available).toBe(false);
  },
);

it('preserves direct mount order and auth placement without an extra parent router', async () => {
  const old = await fixture(true);
  const next = await fixture(false);
  expect(next.artifactMounts).toEqual(old.artifactMounts);
  expect(next.artifactMounts).toEqual([
    { path: '/api/sessions/:id/symposium/publication', handlers: 2 },
    { path: '/api/sessions/:id/symposium/reviews', handlers: 1 },
    { path: '/api/sessions/:id/symposium/source', handlers: 2 },
  ]);
});

it('pins the extracted owner and installs it in the existing application slot', () => {
  const source = readFileSync(
    new URL('../symposium-artifact-route-composition.ts', import.meta.url),
    'utf8',
  );
  const pins: Record<string, string> = reviewedHandlerSourceArtifacts;
  expect(pins['../symposium-artifact-route-composition.ts']).toBe(
    reviewedHandlerSourceFingerprint(source),
  );
  const app = readFileSync(new URL('../app.ts', import.meta.url), 'utf8');
  const mount = app.indexOf('mountSymposiumArtifactRoutes(app,');
  expect(mount).toBeGreaterThan(app.indexOf("'/api/sessions/:id/github-publication'"));
  expect(mount).toBeLessThan(app.indexOf("'/api/sessions/:id/symposium',"));
  expect(app.match(/mountSymposiumArtifactRoutes\(app,/g)).toHaveLength(1);
});

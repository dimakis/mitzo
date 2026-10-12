import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { get, type Server } from 'node:http';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';
import { mountReviewCompositionBeforeExtraction } from './fixtures/symposium-review-composition-before-extraction.js';
import { createSymposiumReviewRouteComposition } from '../symposium-review-route-composition.js';
import type { SymposiumReviewRouteHost } from '../symposium-review-host-contract.js';
import type { SymposiumInteractiveReviewHost } from '../symposium-review-routes.js';
import type { ReviewContext } from '../symposium-review-coordinator.js';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import { SymposiumReviewActionAuthority } from '../symposium-review-action-authority.js';
import { authMiddleware, login, authenticateToken, revokeAuthSession } from '../auth.js';

vi.mock('../internal-token.js', () => ({
  isValidInternalToken: (token: unknown) => token === 'fixture-internal-token',
  isValidSignalCallbackToken: () => false,
}));
vi.mock('../logger.js', () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock('../app.js', () => {
  throw Error('Application bootstrap imported');
});
vi.mock('../chat.js', () => {
  throw Error('Chat bootstrap imported');
});

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const base = '/api/sessions/session/symposium/reviews';
const hash = 'a'.repeat(64);
const artifact = { expectedArtifactRevision: 'source', expectedArtifactHash: hash };
type Method = 'get' | 'post' | 'head' | 'options' | 'delete' | 'put';
type Auth =
  'cookie' | 'bearer' | 'none' | 'internal' | 'invalid' | 'revoked' | 'expired' | 'other-cookie';
type Outcome = 'complete' | 'throw' | 'revoke' | 'expire';

async function fixture(before: boolean, outcome: Outcome = 'complete') {
  const calls: unknown[][] = [];
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  const session = (await authenticateToken(token))!;
  const store = new SymposiumReviewStore(':memory:');
  cleanups.push(() => store.close());
  const actionAuthority = new SymposiumReviewActionAuthority();
  const guards = new WeakMap<ReviewContext, () => void>();
  const contexts: ReviewContext[] = [];
  let onRelease: (() => void) | undefined;
  const bind = actionAuthority.bind.bind(actionAuthority);
  vi.spyOn(actionAuthority, 'bind').mockImplementation((context, action, current) => {
    calls.push(['bind', context.owner, context.sessionId, action]);
    contexts.push(context);
    guards.set(context, current);
    const release = bind(context, action, current);
    return () => {
      calls.push(['release', context.owner, context.sessionId]);
      release();
      onRelease?.();
    };
  });
  const selection = (seatId: string, role: 'coder' | 'reviewer') => ({
    seatId,
    role,
    selectionId: seatId,
    policyRevision: 'request-only',
    profileId: seatId,
    profileRevision: 1,
    accountId: seatId,
    model: 'no-model',
  });
  store.createApplicationRun({
    workflowId: 'workflow',
    owner: 'user',
    sessionId: 'session',
    implementer: selection('coder', 'coder'),
    reviewer: selection('reviewer', 'reviewer'),
    initialArtifact: { revision: 'source', hash },
    acceptanceCriteria: ['Offline request only'],
    limits: {
      version: 1,
      mode: 'application',
      maxHostTurns: 12,
      maxReviewCycles: 2,
      deadlineAt: 9_999_999_999_999,
      noProgressLimit: 2,
    },
  });
  let wait: (() => Promise<void>) | undefined;
  const host = (label: string): SymposiumInteractiveReviewHost => ({
    currentArtifact: () => ({ revision: 'source', hash }),
    initialArtifact: () => ({ revision: 'source', hash }),
    completedImplementation: () => {
      throw Error('No completed physical implementation');
    },
    selectRoles: () => {
      throw Error('No physical admission');
    },
    prepareAttempt: () => ({ kind: 'decision_required', code: 'no_physical_admission' }),
    receipt: () => null,
    completedReview: () => null,
    authorizeFix: () => null,
    fixedArtifact: () => null,
    evidence: () => null,
    dispatch: async () => {
      throw Error('No provider calls permitted');
    },
    refreshArtifact: async (context) => {
      calls.push(['refresh', label, context.sessionId]);
      guards.get(context)!();
      await wait?.();
      if (outcome === 'revoke') revokeAuthSession(session);
      if (outcome === 'expire') vi.spyOn(Date, 'now').mockReturnValue(session.expiresAt);
      if (outcome === 'throw') throw Error('Synthetic host unavailable');
      guards.get(context)!();
    },
    criterionChecks: () => [],
    cleanupCriterionCheck: async (context) => {
      calls.push(['cleanup', label, context.sessionId]);
      actionAuthority.assertCurrent(context, 'cleanup-check');
      await wait?.();
      if (outcome === 'revoke') revokeAuthSession(session);
      if (outcome === 'expire') vi.spyOn(Date, 'now').mockReturnValue(session.expiresAt);
      actionAuthority.assertCurrent(context, 'cleanup-check');
      return { state: 'cleaned', retryAllowed: false, semanticEvidenceAllowed: false };
    },
  });
  let selected: SymposiumReviewRouteHost | undefined = { reviewHost: host('first') };
  let runtimeAvailable = true;
  const deps = {
    store,
    actionAuthority,
    currentHost: () => selected,
    runtime(id: string) {
      calls.push(['runtime', id]);
      return runtimeAvailable ? {} : null;
    },
    hasSession: (id: string) => id === 'session',
  };
  const app = express();
  app.set('env', 'production');
  app.use(express.json(), cookieParser(), authMiddleware);
  if (before) mountReviewCompositionBeforeExtraction(app, deps);
  else app.use('/api/sessions/:id/symposium/reviews', createSymposiumReviewRouteComposition(deps));
  const server: Server = await listenOnLoopback(app);
  cleanups.push(() => closeTestServer(server));
  return {
    calls,
    server,
    token,
    store,
    session,
    contexts,
    actionAuthority,
    host,
    select(value: typeof selected) {
      selected = value;
    },
    runtimeAvailable(value: boolean) {
      runtimeAvailable = value;
    },
    wait(value: () => Promise<void>) {
      wait = value;
    },
    onRelease(value: () => void) {
      onRelease = value;
    },
    async send(method: Method, path = '', body: object = {}, auth: Auth = 'cookie', root = base) {
      let call = request(server)[method](root + path);
      if (['cookie', 'revoked', 'expired'].includes(auth))
        call = call.set('Cookie', `cc_auth=${token}`);
      if (auth === 'other-cookie')
        call = call.set('Cookie', `cc_auth=${await login(process.env.AUTH_PASSPHRASE!)}`);
      if (auth === 'bearer') call = call.set('Authorization', `Bearer ${token}`);
      if (auth === 'internal') call = call.set('x-internal-token', 'fixture-internal-token');
      if (auth === 'invalid') call = call.set('Cookie', 'cc_auth=invalid');
      if (auth === 'revoked') revokeAuthSession(session);
      if (auth === 'expired') vi.spyOn(Date, 'now').mockReturnValue(session.expiresAt);
      const response = await (method === 'head' ? call : call.send(body));
      return {
        status: response.status,
        body: response.body,
        text: response.text,
        contentType: response.headers['content-type'],
        cache: response.headers['cache-control'],
        allow: response.headers.allow,
      };
    },
  };
}

async function parity(
  run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>,
  outcome: Outcome = 'complete',
) {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const before = await fixture(true, outcome);
  const expected = await run(before);
  vi.restoreAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const after = await fixture(false, outcome);
  expect(await run(after)).toEqual(expected);
  expect(after.calls).toEqual(before.calls);
  expect(after.store.list('user', 'session')).toEqual(before.store.list('user', 'session'));
  for (const context of after.contexts)
    expect(after.actionAuthority.authorize(context, '')).toBeNull();
}

const routes: [Method, string, object?][] = [
  ['get', ''],
  ['get', '/workflow'],
  ['get', '/records/missing'],
  ['post', ''],
  ['post', '/application-runs'],
  ['post', '/workflow/actions', { ...artifact, action: 'cleanup-check', definitionId: 'unit' }],
  ['post', '/records/missing/publication-preflight'],
];
it.each(
  routes.flatMap(([method, path, body]) =>
    (['cookie', 'bearer', 'none', 'internal', 'invalid', 'revoked', 'expired'] as Auth[]).map(
      (auth) => ({ method, path, body, auth }),
    ),
  ),
)(
  'preserves accepted authorization: $method $path ($auth)',
  async ({ method, path, body, auth }) => {
    await parity((f) => f.send(method, path, body, auth));
  },
);

it.each(
  (['cookie', 'internal'] as Auth[]).flatMap((auth) =>
    (['get', 'post', 'head', 'options', 'delete', 'put'] as Method[]).flatMap((method) =>
      ['', '/', '/workflow', '/workflow/actions', '/records/missing', '/unknown/nested'].map(
        (path) => ({ auth, method, path }),
      ),
    ),
  ),
)(
  'preserves matching, HEAD, OPTIONS and prefix authentication: $method $path ($auth)',
  async ({ method, path, auth }) => {
    await parity((f) => f.send(method, path, {}, auth));
  },
);

it.each(['missing', 'runtime', 'host'])(
  'preserves unavailable capability behavior: %s',
  async (unavailable) => {
    await parity(async (f) => {
      if (unavailable === 'missing') f.select(undefined);
      if (unavailable === 'runtime') f.runtimeAvailable(false);
      if (unavailable === 'host') f.select({});
      return f.send('get');
    });
  },
);

it.each(['complete', 'throw', 'revoke', 'expire'] as Outcome[])(
  'preserves async host and authorization behavior: %s',
  async (outcome) => {
    await parity((f) => f.send('get'), outcome);
  },
);

it.each(['complete', 'revoke', 'expire'] as Outcome[])(
  'preserves request-owned cleanup after await: %s',
  async (outcome) => {
    await parity(
      (f) =>
        f.send('post', '/workflow/actions', {
          ...artifact,
          action: 'cleanup-check',
          definitionId: 'unit',
        }),
      outcome,
    );
  },
);

it.each(['foreign', 'session%2Fchild', '%ZZ'])(
  'preserves exact session scope and encoded paths: %s',
  async (id) => {
    await parity((f) => f.send('get', '', {}, 'cookie', `/api/sessions/${id}/symposium/reviews`));
  },
);

it("resolves the current host for subsequent requests and retains an overlapping request's selected host", async () => {
  await parity(async (f) => {
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let first = true;
    f.wait(async () => {
      if (first) {
        first = false;
        started();
        await pending;
      }
    });
    const initial = f.send('get');
    await entered;
    f.select({ reviewHost: f.host('second') });
    const next = await f.send('get', '', {}, 'other-cookie');
    revokeAuthSession(f.session);
    release();
    const completed = await initial;
    expect(next).toMatchObject({ status: 200, body: { available: true } });
    expect(completed).toMatchObject({ status: 200, body: { available: false } });
    return { next, completed };
  });
});

it('releases request authority on an actual socket disconnect during host refresh', async () => {
  await parity(async (f) => {
    let release!: () => void;
    let started!: () => void;
    let settled!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const released = new Promise<void>((resolve) => {
      f.onRelease(resolve);
    });
    f.wait(async () => {
      started();
      await pending;
      settled();
    });
    const address = f.server.address();
    if (!address || typeof address === 'string') throw Error('Owned loopback listener required');
    const call = get({
      hostname: '127.0.0.1',
      port: address.port,
      path: base,
      headers: { Cookie: `cc_auth=${f.token}` },
    });
    call.on('error', () => undefined);
    await entered;
    call.destroy();
    await released;
    expect(f.actionAuthority.authorize(f.contexts[0], '')).toBeNull();
    release();
    await finished;
    return { released: true };
  });
});

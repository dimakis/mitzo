import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Server } from 'node:http';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';
import { personalConnectionRoutesBeforeExtraction } from './fixtures/symposium-personal-routes-before-extraction.js';
import {
  createSymposiumPersonalConnectionRouter,
  type SymposiumPersonalConnectionService,
} from '../symposium-personal-connection-router.js';
import { authMiddleware, login, authenticateToken, revokeAuthSession } from '../auth.js';

vi.mock('../internal-token.js', () => ({
  isValidInternalToken: (token: unknown) => token === 'fixture-internal-token',
  isValidSignalCallbackToken: () => false,
}));
vi.mock('../logger.js', () => ({ createLogger: () => ({ error: vi.fn() }) }));

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await closeTestServer(server);
});
const base = '/api/symposium/personal/connections';
const row = { id: 'slot', label: 'Personal', revision: 3, state: 'connected' as const };
type Call = [string, ...unknown[]];
type Method = 'get' | 'post' | 'head' | 'options' | 'delete' | 'put';
type Auth =
  'cookie' | 'bearer' | 'none' | 'internal' | 'invalid' | 'revoked' | 'expired' | 'other-cookie';
type Outcome = 'complete' | 'failed' | 'reconciliation_required' | 'throw' | 'revoke' | 'expire';

async function fixture(before: boolean, outcome: Outcome = 'complete') {
  const calls: Call[] = [];
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  const session = (await authenticateToken(token))!;
  const discover = (name: string) => async (id: string, revision: number, current: () => void) => {
    calls.push([name, id, revision]);
    current();
    if (outcome === 'revoke') revokeAuthSession(session);
    if (outcome === 'expire') vi.spyOn(Date, 'now').mockReturnValue(session.expiresAt + 1);
    if (outcome === 'throw') throw Error('private upstream credential detail');
    return { status: outcome, inference: false };
  };
  const service: SymposiumPersonalConnectionService = {
    list: () => {
      calls.push(['list']);
      return [row];
    },
    create: (label) => {
      calls.push(['create', label]);
      if (outcome === 'throw') throw Error('private storage');
      return row;
    },
    disconnect: async (id, revision) => {
      calls.push(['disconnect', id, revision]);
      if (outcome === 'throw') throw Error('private cleanup');
      return { ...row, revision: 4 };
    },
    discoverModels: discover('refresh'),
    recoverDiscovery: discover('recover'),
    diagnoseRouting: async (id, revision, current) => {
      calls.push(['diagnose', id, revision]);
      current();
      return { status: 'failed', inference: false, catalogPublication: false };
    },
  };
  let selected: SymposiumPersonalConnectionService | undefined = service;
  const current = express();
  current.set('env', 'production');
  current.use(express.json(), cookieParser(), authMiddleware);
  current.use(
    base,
    createSymposiumPersonalConnectionRouter(() => selected),
  );
  const legacy = personalConnectionRoutesBeforeExtraction(service);
  const server = await listenOnLoopback(before ? legacy.app : current);
  servers.push(server);
  return {
    calls,
    service,
    session,
    select(value: typeof selected) {
      selected = value;
      legacy.select(value);
    },
    async send(
      method: Method,
      path: string,
      body: object | string = { expectedRevision: 3, label: 'Personal' },
      auth: Auth = 'cookie',
    ) {
      let call = request(server)[method](base + path);
      if (auth === 'cookie' || auth === 'revoked' || auth === 'expired')
        call = call.set('Cookie', `cc_auth=${token}`);
      if (auth === 'other-cookie')
        call = call.set('Cookie', `cc_auth=${await login(process.env.AUTH_PASSPHRASE!)}`);
      if (auth === 'bearer') call = call.set('Authorization', `Bearer ${token}`);
      if (auth === 'internal') call = call.set('x-internal-token', 'fixture-internal-token');
      if (auth === 'invalid') call = call.set('Cookie', 'cc_auth=invalid');
      if (auth === 'revoked') revokeAuthSession(session);
      if (auth === 'expired') vi.spyOn(Date, 'now').mockReturnValue(session.expiresAt + 1);
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
  const before = await fixture(true, outcome);
  const expected = await run(before);
  vi.restoreAllMocks();
  const after = await fixture(false, outcome);
  const actual = await run(after);
  expect(actual).toEqual(expected);
  expect(after.calls).toEqual(before.calls);
  return actual;
}

const routes: [Method, string][] = [
  ['get', ''],
  ['post', ''],
  ['post', '/slot/disconnect'],
  ['post', '/slot/models/refresh'],
  ['post', '/slot/models/recover'],
  ['post', '/slot/routing-diagnostic'],
];
const authorityCases = routes.flatMap(([method, path]) =>
  (['cookie', 'bearer', 'none', 'internal', 'invalid', 'revoked', 'expired'] as Auth[]).map(
    (auth) => ({ method, path, auth }),
  ),
);
it.each(authorityCases)(
  'preserves accepted authorization and responses: $method $path ($auth)',
  async ({ method, path, auth }) => {
    await parity((f) => f.send(method, path, undefined, auth));
  },
);

const fallbackCases = (['cookie', 'internal'] as Auth[]).flatMap((auth) =>
  (['get', 'post', 'head', 'options', 'delete', 'put'] as Method[]).flatMap((method) =>
    ['', '/missing', '/slot/disconnect', '/slot/models/recover', '/slot/routing-diagnostic'].map(
      (path) => ({ auth, method, path }),
    ),
  ),
);
it.each(fallbackCases)(
  'preserves route matching, HEAD, OPTIONS and fallback: $method $path ($auth)',
  async ({ auth, method, path }) => {
    await parity((f) => f.send(method, path, undefined, auth));
  },
);

const revisionCases = ['disconnect', 'models/refresh', 'models/recover'].flatMap((action) =>
  [undefined, null, '3', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, [], {}, true].map((revision) => ({
    action,
    revision,
  })),
);
it.each(revisionCases)(
  'preserves rejection before service calls: $action revision $revision',
  async ({ action, revision }) => {
    const response = await parity((f) =>
      f.send('post', `/slot/${action}`, { expectedRevision: revision }),
    );
    expect(response).toMatchObject({ status: 400 });
  },
);

it.each(routes)(
  'preserves capability absence and no-store responses: %s %s',
  async (method, path) => {
    await parity((f) => {
      f.select(undefined);
      return f.send(method, path);
    });
  },
);

it.each(['refresh', 'recover'])(
  'preserves discovery status and failure fences: %s',
  async (action) => {
    for (const outcome of [
      'complete',
      'failed',
      'reconciliation_required',
      'throw',
      'revoke',
      'expire',
    ] as Outcome[]) {
      const response = await parity((f) => f.send('post', `/slot/models/${action}`), outcome);
      if (['throw', 'revoke', 'expire'].includes(outcome)) {
        expect(response).toMatchObject({ status: 409 });
        expect(JSON.stringify(response)).not.toContain('private');
        expect(response).not.toHaveProperty('body.status');
      }
    }
  },
);

it.each(['disconnect', 'models/refresh', 'models/recover', 'routing-diagnostic'])(
  'preserves decoded IDs and query handling: %s',
  async (action) => {
    for (const id of ['slot%2Fchild', 'slot%20name', '%E2%98%83', '%25', '%ZZ']) {
      await parity((f) => f.send('post', `/${id}/${action}?extra=caller`));
    }
  },
);

it.each(routes)('preserves trailing-slash matching: %s %s', async (method, path) => {
  await parity((f) => f.send(method, `${path}/`));
});

it.each(['', '/slot/disconnect'])(
  'preserves private creation/cleanup failures: %s',
  async (path) => {
    const response = await parity((f) => f.send('post', path), 'throw');
    expect(JSON.stringify(response)).not.toContain('private');
  },
);

it('retains the selected service during overlapping requests and suppresses only the revoked operator result', async () => {
  await parity(async (f) => {
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = f.service;
    original.discoverModels = async (id, revision, current) => {
      f.calls.push(['first', id, revision]);
      current();
      started();
      await pending;
      current();
      return { status: 'complete', inference: false };
    };
    const first = f.send('post', '/slot/models/refresh');
    await entered;
    f.select({
      ...original,
      recoverDiscovery: async (id, revision, current) => {
        f.calls.push(['second', id, revision]);
        current();
        return { status: 'reconciled', inference: false };
      },
    });
    const second = await f.send('post', '/slot/models/recover', undefined, 'other-cookie');
    revokeAuthSession(f.session);
    release();
    const completed = await first;
    expect(second.status).toBe(200);
    expect(completed.status).toBe(409);
    return { second, completed };
  });
});

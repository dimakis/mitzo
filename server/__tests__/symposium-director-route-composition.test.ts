import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authMiddleware, login, operatorAuthMiddleware } from '../auth.js';
import { EventStore } from '../event-store.js';
import { SymposiumOrchestrator } from '../symposium-orchestrator.js';
import { createSymposiumDirectorRouter } from '../symposium-director-routes.js';
import {
  mountSymposiumDirectorRoutes,
  type SymposiumDirectorCompositionDependencies,
} from '../symposium-director-route-composition.js';
import { mountDirectorBeforeExtraction } from './fixtures/symposium-director-composition-before-extraction.js';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

vi.mock('../symposium-director-routes.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../symposium-director-routes.js')>();
  return {
    ...original,
    createSymposiumDirectorRouter: vi.fn(original.createSymposiumDirectorRouter),
  };
});
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
const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
type Host = ReturnType<SymposiumDirectorCompositionDependencies['currentHost']>;
const binding = {
  accountId: 'offline',
  accountLabel: 'Offline',
  provider: 'openai-codex' as const,
  model: 'offline-model',
  profileRevision: 'offline-revision',
};
const seat = {
  id: 'writer',
  name: 'Writer',
  role: 'writer',
  model: binding.model,
  systemPrompt: '',
  color: '#335577',
  accountBinding: binding,
  reasoningEffort: 'low',
};
const config = {
  version: 2 as const,
  revision: 1,
  state: 'draft' as const,
  anchorSeatId: seat.id,
  activeSeatCap: 1,
  seats: [seat],
  turnRules: { mode: 'directed' as const, maxTurns: 4 },
  interceptMode: 'manual' as const,
};

async function fixture(before: boolean) {
  const store = new EventStore(':memory:');
  cleanups.push(() => store.close());
  store.upsertSession({ sessionId: 'session' });
  store.setSymposiumConfig('session', config);
  store.upsertSession({ sessionId: 'ordinary', accountBinding: binding });
  const safety = new SymposiumOrchestrator({ store, executors: {} });
  let host: Host;
  const accounts = {
    resolve: vi.fn(function (this: unknown) {
      expect(this).toBe(accounts);
      return binding;
    }),
    validateModel: vi.fn(function (this: unknown) {
      expect(this).toBe(accounts);
    }),
  };
  let profiles: ReturnType<SymposiumDirectorCompositionDependencies['currentAccounts']> = accounts;
  const currentAccounts = vi.fn(() => profiles);
  const currentHost = vi.fn(() => host);
  const runtime = vi.fn((): SymposiumOrchestrator | null => null);
  const registry = {
    findBySessionId: vi.fn(
      (): ReturnType<SymposiumDirectorCompositionDependencies['registry']['findBySessionId']> =>
        null,
    ),
    isActive: vi.fn(() => false),
  };
  const grants = {
    validateActiveConfig: vi.fn(function (this: unknown) {
      expect(this).toBe(grants);
    }),
    activate: vi.fn(function (this: unknown) {
      expect(this).toBe(grants);
      return config;
    }),
    reviseSeat: vi.fn(function (this: unknown) {
      expect(this).toBe(grants);
      return config;
    }),
  };
  const deps: SymposiumDirectorCompositionDependencies = {
    store,
    currentAccounts,
    currentHost,
    runtime,
    safetyOrchestrator: safety,
    registry,
    grants,
  };
  const app = express();
  app.use(express.json(), cookieParser(), authMiddleware);
  app.get('/api/sessions/:id/symposium/source', (_req, res) => res.json({ earlier: true }));
  const mounts = vi.spyOn(app, 'use');
  (before ? mountDirectorBeforeExtraction : mountSymposiumDirectorRoutes)(app, deps);
  const mounted = mounts.mock.calls[0];
  mounts.mockRestore();
  const routes = vi.mocked(createSymposiumDirectorRouter).mock.calls.at(-1)![0];
  app.use('/api/sessions/:id/symposium', (_req, res) => res.json({ later: true }));
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  return {
    app,
    store,
    safety,
    accounts,
    currentAccounts,
    currentHost,
    runtime,
    registry,
    grants,
    mounted,
    routes,
    selectHost(value: Host) {
      host = value;
    },
    selectAccounts(value: typeof profiles) {
      profiles = value;
    },
    send(
      path = '',
      auth: 'operator' | 'internal' | 'none' = 'operator',
      method: 'get' | 'post' = 'get',
      id = 'session',
      body = {},
    ) {
      const sent = request(app)[method](`/api/sessions/${id}/symposium${path}`);
      if (auth === 'operator') sent.set('Authorization', `Bearer ${token}`);
      if (auth === 'internal') sent.set('x-internal-token', 'offline-internal');
      return method === 'post' ? sent.send(body) : sent;
    },
  };
}

describe.each([true, false])('Director composition (before=%s)', (before) => {
  it('mounts directly with operator auth and retains adjacent route precedence', async () => {
    const f = await fixture(before);
    expect(f.mounted).toHaveLength(3);
    expect(f.mounted?.[0]).toBe('/api/sessions/:id/symposium');
    expect(f.mounted?.[1]).toBe(operatorAuthMiddleware);
    expect(f.routes.store).toBe(f.store);
    expect(f.routes.profileBindingEnforced).toBe(true);
    expect((await f.send('/source')).body).toEqual({ earlier: true });
    expect((await f.send('/unknown')).body).toEqual({ later: true });
    for (const auth of ['none', 'internal', 'operator'] as const)
      expect((await f.send('', auth)).status).toBe(
        auth === 'none' ? 401 : auth === 'internal' ? 403 : 200,
      );
  });
  it('does not resolve the host, runtime or account catalog while mounting', async () => {
    const f = await fixture(before);
    expect(f.currentHost).not.toHaveBeenCalled();
    expect(f.currentAccounts).not.toHaveBeenCalled();
    expect(f.runtime).not.toHaveBeenCalled();
  });
  it('uses the current host and preserves absent capability, false and thrown readiness', async () => {
    const f = await fixture(before);
    expect(f.routes.artifactReady!('session', 'writer', 2)).toBe(true);
    f.selectHost({});
    expect(f.routes.artifactReady!('session', 'writer', 2)).toBe(true);
    const first = {
      artifactReady: vi.fn(function (this: unknown) {
        expect(this).toBe(first);
        return false;
      }),
    };
    f.selectHost(first);
    expect(f.routes.artifactReady!('session', 'writer', 2)).toBe(false);
    expect(first.artifactReady).toHaveBeenCalledWith('session', 'writer', 2);
    f.selectHost({ artifactReady: () => true });
    expect(f.routes.artifactReady!('session', 'writer', 3)).toBe(true);
    f.selectHost({
      artifactReady: () => {
        throw Error('unavailable');
      },
    });
    expect(() => f.routes.artifactReady!('session', 'writer', 3)).toThrow('unavailable');
  });
  it('retains live runtime lookup while durable status and safety fencing remain independent', async () => {
    const f = await fixture(before);
    expect((await f.send()).body.runtimeAvailable).toBe(false);
    expect(f.runtime).toHaveBeenLastCalledWith('session');
    f.runtime.mockReturnValue(f.safety);
    expect((await f.send()).body.runtimeAvailable).toBe(true);
    f.runtime.mockClear();
    expect((await f.send('/status')).body.runtimeVerification).toBe('not_checked');
    expect(f.runtime).not.toHaveBeenCalled();
    f.runtime.mockReturnValue(null);
    expect(f.routes.getSafetyOrchestrator('session')).toBe(f.safety);
    expect(f.runtime).not.toHaveBeenCalled();
    expect((await f.send('', 'operator', 'get', 'missing')).status).toBe(404);
  });
  it('requires a registry match and an active client before blocking ordinary draft conversion', async () => {
    const f = await fixture(before);
    expect(f.routes.hasOrdinaryRuntime!('ordinary')).toBe(false);
    expect(f.registry.isActive).not.toHaveBeenCalled();
    f.registry.findBySessionId.mockReturnValue({ clientId: 'current' } as never);
    expect(f.routes.hasOrdinaryRuntime!('ordinary')).toBe(false);
    expect(f.registry.isActive).toHaveBeenLastCalledWith('current');
    f.registry.isActive.mockReturnValue(true);
    const blocked = await f.send('/draft', 'operator', 'post', 'ordinary');
    expect(blocked.status).toBe(409);
    expect(blocked.body).toEqual({
      error: 'Stop the ordinary conversation before creating a Symposium draft',
      seatMutation: 'not-started',
    });
    expect(f.currentAccounts).not.toHaveBeenCalled();
  });
  it('validates bound seats against current profiles but leaves unbound Director selections alone', async () => {
    const f = await fixture(before);
    f.routes.validateSelection({ ...seat, accountBinding: undefined });
    expect(f.currentAccounts).not.toHaveBeenCalled();
    f.routes.validateSelection(seat);
    expect(f.accounts.validateModel).toHaveBeenCalledWith(binding, seat.model, 'low');
    const replacement = {
      resolve: vi.fn(() => binding),
      validateModel: vi.fn(() => {
        throw Error('changed catalog');
      }),
    };
    f.selectAccounts(replacement);
    expect(() => f.routes.validateSelection(seat)).toThrow('changed catalog');
    expect(replacement.validateModel).toHaveBeenCalledWith(binding, seat.model, 'low');
  });
  it('resolves and validates one current catalog snapshot and parses credential-free bindings', async () => {
    const f = await fixture(before);
    const next = {
      resolve: vi.fn(() => ({
        ...binding,
        accountLabel: 'New',
      })),
      validateModel: vi.fn(),
    };
    f.selectAccounts(next);
    const selected = await f.send('/selection', 'operator', 'post', 'session', {
      accountId: 'offline',
      model: seat.model,
      reasoningEffort: 'low',
    });
    expect(selected.status).toBe(200);
    expect(selected.body).toEqual({ binding: { ...binding, accountLabel: 'New' } });
    expect(f.currentAccounts).toHaveBeenCalledTimes(1);
    expect(next.resolve).toHaveBeenCalledWith('offline', seat.model);
    expect(next.validateModel).toHaveBeenCalledWith(
      next.resolve.mock.results[0].value,
      seat.model,
      'low',
    );
    next.validateModel.mockImplementation(() => {
      throw Error('private reason');
    });
    expect(
      (
        await f.send('/selection', 'operator', 'post', 'session', {
          accountId: 'offline',
          model: seat.model,
        })
      ).body,
    ).toEqual({ error: 'Selected account, model, or reasoning effort is unavailable' });
    next.validateModel.mockReset();
    next.resolve.mockReturnValue({
      ...binding,
      accountLabel: 'New',
      credentialRef: '/private/never-return',
    } as never);
    expect(() => f.routes.resolveSelection('offline', seat.model)).toThrow();
    next.resolve.mockReturnValue({ accountId: 'offline' } as never);
    expect(() => f.routes.resolveSelection('offline', seat.model)).toThrow();
  });
  it('borrows grant methods with their receiver, exact inputs and return values', async () => {
    const f = await fixture(before);
    const activation = { sessionId: 'session', expectedRevision: 0, actor: 'operator:offline' };
    const revision = { ...activation, seat };
    f.routes.validateActiveConfig('session', config);
    expect(f.grants.validateActiveConfig).toHaveBeenCalledWith('session', config);
    expect(f.routes.activateDraft(activation)).toBe(config);
    expect(f.grants.activate).toHaveBeenCalledWith(activation);
    expect(f.routes.reviseSeat(revision)).toBe(config);
    expect(f.grants.reviseSeat).toHaveBeenCalledWith(revision);
    f.grants.activate.mockImplementation(() => {
      throw Error('grant denied');
    });
    expect(() => f.routes.activateDraft(activation)).toThrow('grant denied');
  });
  it('projects perspectives and queued inputs through the borrowed event store', async () => {
    const f = await fixture(before);
    const events = vi.spyOn(f.store, 'getSymposiumPerspectiveEvents');
    const queued = vi.spyOn(f.store, 'getQueuedSymposiumRecipients');
    expect(
      f.routes.getPerspective(
        'session',
        { kind: 'seat', seatId: 'writer' },
        { afterSeq: 7, limit: 3 },
      ),
    ).toEqual({ items: [], nextSeq: null });
    expect(events).toHaveBeenCalledWith('session', 7, 3);
    expect(f.routes.getQueuedInputs('session', { kind: 'seat', seatId: 'writer' })).toEqual([]);
    expect(queued).toHaveBeenCalledWith('session', 'writer', 100);
    f.routes.getQueuedInputs('session', { kind: 'all' });
    expect(queued).toHaveBeenLastCalledWith('session', undefined, 100);
  });
});

it('pins the owner and preserves its application mount slot and borrowed inputs', () => {
  const source = readFileSync(
    new URL('../symposium-director-route-composition.ts', import.meta.url),
    'utf8',
  );
  const pins: Record<string, string> = reviewedHandlerSourceArtifacts;
  expect(pins['../symposium-director-route-composition.ts']).toBe(
    reviewedHandlerSourceFingerprint(source),
  );
  const app = readFileSync(new URL('../app.ts', import.meta.url), 'utf8');
  const mount = app.indexOf('mountSymposiumDirectorRoutes(app,');
  expect(mount).toBeGreaterThan(app.indexOf('mountSymposiumArtifactRoutes(app,'));
  expect(mount).toBeLessThan(app.indexOf("app.get('/api/openshell/lifecycle/"));
  expect(app.match(/mountSymposiumDirectorRoutes\(app,/g)).toHaveLength(1);
  for (const input of [
    'store: eventStore',
    'currentHost: () => symposiumProductionHost',
    'currentAccounts: symposiumAccountProfiles',
    'runtime: (sessionId) => symposiumRuntimeForSession(sessionId)',
    'safetyOrchestrator: symposiumSafetyOrchestrator',
    'grants: symposiumHostGrants',
    'registry,',
  ])
    expect(app.slice(mount, app.indexOf('\n});', mount))).toContain(input);
  // Host grant construction deliberately keeps its stronger missing-binding refusal.
  expect(app).toContain(
    "if (!seat.accountBinding) throw new Error('Seat account binding is required')",
  );
});

import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createCustodianIpcClient, serveCustodianController } from '../symposium-custodian-ipc.js';
import { SymposiumCustodianController } from '../symposium-custodian-controller.js';
import type { CapabilityApprovalRequest } from '../connections/capabilities/types.js';
class Channel extends EventEmitter {
  peer!: Channel;
  frames: unknown[] = [];
  send(frame: unknown) {
    this.frames.push(frame);
    queueMicrotask(() => this.peer.emit('message', frame));
    return true;
  }
}
const capability: CapabilityApprovalRequest = {
  capabilityId: 'github.create_pr',
  capabilityVersion: 1,
  connectionId: 'credential',
  operationId: 'operation',
  input: { repository: 'owner/repo', title: 'Reviewed' },
  forcePrompt: true,
};
it('round trips publication approval through the exact pending controller request', async () => {
  const parent = new Channel(),
    child = new Channel();
  parent.peer = child;
  child.peer = parent;
  const controller = new SymposiumCustodianController({
    pause() {},
    resume() {},
    async drain() {},
    invalidate() {},
    async dispatch(_command, current, approval) {
      current();
      expect(approval).toBeTypeOf('function');
      const allowed = await approval!(capability, new AbortController().signal);
      return { status: 200, body: { allowed } };
    },
  });
  const stopped = serveCustodianController(parent, controller);
  const client = createCustodianIpcClient(child);
  const approve = vi.fn(async (_request: CapabilityApprovalRequest, _signal: AbortSignal) => true);
  try {
    expect(
      await client.request(
        {
          requestId: 'request',
          operation: 'publication.publish',
          sessionId: 'session',
          body: {},
          query: {},
          authorization: { id: 'operator', expiresAt: Date.now() + 10000 },
        },
        approve,
      ),
    ).toEqual({ status: 200, body: { allowed: true } });
    expect(approve).toHaveBeenCalledOnce();
    expect(approve.mock.calls[0]?.[0]).toEqual(capability);
  } finally {
    child.emit('disconnect');
    parent.emit('disconnect');
    await stopped;
  }
});

import express from 'express';
import { operatorAuthMiddleware } from '../auth.js';
import { createPublicationRouter } from '../symposium-publication-routes.js';
import { dispatchCustodianHttp } from '../symposium-custodian-http.js';
import { custodianPublicationApproval } from '../symposium-custodian-authority.js';
import type { PublicationRegistration } from '../symposium-publication-registration.js';
import type { CustodianRequest } from '../symposium-custodian-protocol.js';
import type { CapabilityApproval } from '../connections/capabilities/types.js';
function command(): Omit<CustodianRequest, 'epoch'> {
  return {
    requestId: 'request',
    operation: 'publication.publish',
    sessionId: 'session',
    body: {
      grantId: 'grant',
      bindingHash: 'a'.repeat(64),
      turnId: 'turn',
      idempotencyKey: 'operation',
      baseBranch: 'main',
      title: 'Reviewed',
      body: 'Reviewed change',
      draft: true,
    },
    query: {},
    authorization: { id: 'operator', expiresAt: Date.now() + 10000 },
  };
}
function fixture(
  dispatch: (
    request: CustodianRequest,
    current: () => void,
    approval?: CapabilityApproval,
    signal?: AbortSignal,
  ) => Promise<{ status: number; body: unknown }>,
) {
  const parent = new Channel(),
    child = new Channel();
  parent.peer = child;
  child.peer = parent;
  const controller = new SymposiumCustodianController({
    pause() {},
    resume() {},
    async drain() {},
    invalidate() {},
    dispatch,
  });
  const stopped = serveCustodianController(parent, controller);
  const client = createCustodianIpcClient(child);
  return {
    parent,
    child,
    client,
    async close() {
      child.emit('disconnect');
      parent.emit('disconnect');
      await stopped;
    },
  };
}
it('runs actual authenticated publication HTTP routes in the retained owner with child-only approval', async () => {
  const app = express();
  app.use(express.json());
  app.use(operatorAuthMiddleware);
  const invoke = vi.fn(
    async (_input: unknown, signal: AbortSignal, approval: CapabilityApproval) => ({
      approved: await approval(capability, signal),
    }),
  );
  const registration = {
    authorize: () => new AbortController().signal,
    authority: {
      require: async () => ({ grant: { scope: { operatorId: 'operator', sessionId: 'session' } } }),
    },
    artifact: { require: async () => ({ repositoryPath: '/synthetic-artifact' }) },
    service: { invoke },
  } as unknown as PublicationRegistration;
  app.use(
    '/api/sessions/:id/symposium/publication',
    createPublicationRouter({
      registration: () => registration,
      hasSession: (id) => id === 'session',
      approval: (req) => custodianPublicationApproval(req),
    }),
  );
  const f = fixture((request, current, approval, signal) =>
    dispatchCustodianHttp(app, request, current, approval, signal),
  );
  try {
    expect(await f.client.request(command(), async () => true)).toEqual({
      status: 200,
      body: { approved: true },
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(JSON.stringify([...f.parent.frames, ...f.child.frames])).not.toContain(
      '/synthetic-artifact',
    );
  } finally {
    await f.close();
  }
});
it('denies an altered approval digest and ignores replay after settlement', async () => {
  const f = fixture(async (_r, _c, approval) => ({
    status: 200,
    body: { allowed: await approval!(capability, new AbortController().signal) },
  }));
  const original = f.child.send.bind(f.child);
  f.child.send = (value: unknown) => {
    const frame = value as Record<string, unknown>;
    return original(
      frame.kind === 'publication-decision' ? { ...frame, digest: 'b'.repeat(64) } : value,
    );
  };
  try {
    expect(await f.client.request(command(), async () => true)).toEqual({
      status: 200,
      body: { allowed: false },
    });
    const reply = f.child.frames.find(
      (v) => (v as { kind: string }).kind === 'publication-decision',
    );
    original(reply);
    await Promise.resolve();
  } finally {
    await f.close();
  }
});
it('propagates HTTP cancellation and preserves a settled pending operation observation', async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const observations: string[] = [];
  const f = fixture(async (_r, _c, approval, signal) => {
    if (!(await approval!(capability, signal!))) throw Error('denied');
    observations.push('dispatched');
    entered();
    await new Promise<void>((resolve) =>
      signal!.addEventListener('abort', () => resolve(), { once: true }),
    );
    observations.push('outcome-unknown');
    return { status: 409, body: { state: 'outcome-unknown' } };
  });
  const abort = new AbortController();
  try {
    const work = f.client.request(command(), async () => true, abort.signal);
    await ready;
    abort.abort();
    expect(await work).toEqual({ status: 409, body: { state: 'outcome-unknown' } });
    expect(observations).toEqual(['dispatched', 'outcome-unknown']);
  } finally {
    await f.close();
  }
});
it('aborts the child permission prompt when its epoch is lost', async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let promptSignal: AbortSignal | undefined;
  const f = fixture(async (_r, _c, approval, signal) => ({
    status: 200,
    body: await approval!(capability, signal!),
  }));
  const work = f.client.request(command(), async (_request, signal) => {
    promptSignal = signal;
    entered();
    return await new Promise<boolean>((resolve) =>
      signal.addEventListener('abort', () => resolve(false), { once: true }),
    );
  });
  const rejected = expect(work).rejects.toThrow('channel');
  await ready;
  await f.close();
  await rejected;
  expect(promptSignal?.aborted).toBe(true);
});

import { SessionRegistry, ConnectionRegistry, resolvePending } from '@mitzo/harness';
import { publicationControllerApproval } from '../symposium-publication-approval.js';
it.each(['approve', 'unwatch', 'auth-loss'] as const)(
  'uses the existing browser permission owner across IPC: %s',
  async (mode) => {
    const registry = new SessionRegistry(),
      connections = new ConnectionRegistry();
    let owned = true;
    const send = vi.fn((event: Record<string, unknown>) => {
      if (event.type === 'permission_request') {
        if (mode === 'unwatch') connections.unwatch('browser', 'session');
        else {
          if (mode === 'auth-loss') owned = false;
          resolvePending(String(event.permId), 'once');
        }
      }
    });
    connections.register('browser', { send, isOpen: () => true });
    connections.watch('browser', 'session');
    const approval = publicationControllerApproval(
      registry,
      (_id, auth) => owned && auth === 'operator',
      'session',
      'operator',
      'browser',
      connections,
    )!;
    const f = fixture(async (_r, _c, approve, signal) => ({
      status: 200,
      body: { allowed: await approve!(capability, signal!) },
    }));
    try {
      expect(await f.client.request(command(), approval)).toEqual({
        status: 200,
        body: { allowed: mode === 'approve' },
      });
      expect(send).toHaveBeenCalled();
      expect(registry.findBySessionId('session', true)).toBeNull();
    } finally {
      await f.close();
      registry.dispose();
      connections.dispose();
    }
  },
);

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CustodianChannel } from '../symposium-custodian-ipc.js';
it('composes the real publication router with a separate child process and permission queue', async () => {
  const app = express();
  app.use(express.json());
  app.use(operatorAuthMiddleware);
  const registration = {
    authorize: () => new AbortController().signal,
    authority: {
      require: async () => ({
        grant: { scope: { operatorId: 'synthetic-test-operator', sessionId: 'session' } },
      }),
    },
    artifact: { require: async () => ({ repositoryPath: '/synthetic-artifact' }) },
    service: {
      invoke: async (_input: unknown, signal: AbortSignal, approval: CapabilityApproval) => ({
        approved: await approval(capability, signal),
      }),
    },
  } as unknown as PublicationRegistration;
  app.use(
    '/api/sessions/:id/symposium/publication',
    createPublicationRouter({
      registration: () => registration,
      hasSession: (id) => id === 'session',
      approval: (req) => custodianPublicationApproval(req),
    }),
  );
  const child = fork(
    fileURLToPath(new URL('./fixtures/custodian-publication-child.ts', import.meta.url)),
    [],
    {
      execArgv: ['--import', 'tsx'],
      env: { PATH: process.env.PATH, NODE_ENV: 'test' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  const result = new Promise<unknown>((resolve, reject) => {
    child.on('message', (value) => {
      const frame = value as { kind: string; result?: unknown };
      if (frame.kind === 'test-result') resolve(frame.result);
      if (frame.kind === 'test-failure') reject(Error('Child test failed'));
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code) reject(Error('Child exit failed'));
    });
  });
  const controller = new SymposiumCustodianController({
    pause() {},
    resume() {},
    async drain() {},
    invalidate() {},
    dispatch: (command, current, approval, signal) =>
      dispatchCustodianHttp(app, command, current, approval, signal),
  });
  const stopped = serveCustodianController(child as unknown as CustodianChannel, controller);
  try {
    expect(await result).toEqual({ status: 200, body: { approved: true } });
    await stopped;
  } finally {
    child.kill();
  }
}, 15000);

it.each(['epoch', 'authId', 'sessionId', 'requestId'] as const)(
  'denies a decision with changed %s',
  async (field) => {
    const f = fixture(async (_r, _c, approval, signal) => ({
      status: 200,
      body: { allowed: await approval!(capability, signal!) },
    }));
    const original = f.child.send.bind(f.child);
    f.child.send = (value: unknown) => {
      const frame = value as Record<string, unknown>;
      return original(
        frame.kind === 'publication-decision'
          ? { ...frame, [field]: field === 'epoch' ? 99 : 'other' }
          : value,
      );
    };
    try {
      expect(await f.client.request(command(), async () => true)).toEqual({
        status: 200,
        body: { allowed: false },
      });
    } finally {
      await f.close();
    }
  },
);
it('does not prompt twice when a parent challenge is replayed', async () => {
  const f = fixture(async (_r, _c, approval, signal) => ({
    status: 200,
    body: { allowed: await approval!(capability, signal!) },
  }));
  const original = f.parent.send.bind(f.parent);
  f.parent.send = (value: unknown) => {
    original(value);
    if ((value as { kind: string }).kind === 'publication-approval') original(value);
    return true;
  };
  const approve = vi.fn(async () => true);
  try {
    expect(await f.client.request(command(), approve)).toEqual({
      status: 200,
      body: { allowed: true },
    });
    expect(approve).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

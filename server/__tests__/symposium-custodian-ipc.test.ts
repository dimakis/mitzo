import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import {
  createCustodianIpcClient,
  serveCustodianController,
  validateCustodianMode,
} from '../symposium-custodian-ipc.js';
import { SymposiumCustodianController } from '../symposium-custodian-controller.js';
class Channel extends EventEmitter {
  peer!: Channel;
  connected = true;
  send(message: unknown) {
    queueMicrotask(() => this.peer.emit('message', message));
    return true;
  }
}
function pair() {
  const a = new Channel(),
    b = new Channel();
  a.peer = b;
  b.peer = a;
  return [a, b] as const;
}
it('refuses controller mode without the inherited parent channel', () => {
  expect(() => validateCustodianMode('1', false, undefined)).toThrow('inherited');
  expect(() => validateCustodianMode('yes', true, () => {})).toThrow('mode');
  expect(validateCustodianMode(undefined, false, undefined)).toBe(false);
});
it('binds semantic traffic to one inherited channel and drains on its loss', async () => {
  const [parent, child] = pair();
  const drain = vi.fn(async () => {});
  const controller = new SymposiumCustodianController({
    pause: vi.fn(),
    resume: vi.fn(),
    drain,
    invalidate: vi.fn(),
    dispatch: async (command) => ({ status: 200, body: { session: command.sessionId } }),
  });
  const stopped = serveCustodianController(parent, controller, { heartbeatMs: 100 });
  const client = createCustodianIpcClient(child, { heartbeatMs: 10 });
  expect(
    await client.request({
      requestId: 'r',
      operation: 'director.status',
      sessionId: 's',
      body: {},
      query: {},
      authorization: { id: 'j', expiresAt: Date.now() + 1000 },
    }),
  ).toEqual({ status: 200, body: { session: 's' } });
  child.emit('disconnect');
  parent.emit('disconnect');
  await stopped;
  expect(drain).toHaveBeenCalledOnce();
  await expect(
    client.request({
      requestId: 'r2',
      operation: 'director.status',
      sessionId: 's',
      body: {},
      query: {},
      authorization: { id: 'j', expiresAt: Date.now() + 1000 },
    }),
  ).rejects.toThrow('channel');
});
it('treats a silent controller as lost and rejects arbitrary messages', async () => {
  const [parent, child] = pair();
  const dispatch = vi.fn();
  const drain = vi.fn(async () => {});
  const controller = new SymposiumCustodianController({
    pause: vi.fn(),
    resume: vi.fn(),
    drain,
    invalidate: vi.fn(),
    dispatch,
  });
  const stopped = serveCustodianController(parent, controller, { heartbeatMs: 20 });
  child.send({ kind: 'exec', argv: ['anything'] });
  await stopped;
  expect(dispatch).not.toHaveBeenCalled();
  expect(drain).toHaveBeenCalledOnce();
});

it.each(['personal.list', 'account.catalog'] as const)(
  'releases aborted %s reads from client capacity and ignores late owner responses',
  async (operation) => {
    const [parent, child] = pair();
    const frames: Array<{ kind: string; command?: { requestId: string } }> = [];
    parent.on('message', (frame) => frames.push(frame));
    const client = createCustodianIpcClient(child, {
      heartbeatMs: 60_000,
      requestTimeoutMs: 60_000,
    });
    parent.send({ kind: 'ready', epoch: 1 });
    const controllers = Array.from({ length: 64 }, () => new AbortController());
    const input = (requestId: string) => ({
      operation,
      requestId,
      body: {},
      query: {},
      authorization: { id: 'browser-read', expiresAt: Date.now() + 60_000 },
    });
    const aborted = controllers.map((controller, index) =>
      client
        .request(input(`read-${index}`), undefined, controller.signal)
        .catch((error) => (error as Error).message),
    );
    let followup: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() =>
        expect(frames.filter((frame) => frame.kind === 'request')).toHaveLength(64),
      );
      controllers.forEach((controller) => controller.abort());
      let settled = false;
      followup = client.request(input('followup')).then(
        (response) => {
          settled = true;
          return response;
        },
        (error) => {
          settled = true;
          throw error;
        },
      );
      // Attach a handler before assertions so a capacity rejection cannot become unhandled.
      void followup.catch(() => {});
      await vi.waitFor(() =>
        expect(frames.some((frame) => frame.command?.requestId === 'followup')).toBe(true),
      );
      parent.send({
        kind: 'response',
        requestId: 'read-0',
        result: { status: 200, body: { stale: true } },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      parent.send({
        kind: 'response',
        requestId: 'followup',
        result: { status: 200, body: { current: true } },
      });
      await expect(followup).resolves.toEqual({ status: 200, body: { current: true } });
      expect(await Promise.all(aborted)).toEqual(Array(64).fill('Custodian read cancelled'));
      expect(frames.some((frame) => frame.kind === 'publication-request-cancel')).toBe(false);
    } finally {
      child.emit('disconnect');
      await Promise.all(aborted);
      await followup?.catch(() => {});
    }
  },
);

it.each(['abort', 'timeout'] as const)(
  'releases owner capacity for inventory reads on %s even when a handler ignores cancellation',
  async (mode) => {
    const [parent, child] = pair();
    const signals: AbortSignal[] = [];
    const release: Array<() => void> = [];
    const controller = new SymposiumCustodianController({
      pause: vi.fn(),
      resume: vi.fn(),
      drain: async () => {},
      invalidate: vi.fn(),
      dispatch: async (command, _assert, _approval, signal) => {
        if (command.operation === 'director.status') return { status: 200, body: {} };
        if (signal) signals.push(signal);
        return new Promise((resolve) => release.push(() => resolve({ status: 200, body: {} })));
      },
    });
    const stopped = serveCustodianController(parent, controller);
    const client = createCustodianIpcClient(child, {
      requestTimeoutMs: mode === 'timeout' ? 100 : 60_000,
    });
    const aborts = Array.from({ length: 64 }, () => new AbortController());
    const reads = aborts.map((abort, index) =>
      client
        .request(
          {
            requestId: `owner-read-${index}`,
            operation: index % 2 ? 'personal.list' : 'account.catalog',
            body: {},
            query: {},
            authorization: { id: 'browser', expiresAt: Date.now() + 60_000 },
          },
          undefined,
          abort.signal,
        )
        .catch(() => undefined),
    );
    try {
      await vi.waitFor(() => expect(signals).toHaveLength(64), { timeout: 500 });
      if (mode === 'abort') aborts.forEach((abort) => abort.abort());
      await Promise.all(reads);
      await vi.waitFor(() => expect(signals.every((signal) => signal.aborted)).toBe(true));
      await expect(
        client.request({
          requestId: 'unrelated',
          operation: 'director.status',
          sessionId: 's',
          body: {},
          query: {},
          authorization: { id: 'browser', expiresAt: Date.now() + 60_000 },
        }),
      ).resolves.toEqual({ status: 200, body: {} });
    } finally {
      release.forEach((resolve) => resolve());
      child.emit('disconnect');
      parent.emit('disconnect');
      await stopped;
    }
  },
);

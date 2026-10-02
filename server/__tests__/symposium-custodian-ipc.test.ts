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

it('observes the authoritative original epoch once before ready, with a live original connection guard', async () => {
  const [parent] = pair();
  const controller = new SymposiumCustodianController({
    pause: vi.fn(),
    resume: vi.fn(),
    drain: async () => {},
    invalidate: vi.fn(),
    dispatch: async () => ({ status: 200, body: {} }),
  });
  let guard: (() => void) | undefined;
  const observed = vi.fn((epoch: number, current: () => void) => {
    expect(epoch).toBe(1);
    current();
    guard = current;
  });
  const sent = vi.spyOn(parent, 'send');
  const stopped = serveCustodianController(parent, controller, {
    heartbeatMs: 100,
    observeReady: observed,
  });
  try {
    parent.emit('message', { kind: 'hello' });
    parent.emit('message', { kind: 'hello' });
    expect(observed).toHaveBeenCalledOnce();
    expect(sent).toHaveBeenCalledWith({ kind: 'ready', epoch: 1 }, expect.any(Function));
    expect(observed.mock.invocationCallOrder[0]).toBeLessThan(sent.mock.invocationCallOrder[0]);
  } finally {
    parent.emit('disconnect');
    await stopped;
  }
  expect(() => guard!()).toThrow('unavailable');
});
it('failed original ready observer never sends readiness or restarts the connection', async () => {
  const [parent] = pair();
  const drain = vi.fn(async () => {});
  const controller = new SymposiumCustodianController({
    pause: vi.fn(),
    resume: vi.fn(),
    drain,
    invalidate: vi.fn(),
    dispatch: async () => ({ status: 200, body: {} }),
  });
  const sent = vi.spyOn(parent, 'send');
  const stopped = serveCustodianController(parent, controller, {
    heartbeatMs: 100,
    observeReady() {
      throw Error('synthetic observer refusal');
    },
  });
  const expected = expect(stopped).rejects.toThrow('Original controller observation failed');
  parent.emit('message', { kind: 'hello' });
  parent.emit('disconnect');
  await expected;
  expect(sent).not.toHaveBeenCalled();
  expect(drain).toHaveBeenCalledOnce();
});

it('rejects asynchronous ready observers rather than issuing readiness before their result', async () => {
  const [parent] = pair();
  const controller = new SymposiumCustodianController({
    pause: vi.fn(),
    resume: vi.fn(),
    drain: async () => {},
    invalidate: vi.fn(),
    dispatch: async () => ({ status: 200, body: {} }),
  });
  const send = vi.spyOn(parent, 'send');
  const stopped = serveCustodianController(parent, controller, {
    observeReady: async () => {
      throw Error('synthetic unexpected async rejection');
    },
  });
  const rejected = expect(stopped).rejects.toThrow('Original controller observation failed');
  parent.emit('message', { kind: 'hello' });
  await rejected;
  expect(send).not.toHaveBeenCalled();
});

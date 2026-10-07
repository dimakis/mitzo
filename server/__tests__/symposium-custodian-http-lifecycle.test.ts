import express from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { custodianRequestAuthority } from '../symposium-custodian-authority.js';
import { dispatchCustodianHttp } from '../symposium-custodian-http.js';

const command = () => ({
  epoch: 1,
  requestId: 'terminal-request',
  operation: 'source.import' as const,
  sessionId: 's1',
  body: {},
  query: {},
  authorization: { id: 'hermetic-operator', expiresAt: Date.now() + 30_000 },
});

it.each([
  'success',
  'decision',
  'invalid-json',
  'expired',
  'cancelled',
  'oversize',
  'handler-error',
  'unhandled',
] as const)('releases registered response lifecycle cleanup on %s', async (mode) => {
  const app = express();
  const cleanup = vi.fn();
  const terminal: string[] = [];
  let request: IncomingMessage | undefined;
  let response: ServerResponse | undefined;
  let expired = false;
  const abort = new AbortController();
  app.use((req, res, next) => {
    request = req;
    response = res;
    // These are the same terminal hooks used by the application to unregister
    // interactive authorization and release its request-bound action context.
    res.once('finish', () => {
      terminal.push('finish');
      cleanup();
    });
    res.once('close', () => {
      terminal.push('close');
      cleanup();
    });
    next();
  });
  if (mode !== 'unhandled')
    app.post('/api/sessions/s1/symposium/source/import', (_req, res, next) => {
      if (mode === 'handler-error') return next(Error('handler failure'));
      if (mode === 'expired') expired = true;
      if (mode === 'cancelled') abort.abort(Error('request cancelled'));
      if (mode === 'oversize') return res.end('x'.repeat(16 * 1024 * 1024 + 1));
      if (mode === 'invalid-json') return res.end('not JSON');
      return res.status(mode === 'decision' ? 409 : 200).json({ accepted: true });
    });
  const dispatched = dispatchCustodianHttp(
    app,
    command(),
    () => {
      abort.signal.throwIfAborted();
      if (expired) throw Error('authority revoked');
    },
    undefined,
    abort.signal,
  );
  if (mode === 'success' || mode === 'decision')
    expect(await dispatched).toEqual({
      status: mode === 'decision' ? 409 : 200,
      body: { accepted: true },
    });
  else {
    const failures = {
      'invalid-json': /JSON/,
      expired: /authority revoked/,
      cancelled: /request cancelled/,
      oversize: /Custodian response too large/,
      'handler-error': /handler failure/,
      unhandled: /Custodian semantic handler unavailable/,
    };
    await expect(dispatched).rejects.toThrow(failures[mode]);
  }
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(terminal).toEqual([mode === 'success' || mode === 'decision' ? 'finish' : 'close']);
  expect(custodianRequestAuthority(request!)).toBeUndefined();
  // No unconnected socket is presented as a flushed HTTP response.
  expect(response!.socket).toBeNull();
});

it('rejects initial revoked authority before creating a handler lifecycle', async () => {
  const app = express();
  const handler = vi.fn();
  app.use(handler);
  await expect(
    dispatchCustodianHttp(app, command(), () => {
      throw Error('revoked before dispatch');
    }),
  ).rejects.toThrow('revoked before dispatch');
  expect(handler).not.toHaveBeenCalled();
});

it.each([false, true])(
  'releases authority when terminal cleanup throws (rejected=%s)',
  async (rejected) => {
    const app = express();
    let request: IncomingMessage | undefined;
    app.post('/api/sessions/s1/symposium/source/import', (req, res, next) => {
      request = req;
      res.once(rejected ? 'close' : 'finish', () => {
        throw Error('cleanup failure');
      });
      if (rejected) return next(Error('original handler failure'));
      res.json({ accepted: true });
    });
    await expect(dispatchCustodianHttp(app, command(), () => {})).rejects.toThrow(
      rejected ? 'original handler failure' : 'cleanup failure',
    );
    expect(custodianRequestAuthority(request!)).toBeUndefined();
    expect(request!.destroyed).toBe(true);
  },
);

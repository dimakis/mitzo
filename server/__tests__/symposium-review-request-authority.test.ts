import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import * as auth from '../operator-session.js';
import { bindCustodianAuthority } from '../symposium-custodian-authority.js';
import { SymposiumReviewActionAuthority } from '../symposium-review-action-authority.js';
import { createSymposiumReviewRequestAuthorizer } from '../symposium-review-route-composition.js';

vi.mock('../internal-token.js', () => ({ isValidInternalToken: () => false }));
vi.mock('../logger.js', () => ({ createLogger: () => ({ error: vi.fn() }) }));
// Importing the request boundary must never bootstrap app/runtime/store owners.
vi.mock('../app.js', () => {
  throw Error('Application bootstrap imported');
});
vi.mock('../chat.js', () => {
  throw Error('Chat bootstrap imported');
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close());
  vi.restoreAllMocks();
});

async function fixture(action: unknown = 'cleanup-check') {
  const session = (await auth.authenticateToken(
    (await auth.login(process.env.AUTH_PASSPHRASE!))!,
  ))!;
  const req = { body: { action } } as Request;
  const response = Object.assign(new EventEmitter(), {
    locals: { authSession: session },
    writableEnded: false,
  });
  const res = response as unknown as Response;
  const authority = new SymposiumReviewActionAuthority();
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const realBind = authority.bind.bind(authority);
  vi.spyOn(authority, 'bind').mockImplementation((...args) => {
    const release = vi.fn(realBind(...args));
    releases.push(release);
    return release;
  });
  const unregisters: Array<ReturnType<typeof vi.fn>> = [];
  const register = auth.registerAuthSession;
  vi.spyOn(auth, 'registerAuthSession').mockImplementation((...args) => {
    const unregister = vi.fn(register(...args));
    unregisters.push(unregister);
    return unregister;
  });
  cleanups.push(() => response.emit('close'));
  const authorize = createSymposiumReviewRequestAuthorizer(authority);
  const context = { sessionId: 'session', owner: 'user' };
  return { session, req, res, response, authority, authorize, context, releases, unregisters };
}

it('binds the exact context and action; serialized copies and changed scopes confer no authority', async () => {
  const f = await fixture('fix');
  expect(f.authorize(f.req, f.res, f.context)).toBe(f.context);
  expect(f.authority.authorize({ ...f.context }, 'fix')).toBeNull();
  expect(f.authority.authorize(f.context, 'review')).toBeNull();
  f.context.sessionId = 'foreign';
  expect(f.authority.authorize(f.context, 'fix')).toBeNull();
  f.context.sessionId = 'session';
  f.context.owner = 'foreign';
  expect(f.authority.authorize(f.context, 'fix')).toBeNull();
  f.context.owner = 'user';
  expect(f.authority.authorize(f.context, 'fix')).toHaveProperty('authorizationId');
  expect(f.authority.authorize(f.context, 'fix')).toBeNull();
});

it.each(['finish', 'close'])(
  'releases the capability and auth listener on response %s',
  async (event) => {
    const f = await fixture();
    f.authorize(f.req, f.res, f.context);
    expect(() => f.authority.assertCurrent(f.context, 'cleanup-check')).not.toThrow();
    f.response.emit(event);
    expect(() => f.authority.assertCurrent(f.context, 'cleanup-check')).toThrow();
    expect(f.releases[0]).toHaveBeenCalledOnce();
    expect(f.unregisters[0]).toHaveBeenCalledOnce();
    // The existing finish/close pair can both fire; repeated teardown remains safe.
    f.response.emit(event === 'finish' ? 'close' : 'finish');
    expect(() => f.authority.assertCurrent(f.context, 'cleanup-check')).toThrow();
  },
);

it.each(['revoke', 'expire', 'ended'])(
  'invalidates current authority after %s during an await',
  async (event) => {
    const f = await fixture();
    f.authorize(f.req, f.res, f.context);
    await Promise.resolve();
    if (event === 'revoke') auth.revokeAuthSession(f.session);
    if (event === 'expire') vi.spyOn(Date, 'now').mockReturnValue(f.session.expiresAt);
    if (event === 'ended') f.response.writableEnded = true;
    expect(() => f.authority.assertCurrent(f.context, 'cleanup-check')).toThrow(
      'authorization expired',
    );
    expect(f.authority.authorize(f.context, 'cleanup-check')).toBeNull();
  },
);

it.each(['missing', 'revoked', 'expired'])(
  'refuses %s interactive authorization before binding',
  async (state) => {
    const f = await fixture();
    if (state === 'missing') delete (f.res.locals as { authSession?: unknown }).authSession;
    if (state === 'revoked') auth.revokeAuthSession(f.session);
    if (state === 'expired') vi.spyOn(Date, 'now').mockReturnValue(f.session.expiresAt);
    expect(() => f.authorize(f.req, f.res, f.context)).toThrow();
    expect(f.authority.authorize(f.context, 'cleanup-check')).toBeNull();
    expect(f.response.listenerCount('finish')).toBe(0);
    if (state !== 'missing') expect(f.unregisters[0]).toHaveBeenCalledOnce();
  },
);

it('unregisters the newly created auth listener when action binding fails', async () => {
  const f = await fixture();
  vi.spyOn(f.authority, 'bind').mockImplementationOnce(() => {
    throw Error('Already bound');
  });
  expect(() => f.authorize(f.req, f.res, f.context)).toThrow('Already bound');
  expect(f.unregisters[0]).toHaveBeenCalledOnce();
  expect(f.response.listenerCount('finish')).toBe(0);
});

it.each(['release', 'replace', 'revoke'])(
  'fences retained custodian authority after %s',
  async (change) => {
    const f = await fixture();
    let active = true;
    const release = bindCustodianAuthority(f.req, {
      authorization: { id: 'retained', expiresAt: f.session.expiresAt },
      assertCurrent() {
        if (!active) throw Error('Retained request revoked');
      },
    });
    cleanups.push(release);
    f.authorize(f.req, f.res, f.context);
    expect(() => f.authority.assertCurrent(f.context, 'cleanup-check')).not.toThrow();
    if (change === 'revoke') active = false;
    else release();
    if (change === 'replace')
      cleanups.push(
        bindCustodianAuthority(f.req, {
          authorization: { id: 'replacement', expiresAt: f.session.expiresAt },
          assertCurrent() {},
        }),
      );
    expect(() => f.authority.assertCurrent(f.context, 'cleanup-check')).toThrow();
    expect(f.authority.authorize(f.context, 'cleanup-check')).toBeNull();
  },
);

it('keeps concurrent contexts independent when one response disconnects', async () => {
  const f = await fixture();
  const other = Object.assign(new EventEmitter(), {
    locals: { authSession: f.session },
    writableEnded: false,
  });
  cleanups.push(() => other.emit('close'));
  const context = { ...f.context };
  f.authorize(f.req, f.res, f.context);
  f.authorize(f.req, other as unknown as Response, context);
  f.response.emit('close');
  expect(() => f.authority.assertCurrent(f.context, 'cleanup-check')).toThrow();
  expect(() => f.authority.assertCurrent(context, 'cleanup-check')).not.toThrow();
  auth.revokeAuthSession(f.session);
  expect(() => f.authority.assertCurrent(context, 'cleanup-check')).toThrow();
});

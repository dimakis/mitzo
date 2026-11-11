import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAccountStore, readManagedClaudeProfiles } from '../claude-account-store.js';
import { ClaudeAccountLogin } from '../claude-account-login.js';

const roots: string[] = [];
const stores: ClaudeAccountStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(['custody', 'journal'])(
  'retains a failed submission and cleans native work after %s failure',
  async (failure) => {
    const f = fixture(),
      session = auth(),
      request = input();
    await f.host.start(session, request);
    if (failure === 'custody')
      vi.spyOn(f.store, 'assertConfig').mockImplementationOnce(() => {
        throw Error('custody changed');
      });
    else
      vi.spyOn(f.store, 'update').mockImplementationOnce(() => {
        throw Error('journal unavailable');
      });
    await expect(
      f.host.submit(session, request.requestId, 'secret#expected'),
    ).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'CLAUDE_LOGIN_CODE_UNCONFIRMED',
      diagnosticId: expect.any(String),
    });
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.cancel).toHaveBeenCalledOnce();
    await expect(f.host.submit(session, request.requestId, 'secret#expected')).rejects.toThrow();
    expect(f.store.hasUnconfirmedCleanup()).toBe(false);
  },
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('retains admission through cancellation during native startup and shutdown', async () => {
  const f = fixture(),
    session = auth(),
    request = input();
  const startup = deferred(),
    shutdown = deferred();
  const create = f.createLogin.getMockImplementation()!;
  f.createLogin.mockImplementationOnce(async (...args) => {
    await startup.promise;
    return create(...args);
  });
  f.cancel.mockImplementationOnce(async () => {
    await shutdown.promise;
  });
  const starting = f.host.start(session, request);
  const cancelling = f.host.cancel(session, request.requestId);
  let cancelled = false;
  void cancelling.then(() => {
    cancelled = true;
  });
  expect(f.store.hasUnconfirmedCleanup()).toBe(true);
  await expect(f.host.start(session, input())).rejects.toThrow();
  expect(cancelled).toBe(false);
  startup.resolve();
  await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
  await expect(f.host.start(session, input())).rejects.toThrow();
  expect(cancelled).toBe(false);
  shutdown.resolve();
  await Promise.all([starting, cancelling]);
  expect(f.cancel).toHaveBeenCalledOnce();
  expect(f.store.hasUnconfirmedCleanup()).toBe(false);
  await expect(f.host.start(session, input())).resolves.toMatchObject({ state: 'pending' });
});

it('fences new starts and waits for deferred startup before closing storage', async () => {
  const f = fixture(),
    session = auth(),
    request = input();
  const startup = deferred();
  const create = f.createLogin.getMockImplementation()!;
  f.createLogin.mockImplementationOnce(async (...args) => {
    await startup.promise;
    return create(...args);
  });
  const starting = f.host.start(session, request);
  const close = vi.spyOn(f.store, 'close');
  const closing = f.host.close();
  await expect(f.host.start(session, input())).rejects.toThrow('stopping');
  expect(close).not.toHaveBeenCalled();
  startup.resolve();
  await Promise.all([starting, closing]);
  expect(f.cancel).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  stores.splice(stores.indexOf(f.store), 1);
});

it.each([false, true])(
  'drains an in-flight code submission before closing storage; rejection=%s',
  async (reject) => {
    const f = fixture(),
      session = auth(),
      request = input(),
      delivery = deferred();
    await f.host.start(session, request);
    f.submit.mockImplementationOnce(async () => {
      await delivery.promise;
      if (reject) throw Error('late delivery failure');
    });
    const submitting = f.host.submit(session, request.requestId, 'secret#expected');
    const close = vi.spyOn(f.store, 'close');
    const closing = f.host.close();
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
    expect(close).not.toHaveBeenCalled();
    delivery.resolve();
    await expect(submitting).resolves.toMatchObject({ state: reject ? 'failed' : 'cancelled' });
    await closing;
    expect(close).toHaveBeenCalledOnce();
    expect(() => f.host.status(session, request.requestId)).toThrow('stopped');
    stores.splice(stores.indexOf(f.store), 1);
  },
);

it('retains unconfirmed cleanup across host recovery and deduplicates concurrent cancellation', async () => {
  const f = fixture(),
    session = auth(),
    request = input(),
    shutdown = deferred();
  await f.host.start(session, request);
  f.cancel.mockImplementationOnce(async () => {
    await shutdown.promise;
  });
  const first = f.host.cancel(session, request.requestId);
  const second = f.host.cancel(session, request.requestId);
  const recovered = new ClaudeAccountLogin({
    store: f.store,
    isCurrent: () => true,
    observe: () => () => undefined,
    createLogin: f.createLogin,
  });
  await expect(recovered.start(session, input())).rejects.toThrow('host recovery');
  f.complete();
  expect(f.verify).not.toHaveBeenCalled();
  shutdown.resolve();
  await Promise.all([first, second]);
  expect(f.cancel).toHaveBeenCalledOnce();
  expect(f.store.accounts()).toEqual([]);
});
const auth = () => ({ id: 'browser-one', expiresAt: Date.now() + 60_000 });
const input = () => ({ requestId: crypto.randomUUID(), label: 'Personal Claude' });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-login-')));
  roots.push(root);
  const store = new ClaudeAccountStore(join(root, 'accounts'));
  stores.push(store);
  let complete!: (result: { ok: true } | { ok: false; cause: Error }) => void;
  const submit = vi.fn();
  const cancel = vi.fn(async () => complete({ ok: false, cause: Error('cancelled') }));
  const createLogin = vi.fn(async (_config: string, _signal: AbortSignal) => ({
    url: 'https://claude.com/cai/oauth/authorize?state=expected',
    completion: new Promise<{ ok: true } | { ok: false; cause: Error }>((resolve) => {
      complete = resolve;
    }),
    submit,
    cancel,
  }));
  const identity = { email: 'person@example.test', planType: 'max' as const };
  const verify = vi.fn(async () => identity);
  let current = true;
  let revoke!: () => void;
  const host = new ClaudeAccountLogin({
    store,
    createLogin,
    verify,
    isCurrent: () => current,
    observe: (_auth, callback) => {
      revoke = () => callback('revoked');
      return vi.fn();
    },
  });
  return {
    root,
    store,
    host,
    createLogin,
    verify,
    submit,
    cancel,
    identity,
    complete: () => complete({ ok: true }),
    revoke: () => {
      current = false;
      revoke();
    },
  };
}

it('retains an exact login attempt, accepts a private code once, and registers only verified identity', async () => {
  const f = fixture(),
    session = auth(),
    request = input();
  const first = await f.host.start(session, request);
  expect(first.state).toBe('pending');
  expect(await f.host.start(session, request)).toEqual(first);
  expect(f.createLogin).toHaveBeenCalledOnce();
  expect(readManagedClaudeProfiles(f.store.root)).toEqual([]);
  expect(statSync(f.createLogin.mock.calls[0][0]).mode & 0o777).toBe(0o700);
  await expect(f.host.submit(session, request.requestId, 'wrong#state')).rejects.toThrow();
  expect(f.submit).not.toHaveBeenCalled();
  await f.host.submit(session, request.requestId, 'secret-code#expected');
  await expect(f.host.submit(session, request.requestId, 'secret-code#expected')).rejects.toThrow();
  f.complete();
  await vi.waitFor(() => expect(f.host.status(session, request.requestId).state).toBe('connected'));
  expect(f.verify).toHaveBeenCalledOnce();
  const profiles = readManagedClaudeProfiles(f.store.root);
  expect(profiles).toEqual([
    expect.objectContaining({
      id: expect.stringContaining('claude-'),
      provider: 'anthropic-claude',
      email: f.identity.email,
      planType: 'max',
      models: expect.any(Array),
    }),
  ]);
  const publicStatus = JSON.stringify(f.host.list(session));
  expect(publicStatus).toContain(f.identity.email);
  expect(publicStatus).not.toMatch(/secret-code|credentialRef|CLAUDE_CONFIG_DIR|accessToken/);
  expect(publicStatus).not.toContain(f.root);
});

it('cancels on revocation and never publishes a late successful login', async () => {
  const f = fixture(),
    session = auth(),
    request = input();
  await f.host.start(session, request);
  f.revoke();
  await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
  f.complete();
  await vi.waitFor(() => expect(f.store.attempt(request.requestId)?.state).toBe('cancelled'));
  expect(readManagedClaudeProfiles(f.store.root)).toEqual([]);
  expect(f.verify).not.toHaveBeenCalled();
});

it('does not admit a second attempt, another browser owner or altered exact retry', async () => {
  const f = fixture(),
    session = auth(),
    request = input();
  await f.host.start(session, request);
  await expect(f.host.start(session, input())).rejects.toThrow();
  await expect(f.host.start(session, { ...request, label: 'Changed' })).rejects.toThrow();
  expect(() => f.host.status({ ...session, id: 'other' }, request.requestId)).toThrow();
  await expect(
    f.host.submit({ ...session, id: 'other' }, request.requestId, 'code#expected'),
  ).rejects.toThrow();
  await f.host.cancel(session, request.requestId);
  expect(f.host.status(session, request.requestId).state).toBe('cancelled');
});

it('preserves failed verification as a visible correlated failure and recovers a stopped host honestly', async () => {
  const f = fixture(),
    session = auth(),
    request = input();
  f.verify.mockRejectedValueOnce(Error('sensitive provider response'));
  await f.host.start(session, request);
  f.complete();
  await vi.waitFor(() =>
    expect(f.host.status(session, request.requestId)).toMatchObject({
      state: 'failed',
      errorCode: 'CLAUDE_LOGIN_VERIFICATION_FAILED',
      diagnosticId: expect.any(String),
    }),
  );
  expect(JSON.stringify(f.host.list(session))).not.toContain('sensitive');
  expect(readManagedClaudeProfiles(f.store.root)).toEqual([]);
  const next = input();
  await f.host.start(session, next);
  const reopened = new ClaudeAccountLogin({
    store: f.store,
    createLogin: f.createLogin,
    verify: f.verify,
    isCurrent: () => true,
    observe: () => () => undefined,
  });
  expect(reopened.status(session, next.requestId)).toMatchObject({ state: 'interrupted' });
  expect(f.createLogin).toHaveBeenCalledTimes(2);
  await f.host.cancel(session, next.requestId);
});

it('keeps a journal write failure visible after native cleanup instead of reverting to a pending login', async () => {
  const f = fixture(),
    session = auth(),
    request = input();
  await f.host.start(session, request);
  f.verify.mockRejectedValueOnce(Error('verification failed'));
  const original = f.store.update.bind(f.store);
  vi.spyOn(f.store, 'update').mockImplementation((row) => {
    if (row.state === 'failed') throw Error('disk unavailable');
    original(row);
  });
  f.complete();
  await vi.waitFor(() =>
    expect(f.host.status(session, request.requestId)).toMatchObject({
      state: 'failed',
      errorCode: 'CLAUDE_LOGIN_JOURNAL_FAILED',
      diagnosticId: expect.any(String),
    }),
  );
});

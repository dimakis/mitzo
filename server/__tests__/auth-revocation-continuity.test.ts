import { afterEach, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { createInteractiveAuth } from '../interactive-auth-core.js';
import { EventStore } from '../event-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const stores: EventStore[] = [];
const roots: string[] = [];
afterEach(() => {
  stores.forEach((s) => s.close());
  stores.length = 0;
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
  roots.length = 0;
});
const config = {
  passphrase: 'offline-safe-passphrase',
  secret: 'offline-safe-secret-at-least-32-characters',
  maxAgeHours: 1,
  cookieName: 'test_auth',
};
it('verifies logout targets without authorizing revoked sessions or depending on the revocation read', async () => {
  const auth = createInteractiveAuth(config);
  const token = (await auth.login(config.passphrase))!;
  const session = (await auth.authenticateToken(token))!;
  const read = vi.fn(() => {
    throw Error('revocation reads unavailable');
  });
  let failWrite = true;
  const persisted: string[] = [];
  auth.setRevocationStore({
    isAuthSessionRevoked: read,
    revokeAuthSession: (target) => {
      if (failWrite) throw Error('revocation writes unavailable');
      persisted.push(target.id);
    },
  });
  expect(await auth.authenticateToken(token)).toBeNull();
  const reads = read.mock.calls.length;
  const target = await auth.verifyLogoutToken(token);
  expect(target).toEqual(session);
  expect(read).toHaveBeenCalledTimes(reads);
  expect(() => auth.revokeOperatorSessions([target])).toThrow(AggregateError);
  expect(persisted).toEqual([]);
  failWrite = false;
  auth.revokeOperatorSessions([await auth.verifyLogoutToken(token)]);
  expect(persisted).toEqual([session.id]);
  expect(await auth.authenticateToken(token)).toBeNull();
});

it('rejects expired, malformed and wrongly signed logout tokens', async () => {
  const auth = createInteractiveAuth(config);
  const token = async (secret: string, expired = false) =>
    new SignJWT({ sub: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setJti('logout-target')
      .setExpirationTime(expired ? Math.floor(Date.now() / 1000) - 60 : '1h')
      .sign(new TextEncoder().encode(secret));
  for (const invalid of [
    'not-a-jwt',
    await token(config.secret, true),
    await token('a-different-test-secret-at-least-32-characters'),
  ])
    expect(await auth.verifyLogoutToken(invalid)).toBeNull();
});
it('retains logout revocation after auth and existing event store reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-auth-continuity-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const first = new EventStore(path);
  stores.push(first);
  const auth = createInteractiveAuth(config);
  auth.setRevocationStore(first);
  const token = (await auth.login(config.passphrase))!;
  const session = (await auth.authenticateToken(token))!;
  auth.revokeAuthSession(session);
  const second = new EventStore(path);
  stores.push(second);
  const reopened = createInteractiveAuth(config);
  reopened.setRevocationStore(second);
  expect(await reopened.authenticateToken(token)).toBeNull();
  expect(
    await reopened.authenticateToken((await reopened.login(config.passphrase))!),
  ).not.toBeNull();
});
it('fails closed if durable revocation cannot be checked or persisted', async () => {
  const auth = createInteractiveAuth(config);
  const token = (await auth.login(config.passphrase))!;
  const session = (await auth.authenticateToken(token))!;
  auth.setRevocationStore({
    isAuthSessionRevoked: () => {
      throw Error('read failed');
    },
    revokeAuthSession: () => {
      throw Error('write failed');
    },
  });
  expect(await auth.authenticateToken(token)).toBeNull();
  expect(() => auth.registerAuthSession(session, () => {})).toThrow();
  expect(() => auth.revokeAuthSession(session)).toThrow();
});

it('revokes every supplied login and notifies owners even when durable writes fail', async () => {
  const auth = createInteractiveAuth(config);
  const sessions = await Promise.all(
    [1, 2].map(async () => auth.authenticateToken((await auth.login(config.passphrase))!)),
  );
  const revoked: string[] = [];
  const notified: string[] = [];
  for (const session of sessions)
    auth.registerAuthSession(session!, () => revoked.push(session!.id));
  auth.setRevocationStore({
    isAuthSessionRevoked: () => false,
    revokeAuthSession: () => {
      throw Error('write failed');
    },
  });
  expect(() => auth.revokeOperatorSessions(sessions, (id) => notified.push(id))).toThrow(
    AggregateError,
  );
  expect(revoked).toEqual(sessions.map((session) => session!.id));
  expect(notified).toEqual(revoked);
  for (const session of sessions) expect(auth.isSessionRevoked(session!)).toBe(true);
});

it('notifies every retained owner when one revocation listener fails', async () => {
  const auth = createInteractiveAuth(config);
  const session = (await auth.authenticateToken((await auth.login(config.passphrase))!))!;
  auth.registerAuthSession(session, () => {
    throw Error('fixture listener failed');
  });
  let second = false;
  auth.registerAuthSession(session, () => {
    second = true;
  });
  expect(() => auth.revokeAuthSession(session)).toThrow(AggregateError);
  expect(second).toBe(true);
  expect(auth.isSessionRevoked(session)).toBe(true);
});

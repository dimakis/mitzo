import { afterEach, expect, it } from 'vitest';
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

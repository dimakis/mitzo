import { afterEach, expect, it } from 'vitest';
import { EventStore } from '../../packages/protocol/src/event-store.js';
import { createInteractiveAuth } from '../interactive-auth-core.js';
import { PrMonitorConsent } from '../pr-monitor-consent.js';
import { SessionCapabilityGrants } from '../session-capability-grants.js';
import { capabilityFixture } from './fixtures/session-capabilities.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const id = '9c6bb0d4-081f-4f55-86f8-60c703452053';
const s = () => ({
  version: 1 as const,
  id,
  revision: 1,
  operatorId: 'ordinary:user',
  conversationId: 'one',
  github: {
    connectionId: id,
    identityRevision: '1',
    repositoryId: 'repo-node',
    owner: 'owner',
    name: 'repo',
    pr: 7,
    prNodeId: 'pr-node',
  },
  execution: {
    binding: {
      version: 2 as const,
      account: { accountId: 'personal', provider: 'openai-codex' as const, profileRevision: '1' },
      harness: { implementation: 'codex' as const },
      execution: { location: 'local' as const, targetId: 'mac', targetRevision: '1' },
    },
    selectionRevision: '1',
    profileRevision: '1',
    workspaceId: 'workspace',
  },
  head: null,
  watch: null,
  autoFix: null,
  merge: null,
  lifecycle: 'paused' as const,
  lastAttemptAt: null,
  lastSuccessfulRefreshAt: null,
  nextRefreshAt: null,
  snapshotRevision: 0,
  eligibilityRevision: 0,
  eligibilityDigest: 'a'.repeat(64),
});
const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
async function fixture(path = ':memory:') {
  const store = new EventStore(path);
  stores.push(store);
  store.upsertSession({ sessionId: 'one' });
  store.prMonitor.create('create', s());
  const auth = createInteractiveAuth({
    passphrase: 'offline-test-passphrase',
    secret: 'offline-secret-longer-than-thirty-two-characters',
    maxAgeHours: 1,
    cookieName: 'offline_auth',
  });
  auth.setRevocationStore(store);
  const login = (await auth.authenticateToken((await auth.login('offline-test-passphrase'))!))!;
  let available = true;
  const ports = {
    store: store.prMonitor,
    hasPersistentRevocationAuthority: auth.hasPersistentRevocationAuthority,
    isInteractive: auth.isAuthenticatedOperatorSessionId,
    isLoginCurrent: (a: { id: string; expiresAt: number }) =>
      a.expiresAt > Date.now() && !auth.isSessionRevoked(a),
    assertConversation: () => {
      if (!available) throw Error('conversation_unavailable');
    },
    connection: () => ({
      connectionId: id,
      connectionRevision: '1',
      githubPrincipalId: 'github:123',
      repositoryId: 'repo-node',
      prNodeId: 'pr-node',
    }),
  };
  const consent = new PrMonitorConsent(ports);
  const { registry } = capabilityFixture();
  const grants = new SessionCapabilityGrants(registry, undefined, consent);
  const issue = () =>
    grants.issuePrWatch(login, {
      requestId: 'issue',
      conversationId: 'one',
      subscriptionId: id,
      expectedRevision: 1,
      expectedAuthorityRevision: 0,
      durationMinutes: 30,
      reviewedScope: ports.connection(),
    });
  return {
    store,
    auth,
    login,
    ports,
    issue,
    consent,
    setUnavailable: () => {
      available = false;
    },
  };
}
it('issues only through current interactive provenance and retains exact read-only scope', async () => {
  const f = await fixture();
  const grant = f.issue();
  expect(grant.kind).toBe('pr-watch');
  expect(grant.settingsDigest).toBeNull();
  expect(f.issue()).toEqual(grant);
  expect(() =>
    f.consent.issue(
      { id: 'agent-token', expiresAt: f.login.expiresAt },
      {
        requestId: 'bad',
        conversationId: 'one',
        subscriptionId: id,
        expectedRevision: 2,
        expectedAuthorityRevision: 1,
        durationMinutes: 1,
        reviewedScope: f.ports.connection(),
      },
    ),
  ).toThrow('interactive_authority_required');
  expect(f.store.prMonitor.read('ordinary:user', 'one', id).subscription.autoFix).toBeNull();
});
it('reconciles retained consent without live Maps but blocks durable offline logout and missing revocation owner', async () => {
  const f = await fixture();
  f.issue();
  const restored = new PrMonitorConsent({ ...f.ports, isInteractive: () => false });
  expect(() => restored.capture('one', id)()).not.toThrow();
  expect(() =>
    new PrMonitorConsent({ ...f.ports, hasPersistentRevocationAuthority: () => false }).capture(
      'one',
      id,
    ),
  ).toThrow('authority_unavailable');
  f.store.revokeAuthSession(f.login);
  expect(() => restored.capture('one', id)).toThrow('authority_unavailable');
});
it('revocation and connection/conversation changes invalidate captured before/after-read fences', async () => {
  const f = await fixture();
  const grant = f.issue();
  const captured = f.consent.capture('one', id);
  f.consent.revoke(f.login, {
    requestId: 'revoke',
    conversationId: 'one',
    subscriptionId: id,
    expectedRevision: 2,
    expectedAuthorityRevision: grant.revision,
  });
  expect(() => captured()).toThrow('authority_unavailable');
  expect(f.store.prMonitor.read('ordinary:user', 'one', id).subscription.lifecycle).toBe('paused');
  expect(() => f.consent.capture('one', id)).toThrow('authority_unavailable');
  const other = await fixture();
  other.issue();
  const current = other.consent.capture('one', id);
  other.setUnavailable();
  expect(() => current()).toThrow('conversation_unavailable');
  expect(() =>
    new PrMonitorConsent({
      ...other.ports,
      assertConversation: () => undefined,
      connection: () => ({ ...other.ports.connection(), connectionRevision: '2' }),
    }).capture('one', id),
  ).toThrow('connection_unavailable');
});
it('rejects renewal with changed reviewed scope and stale revisions without changing retained consent', async () => {
  const f = await fixture();
  const original = f.issue();
  expect(() =>
    f.consent.issue(f.login, {
      requestId: 'renew',
      conversationId: 'one',
      subscriptionId: id,
      expectedRevision: 2,
      expectedAuthorityRevision: 1,
      durationMinutes: 30,
      reviewedScope: { ...f.ports.connection(), prNodeId: 'other-pr' },
    }),
  ).toThrow('scope_changed');
  expect(f.consent.capture('one', id).authority).toEqual(original);
});
it('renewing Watch establishes a new baseline and due reconciliation without creating a model command', async () => {
  const f = await fixture();
  f.issue();
  expect(f.store.prMonitor.due(Date.now()).map((s) => s.id)).toEqual([id]);
  const v = f.store.prMonitor.read('ordinary:user', 'one', id);
  expect(v.baselinePending).toBe(true);
  f.store.prMonitor.stopConversation('one', 'deleted');
  expect(f.store.prMonitor.read('ordinary:user', 'one', id).subscription.lifecycle).toBe('removed');
  expect(() => f.consent.capture('one', id)).toThrow('authority_unavailable');
});
it('cannot renew a subscription removed by conversation deletion even with an obsolete conversation adapter', async () => {
  const f = await fixture();
  f.issue();
  f.store.prMonitor.stopConversation('one', 'deleted');
  expect(() =>
    f.consent.issue(f.login, {
      requestId: 'renew-deleted',
      conversationId: 'one',
      subscriptionId: id,
      expectedRevision: 3,
      expectedAuthorityRevision: 1,
      durationMinutes: 30,
      reviewedScope: f.ports.connection(),
    }),
  ).toThrow('subscription_unavailable');
  expect(f.store.prMonitor.read('ordinary:user', 'one', id).subscription.lifecycle).toBe('removed');
});
it('retains a fail-closed revoke intent through a failed authority write and database restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pr-revoke-'));
  const path = join(directory, 'events.db');
  const f = await fixture(path);
  const grant = f.issue();
  const captured = f.consent.capture('one', id);
  const injector = new Database(path);
  injector.exec(
    "CREATE TRIGGER fail_pr_revoke BEFORE UPDATE ON pr_monitor_authorities BEGIN SELECT RAISE(ABORT,'offline write failure'); END;",
  );
  const input = {
    requestId: 'revoke-failure',
    conversationId: 'one',
    subscriptionId: id,
    expectedRevision: 2,
    expectedAuthorityRevision: grant.revision,
  };
  try {
    expect(() => f.consent.revoke(f.login, input)).toThrow('offline write failure');
    expect(() => captured()).toThrow('authority_unavailable');
    expect(f.store.prMonitor.read('ordinary:user', 'one', id).subscription.lifecycle).toBe(
      'paused',
    );
    injector.exec('DROP TRIGGER fail_pr_revoke');
    injector.close();
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const restored = new EventStore(path);
    stores.push(restored);
    const restoredAuth = createInteractiveAuth({
      passphrase: 'offline-test-passphrase',
      secret: 'offline-secret-longer-than-thirty-two-characters',
      maxAgeHours: 1,
      cookieName: 'offline_auth',
    });
    restoredAuth.setRevocationStore(restored);
    const renewedLogin = (await restoredAuth.authenticateToken(
      (await restoredAuth.login('offline-test-passphrase'))!,
    ))!;
    const consent = new PrMonitorConsent({
      ...f.ports,
      store: restored.prMonitor,
      hasPersistentRevocationAuthority: restoredAuth.hasPersistentRevocationAuthority,
      isInteractive: restoredAuth.isAuthenticatedOperatorSessionId,
      isLoginCurrent: (a) => a.expiresAt > Date.now() && !restoredAuth.isSessionRevoked(a),
    });
    expect(() => consent.capture('one', id)).toThrow('authority_unavailable');
    expect(
      restored.prMonitor.projection('ordinary:user', 'one', id).revocationPending,
    ).toMatchObject({ requestId: input.requestId });
    expect(consent.revoke(renewedLogin, input).revokedAt).not.toBeNull();
    expect(restored.prMonitor.projection('ordinary:user', 'one', id).revocationPending).toBeNull();
    restored.close();
    stores.splice(stores.indexOf(restored), 1);
  } finally {
    if (injector.open) injector.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

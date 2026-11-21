import { randomUUID } from 'node:crypto';
import type { PrMonitorSubscription } from '../../src/pr-monitor.js';
import type { EventStore } from '../../src/event-store.js';

export const subscription = (id = randomUUID()): PrMonitorSubscription => ({
  version: 1,
  id,
  revision: 1,
  operatorId: 'ordinary:user',
  conversationId: 'chat',
  github: {
    connectionId: id,
    identityRevision: '1',
    repositoryId: 'repo',
    owner: 'owner',
    name: 'repo',
    pr: 1,
    prNodeId: id,
  },
  execution: {
    binding: {
      version: 2,
      account: { accountId: 'personal', provider: 'openai-codex', profileRevision: '1' },
      harness: { implementation: 'codex' },
      execution: { location: 'local', targetId: 'mac', targetRevision: '1' },
    },
    selectionRevision: '1',
    profileRevision: '1',
    workspaceId: 'workspace',
  },
  head: null,
  watch: null,
  autoFix: null,
  merge: null,
  lifecycle: 'paused',
  lastAttemptAt: null,
  lastSuccessfulRefreshAt: null,
  nextRefreshAt: null,
  snapshotRevision: 0,
  eligibilityRevision: 0,
  eligibilityDigest: '0'.repeat(64),
});
export const snapshot = {
  title: 'PR',
  state: 'open' as const,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  complete: true,
  observedAt: 1000,
  ci: 'failed' as const,
  review: 'none' as const,
};
export const finding = {
  kind: 'ci_failure' as const,
  sourceIds: ['job:1:failed'],
  summary: 'CI failed',
  references: [
    { kind: 'job' as const, id: '1', url: 'https://github.com/owner/repo/actions/runs/1/job/1' },
  ],
  truncated: false,
};
export function watch(store: EventStore['prMonitor'], s: PrMonitorSubscription, now = 1000) {
  return store.mutateAuthority({
    requestId: randomUUID(),
    fingerprint: randomUUID(),
    operatorId: s.operatorId,
    conversationId: s.conversationId,
    subscriptionId: s.id,
    expectedRevision: s.revision,
    expectedAuthorityRevision: s.watch?.revision ?? 0,
    kind: 'pr-watch',
    assertCurrent: () => undefined,
    change: (previous) => ({
      version: 1,
      id: previous?.id ?? randomUUID(),
      revision: (previous?.revision ?? 0) + 1,
      kind: 'pr-watch',
      conversationId: s.conversationId,
      subscriptionId: s.id,
      expiresAt: now + 3600000,
      revokedAt: null,
      scope: {
        connectionId: s.github.connectionId,
        connectionRevision: s.github.identityRevision,
        githubPrincipalId: 'github:123',
        repositoryId: s.github.repositoryId,
        prNodeId: s.github.prNodeId,
      },
      settingsDigest: null,
      maxAttemptsPerBatch: null,
      maxCommandsPerHour: null,
      issuer: {
        realm: 'ordinary',
        subject: 'user',
        authSessionId: 'offline-login',
        authExpiresAt: now + 3600000,
      },
    }),
  });
}

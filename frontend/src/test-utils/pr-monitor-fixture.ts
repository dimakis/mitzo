import type { PrMonitorAuthority, PrMonitorProjection } from '@mitzo/protocol';

export function monitorAuthorityFixture(
  p: PrMonitorProjection,
  revokedAt: number | null = null,
): PrMonitorAuthority {
  const s = p.subscription;
  return {
    version: 1,
    id: s.watch?.id ?? s.id,
    revision: s.watch?.revision ?? 1,
    kind: 'pr-watch',
    subscriptionId: s.id,
    conversationId: s.conversationId,
    issuer: {
      realm: 'ordinary',
      subject: 'user',
      authSessionId: 'offline-login',
      authExpiresAt: Date.now() + 3600000,
    },
    scope: {
      connectionId: s.github.connectionId,
      connectionRevision: s.github.identityRevision,
      githubPrincipalId: s.github.principalId!,
      repositoryId: s.github.repositoryId,
      prNodeId: s.github.prNodeId,
    },
    settingsDigest: null,
    maxAttemptsPerBatch: null,
    maxCommandsPerHour: null,
    expiresAt: s.watch?.expiresAt ?? Date.now() + 1800000,
    revokedAt,
  };
}

/** Offline UI input; adapter qualification uses the actual controller/store. */
export function monitorFixture(conversationId = 'chat'): PrMonitorProjection {
  const head = 'a'.repeat(40);
  const id = '9c6bb0d4-081f-4f55-86f8-60c703452053';
  return {
    version: 1,
    hiddenEvents: 0,
    compactedEvents: 0,
    revocationPending: null,
    baselinePending: false,
    failureCount: 0,
    refreshState: 'current',
    diagnostic: null,
    counters: { observations: 1, distinctEvents: 1, modelTurns: 0 },
    outbox: null,
    subscription: {
      version: 1,
      id,
      revision: 1,
      operatorId: 'ordinary:user',
      conversationId,
      github: {
        connectionId: id,
        identityRevision: '1',
        principalId: '42',
        repositoryId: 'repo-node',
        owner: 'owner',
        name: 'repo',
        pr: 7,
        prNodeId: 'pr-node',
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
      head: { sha: head, baseSha: 'b'.repeat(40), generation: 1 },
      watch: null,
      autoFix: null,
      merge: null,
      lifecycle: 'paused',
      lastAttemptAt: Date.now(),
      lastSuccessfulRefreshAt: Date.now(),
      nextRefreshAt: null,
      snapshotRevision: 1,
      eligibilityRevision: 1,
      eligibilityDigest: 'd'.repeat(64),
    },
    snapshot: {
      title: 'A retained pull request',
      state: 'open',
      headSha: head,
      baseSha: 'b'.repeat(40),
      complete: true,
      observedAt: Date.now(),
      ci: 'failed',
      review: 'actionable',
    },
    events: [
      {
        version: 1,
        id: 'event-1',
        subscriptionId: id,
        headSha: head,
        generation: 1,
        evidenceDigest: 'e'.repeat(64),
        observedAt: Date.now(),
        disposition: 'status_only',
        kind: 'ci_failure',
        sourceIds: ['job-1'],
        summary: 'Build failed',
        references: [
          { kind: 'job', id: 'job-1', url: 'https://github.com/owner/repo/actions/runs/1/job/1' },
        ],
        truncated: false,
      },
    ],
  };
}

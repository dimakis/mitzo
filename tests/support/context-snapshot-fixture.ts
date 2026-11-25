import type { ContextSnapshotResponse } from '@mitzo/protocol';

/** Real v1 transport shape; no provider, runtime or token-count calls. */
export function contextSnapshotFixture(sessionId = 'one'): ContextSnapshotResponse {
  return {
    version: 1,
    sessionId,
    revision: 2,
    status: 'partial',
    snapshot: {
      version: 1,
      identity: { sessionId, scope: 'parent', ownerGeneration: 'owner-1', queryId: 'query-1' },
      binding: {
        engine: 'claude',
        placement: 'local',
        model: 'fixture-model',
        accountRef: 'opaque-account',
        runtimeBindingRevision: 'binding-1',
      },
      observedAt: 1795290000000,
      freshness: { state: 'current' },
      measurement: {
        basis: 'current-context-estimate',
        method: 'claude-summary',
        assurance: 'estimated',
      },
      usedTokens: 12001,
      categories: [
        {
          key: 'history',
          label: 'Conversation',
          kind: 'used',
          tokens: 12000,
          assurance: 'estimated',
        },
        {
          key: 'deferred',
          label: 'Deferred tools',
          kind: 'deferred',
          tokens: 900,
          assurance: 'estimated',
        },
        { key: 'reserve', label: 'Reserve', kind: 'buffer', tokens: 2000, assurance: 'estimated' },
        { key: 'free', label: 'Free', kind: 'free', tokens: 85999, assurance: 'estimated' },
      ],
      contributions: [
        {
          id: 'source-1',
          categoryKey: 'history',
          sourceRef: 'opaque:1',
          tokens: 5000,
          relation: 'overlap',
          assurance: 'estimated',
        },
      ],
      capacity: {
        compactionWindowTokens: 100000,
        usableWindowTokens: 98000,
        bufferTokens: 2000,
        freeTokens: 85999,
        kind: 'unknown',
        source: 'native control',
        stale: false,
      },
      reconciliation: { status: 'partial', residualTokens: 1 },
    },
  };
}

import type { RuntimeReadiness } from '@mitzo/protocol';

type ObservedReadiness = RuntimeReadiness & {
  session: Extract<RuntimeReadiness['session'], { state: 'observed' }>;
  execution: Extract<RuntimeReadiness['execution'], { state: 'configured' }>;
  capabilities: Extract<RuntimeReadiness['capabilities'], { evidence: unknown }>;
};

/** Pure synthetic evidence shared by protocol and mounted-consumer regressions. */
export function runtimeReadinessFixture(sessionId = 'one', now = Date.now()): ObservedReadiness {
  const account = {
    accountId: 'a',
    provider: 'anthropic-claude' as const,
    profileRevision: 'profile-1',
  };
  const binding = {
    version: 2 as const,
    account,
    harness: { implementation: 'claude-sdk' as const },
    execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'target-1' },
  };
  return {
    version: 1,
    sessionId,
    observedAt: now,
    revision: 'a'.repeat(64),
    session: {
      state: 'observed',
      account: { ...account, accountLabel: 'Account' },
      model: 'actual',
      mode: 'agent',
      grants: [],
      skillCeiling: null,
    },
    execution: { state: 'configured', binding: structuredClone(binding) },
    capabilities: {
      state: 'observed',
      evidence: {
        scope: {
          sessionId,
          accountId: 'a',
          profileRevision: 'profile-1',
          model: 'actual',
          binding: structuredClone(binding),
          ownerRevision: 'owner-1',
        },
        observedAt: now - 1000,
        expiresAt: now + 60000,
        process: 'ready',
        roots: { task: '/synthetic-task', knowledge: null },
        tools: [],
        executables: [],
        services: [
          {
            id: 'Documents',
            revision: 'service-1',
            configured: 'yes',
            approval: 'unknown',
            attachment: 'unknown',
            operations: [
              {
                operation: 'list',
                policy: 'allowed',
                verification: { state: 'succeeded', observedAt: now - 500, expiresAt: now + 60000 },
              },
            ],
          },
        ],
      },
    },
  };
}

export const readinessScopeMutations: Array<[string, (value: ObservedReadiness) => void]> = [
  [
    'session',
    (v) => {
      v.capabilities.evidence.scope.sessionId = 'other';
    },
  ],
  [
    'account',
    (v) => {
      v.capabilities.evidence.scope.accountId = 'other';
    },
  ],
  [
    'profile',
    (v) => {
      v.capabilities.evidence.scope.profileRevision = 'other';
    },
  ],
  [
    'model',
    (v) => {
      v.capabilities.evidence.scope.model = 'other';
    },
  ],
  [
    'binding account',
    (v) => {
      v.capabilities.evidence.scope.binding.account.accountId = 'other';
    },
  ],
  [
    'binding provider',
    (v) => {
      v.capabilities.evidence.scope.binding.account.provider = 'anthropic-vertex';
    },
  ],
  [
    'target revision',
    (v) => {
      const b = v.capabilities.evidence.scope.binding;
      if (b.version === 2) b.execution.targetRevision = 'other';
    },
  ],
  [
    'target identity',
    (v) => {
      const b = v.capabilities.evidence.scope.binding;
      if (b.version === 2) b.execution.targetId = 'other';
    },
  ],
  [
    'binding version',
    (v) => {
      const b = v.capabilities.evidence.scope.binding;
      v.capabilities.evidence.scope.binding = {
        version: 1,
        account: b.account,
        harness: b.harness,
        execution: { location: b.execution.location },
      };
    },
  ],
  [
    'configured account',
    (v) => {
      v.execution.binding.account.accountId = 'other';
    },
  ],
  [
    'future observation',
    (v) => {
      v.capabilities.evidence.observedAt = v.observedAt + 1;
    },
  ],
  [
    'future verification',
    (v) => {
      const result = v.capabilities.evidence.services[0].operations[0].verification;
      if (result.state !== 'unknown') result.observedAt = v.observedAt + 1;
    },
  ],
];

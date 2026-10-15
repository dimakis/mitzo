import { describe, expect, it } from 'vitest';
import type { ManagedSession } from '@mitzo/harness';
import { RuntimeReadinessSchema, RuntimeCapabilityObservationSchema } from '@mitzo/protocol';
import { projectRuntimeReadiness } from '../runtime-readiness.js';

const binding = {
  version: 2 as const,
  account: { accountId: 'work', provider: 'openai' as const, profileRevision: 'profile-1' },
  harness: { implementation: 'codex' as const },
  execution: { location: 'openshell' as const, targetId: 'shell', targetRevision: 'target-1' },
};
const session = () =>
  ({
    sessionId: 'chat',
    accountBinding: { ...binding.account, accountLabel: 'Work API', model: 'old-model' },
    model: 'selected-model',
    cwd: '/sandbox/task',
    mode: 'auto',
    sessionAllowList: new Set(['Read', 'Bash']),
    activeSkillPolicy: new Set(['Read']),
    pendingPermissionModes: new Map([[Symbol(), 'ask']]),
    abortController: new AbortController(),
    ordinaryRuntimeOwner: { location: 'openshell' },
  }) as ManagedSession;

const observation = () => ({
  scope: {
    sessionId: 'chat',
    accountId: 'work',
    profileRevision: 'profile-1',
    model: 'selected-model',
    binding,
    ownerRevision: 'process-1',
  },
  observedAt: 100,
  expiresAt: 200,
  process: 'ready' as const,
  roots: { task: '/sandbox/task', knowledge: '/sandbox/knowledge' },
  tools: [{ name: 'ConnectionRequest', state: 'available' as const }],
  executables: [
    { command: 'gws', state: 'available' as const },
    { command: 'jq', state: 'missing' as const },
  ],
  services: [
    {
      id: 'google',
      revision: 'connection-1',
      configured: 'yes' as const,
      approval: 'granted' as const,
      attachment: 'attached' as const,
      operations: [
        {
          operation: 'docs.text.read',
          policy: 'allowed' as const,
          verification: { state: 'unknown' as const },
        },
      ],
    },
  ],
});

describe('shared runtime readiness evidence', () => {
  it.each(['openai', 'openai-codex', 'anthropic-vertex', 'google-vertex'])(
    'observes session facts for %s without inferring executable or service readiness',
    (provider) => {
      const owner = session();
      owner.accountBinding!.provider = provider;
      const value = projectRuntimeReadiness({ sessionId: 'chat', session: owner }, 150);
      expect(RuntimeReadinessSchema.safeParse(value).success).toBe(true);
      expect(value.session).toMatchObject({
        state: 'observed',
        account: { provider },
        model: 'selected-model',
        mode: 'ask',
        grants: ['Bash', 'Read'],
      });
      expect(value.execution).toEqual({ state: 'unknown', reason: 'not_observed' });
      expect(value.capabilities).toEqual({ state: 'unknown', reason: 'not_observed' });
    },
  );

  it('retains a configured runtime as configuration, never process readiness', () => {
    const value = projectRuntimeReadiness({ sessionId: 'chat', session: session(), binding }, 150);
    expect(value.execution).toEqual({ state: 'configured', binding });
    expect(value.capabilities.state).toBe('unknown');
  });

  it('keeps approval, attachment, policy and operation verification independent', () => {
    const value = projectRuntimeReadiness(
      {
        sessionId: 'chat',
        session: session(),
        binding,
        ownerRevision: 'process-1',
        observation: observation(),
      },
      150,
    );
    expect(value.capabilities).toMatchObject({
      state: 'observed',
      evidence: {
        process: 'ready',
        services: [
          {
            approval: 'granted',
            attachment: 'attached',
            operations: [{ verification: { state: 'unknown' } }],
          },
        ],
      },
    });
    expect(JSON.stringify(value)).not.toContain('fully working');
  });

  it.each([
    [
      'session',
      (e: ReturnType<typeof observation>) => {
        e.scope.sessionId = 'other';
      },
    ],
    [
      'account',
      (e: ReturnType<typeof observation>) => {
        e.scope.accountId = 'other';
      },
    ],
    [
      'profile revision',
      (e: ReturnType<typeof observation>) => {
        e.scope.profileRevision = 'new';
      },
    ],
    [
      'model',
      (e: ReturnType<typeof observation>) => {
        e.scope.model = 'other';
      },
    ],
    [
      'target revision',
      (e: ReturnType<typeof observation>) => {
        e.scope.binding = {
          ...binding,
          execution: { ...binding.execution, targetRevision: 'old' },
        };
      },
    ],
    [
      'process generation',
      (e: ReturnType<typeof observation>) => {
        e.scope.ownerRevision = 'old-process';
      },
    ],
    [
      'task root',
      (e: ReturnType<typeof observation>) => {
        e.roots.task = '/other/task';
      },
    ],
  ])('rejects evidence from a different %s', (_name, change) => {
    const evidence = observation();
    change(evidence);
    expect(
      projectRuntimeReadiness(
        {
          sessionId: 'chat',
          session: session(),
          binding,
          ownerRevision: 'process-1',
          observation: evidence,
        },
        150,
      ).capabilities,
    ).toEqual({ state: 'unknown', reason: 'scope_mismatch' });
  });

  it('requires a current runtime owner revision before accepting capability evidence', () => {
    expect(
      projectRuntimeReadiness(
        { sessionId: 'chat', session: session(), binding, observation: observation() },
        150,
      ).capabilities,
    ).toEqual({ state: 'unknown', reason: 'owner_unavailable' });
  });

  it('marks expired evidence stale and never retimestamps the original measurement', () => {
    const value = projectRuntimeReadiness(
      {
        sessionId: 'chat',
        session: session(),
        binding,
        ownerRevision: 'process-1',
        observation: observation(),
      },
      200,
    );
    expect(value.capabilities).toMatchObject({
      state: 'stale',
      evidence: { observedAt: 100, expiresAt: 200 },
    });
  });

  it('expires an operation verification independently of provider attachment', () => {
    const evidence = {
      ...observation(),
      services: [
        {
          ...observation().services[0],
          operations: [
            {
              operation: 'docs.text.read',
              policy: 'allowed',
              verification: { state: 'succeeded', observedAt: 90, expiresAt: 120 },
            },
          ],
        },
      ],
    };
    expect(
      projectRuntimeReadiness(
        {
          sessionId: 'chat',
          session: session(),
          binding,
          ownerRevision: 'process-1',
          observation: evidence,
        },
        150,
      ).capabilities,
    ).toMatchObject({
      state: 'observed',
      evidence: {
        services: [
          {
            attachment: 'attached',
            operations: [{ verification: { state: 'stale', observedAt: 90 } }],
          },
        ],
      },
    });
  });

  it('fails closed for future, malformed, duplicate or secret-bearing observations', () => {
    const valid = observation();
    for (const evidence of [
      { ...valid, observedAt: 151 },
      { ...valid, expiresAt: 100 },
      { ...valid, credential: 'DO-NOT-EXPOSE' },
      { ...valid, tools: [...valid.tools, valid.tools[0]] },
      { ...valid, services: [{ ...valid.services[0], token: 'DO-NOT-EXPOSE' }] },
    ]) {
      const value = projectRuntimeReadiness(
        {
          sessionId: 'chat',
          session: session(),
          binding,
          ownerRevision: 'process-1',
          observation: evidence,
        },
        150,
      );
      expect(value.capabilities).toEqual({ state: 'unknown', reason: 'invalid_evidence' });
      expect(JSON.stringify(value)).not.toContain('DO-NOT-EXPOSE');
    }
    expect(RuntimeCapabilityObservationSchema.safeParse({ ...valid, expiresAt: 100 }).success).toBe(
      false,
    );
  });

  it('does not reuse a mismatched configured account or owner location', () => {
    for (const selected of [
      { ...binding, account: { ...binding.account, profileRevision: 'other' } },
      { ...binding, execution: { ...binding.execution, location: 'local' } },
    ]) {
      const value = projectRuntimeReadiness(
        { sessionId: 'chat', session: session(), binding: selected },
        150,
      );
      expect(value.execution).toEqual({ state: 'unknown', reason: 'scope_mismatch' });
    }
  });

  it('returns no retained identity or capability claims for unavailable sessions', () => {
    const aborted = session();
    aborted.abortController.abort();
    for (const owner of [
      undefined,
      aborted,
      { ...session(), sessionId: 'other' },
      { ...session(), accountBinding: undefined },
    ]) {
      const value = projectRuntimeReadiness(
        {
          sessionId: 'chat',
          session: owner,
          binding,
          ownerRevision: 'process-1',
          observation: observation(),
        },
        150,
      );
      expect(value.session.state).toBe('unknown');
      expect(value.execution.state).toBe('unknown');
      expect(value.capabilities.state).toBe('unknown');
      expect(JSON.stringify(value)).not.toContain('selected-model');
    }
  });

  it('revisions change on permission and freshness changes, not on reads or collection order', () => {
    const input = {
      sessionId: 'chat',
      session: session(),
      binding,
      ownerRevision: 'process-1',
      observation: observation(),
    };
    const original = projectRuntimeReadiness(input, 150);
    expect(projectRuntimeReadiness(input, 160).revision).toBe(original.revision);
    input.session.sessionAllowList = new Set(['Bash', 'Read']);
    input.observation.executables.reverse();
    expect(projectRuntimeReadiness(input, 160).revision).toBe(original.revision);
    expect(projectRuntimeReadiness(input, 200).revision).not.toBe(original.revision);
    input.session.sessionAllowList.add('Edit');
    expect(projectRuntimeReadiness(input, 160).revision).not.toBe(original.revision);
  });
});

import {
  createSymposiumApplicationDispatchPolicy,
  selectSymposiumApplicationClaim,
} from '../symposium-application-dispatch.js';
import { SymposiumReviewStore, type ApplicationAttempt } from '../symposium-review-workflows.js';
import { SymposiumNativeObservations } from '../symposium-native-observations.js';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { SymposiumWorkspaceLifecycle } from '../symposium-workspace-lifecycle.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SymposiumSeatSandboxRecord } from '@mitzo/protocol/event-store';
import {
  AccountBindingSchema,
  type SeatConfig,
  type SymposiumConfig,
  type SymposiumMembershipRecord,
  type SymposiumAdmissionRecord,
} from '@mitzo/protocol';
import { AccountProfiles } from '../account-profiles.js';
import { SqliteArtifactLeaseHost } from '../symposium-artifact-host.js';
import {
  acquireSymposiumArtifactLease,
  type ArtifactAccess,
  type ArtifactLeaseRequest,
} from '../symposium-artifact-lease.js';
import {
  sandboxNameForConversation,
  type BoundOpenShellRuntimeConfig,
} from '../openshell-runtime.js';
import {
  admitSymposiumSeatDispatch,
  symposiumSeatRuntimeId,
  type SymposiumDispatchFacts,
} from '../symposium-seat-runtime.js';
import type { SymposiumSeatExecution } from '../symposium-orchestrator.js';
import { SymposiumAttemptRegistry } from '../symposium-attempt-registry.js';
import { initializeSymposiumNativeHost } from '../symposium-native-host.js';
import { SymposiumOpenShellSeatExecutor } from '../symposium-openshell-seat-executor.js';
import {
  createOpenAiCodexSeat,
  assertCodexControllerCommand,
  SYMPOSIUM_CODEX_CONTROLLER_COMMAND,
} from '../symposium-codex-native.js';
import {
  snapshotSymposiumProviderUnion,
  snapshotSymposiumSeatProvider,
  SymposiumSharedSandboxOwner,
  SymposiumPerSeatSandboxOwner,
  createOpenShellProviderIdentityResolver,
  createSymposiumSessionRuntime,
} from '../symposium-session-runtime.js';

const profiles = new AccountProfiles([
  {
    id: 'work-api',
    label: 'Work OpenAI',
    provider: 'openai',
    credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
    sandboxProvider: 'openai-work',
    sandboxProviderId: 'openai-object',
    models: [{ id: 'gpt-test', label: 'Test' }],
  },
  {
    id: 'work-vertex',
    label: 'Work Claude',
    provider: 'anthropic-vertex',
    projectId: 'work-project',
    region: 'us-east5',
    credentialRef: '/host/adc.json',
    sandboxProvider: 'vertex-work',
    sandboxProviderId: 'vertex-object',
    models: [{ id: 'claude-test', label: 'Test' }],
  },
]);
const hostGrants = { verifySeat: () => undefined };
const seat = {
  id: 'reviewer',
  name: 'Reviewer',
  role: 'reviewer',
  model: 'gpt-test',
  systemPrompt: 'Review only.',
  color: '#223344',
  accountBinding: AccountBindingSchema.parse(profiles.resolve('work-api', 'gpt-test')),
  profileBinding: { profileId: 'reviewer', profileRevision: 'p1' },
  contextGrant: {
    grantId: 'context',
    revision: 1,
    classification: 'work' as const,
    sourceRefs: [],
  },
  authorityGrant: {
    grantId: 'authority',
    revision: 1,
    filesystem: 'read' as const,
    tools: 'read' as const,
    network: 'restricted' as const,
  },
  isolationRequest: {
    trustDomainId: 'shared',
    revision: 1,
    placement: 'reuse-compatible' as const,
  },
} satisfies SeatConfig;
const config: SymposiumConfig = {
  version: 2,
  revision: 4,
  state: 'active',
  anchorSeatId: 'reviewer',
  activeSeatCap: 3,
  seats: [seat],
  turnRules: { mode: 'directed', maxTurns: 10 },
  interceptMode: 'manual',
};
const membership = {
  sessionId: 'symposium',
  seatId: 'reviewer',
  generation: 2,
  state: 'active' as const,
  action: 'restore' as const,
  configRevision: 4,
  bindingKey: 'key',
  actor: 'director',
  reason: 'approved',
  idempotencyKey: 'restore-2',
  occurredAt: 1,
  reconciliation: 'confirmed' as const,
  replacesSeatId: null,
  replacedBySeatId: null,
};
const admission: SymposiumAdmissionRecord = {
  admissionId: 'a',
  sessionId: 'symposium',
  seatId: 'reviewer',
  membershipGeneration: 2,
  decision: 'admitted',
  reason: null,
  idempotencyKey: 'admit-2',
  configRevision: 4,
  provider: 'openai',
  accountId: 'work-api',
  model: 'gpt-test',
  accountProfileRevision: seat.accountBinding.profileRevision,
  isolationDomainId: 'shared',
  isolationDomainRevision: 1,
  decidedAt: 1,
};
function fixture() {
  let currentMembership: SymposiumMembershipRecord = { ...membership };
  let currentAdmission = { ...admission };
  let currentConfig = config;
  const delivery = {
    sessionId: 'symposium',
    status: 'delivering',
    deliveredContent: 'Only this approved excerpt.',
    recipients: [
      {
        seatId: 'reviewer',
        status: 'executing',
        idempotencyKey: 'attempt-1',
        membershipGeneration: 2,
      },
    ],
  };
  const facts: SymposiumDispatchFacts = {
    assertSymposiumArtifactWorkAllowed: () => {},
    getActiveSymposiumConfig: () => currentConfig,
    getLatestSymposiumMembership: () => currentMembership,
    getLatestSymposiumAdmission: () => currentAdmission,
    getSymposiumDelivery: () => delivery,
  };
  const input: SymposiumSeatExecution = {
    sessionId: 'symposium',
    deliveryId: 'delivery-1',
    seat,
    content: 'Only this approved excerpt.',
    idempotencyKey: 'attempt-1',
    claimToken: 'claim-1',
    provenance: {
      version: 2,
      seatId: 'reviewer',
      configRevision: 4,
      accountProfileRevision: seat.accountBinding.profileRevision,
      seatProfileRevision: 'p1',
      contextGrantRevision: 1,
      authorityGrantRevision: 1,
      isolationDomainId: 'shared',
      isolationDomainRevision: 1,
      membershipGeneration: 2,
      capturedAt: 1,
      seatLabel: 'Reviewer',
      seatRole: 'reviewer',
      accountBinding: seat.accountBinding,
      reasoningEffort: null,
      profileBinding: seat.profileBinding,
      contextGrant: { grantId: 'context', revision: 1 },
      authorityGrant: { grantId: 'authority', revision: 1 },
    },
    signal: new AbortController().signal,
  };
  return {
    facts,
    input,
    setMembership: (next: SymposiumMembershipRecord) => {
      currentMembership = next;
    },
    setAdmission: (next: SymposiumAdmissionRecord) => {
      currentAdmission = next;
    },
    setConfig: (next: SymposiumConfig) => {
      currentConfig = next;
    },
  };
}

function applicationFixture(work: ReturnType<typeof fixture>) {
  const store = new SymposiumReviewStore(':memory:');
  const hash = 'a'.repeat(64);
  const selected = {
    seatId: seat.id,
    role: 'reviewer',
    selectionId: 'selection',
    policyRevision: '1',
    profileId: 'reviewer',
    profileRevision: 1,
    accountId: seat.accountBinding.accountId,
    model: seat.accountBinding.model,
  };
  store.create({
    workflowId: 'policy',
    owner: 'user',
    sessionId: work.input.sessionId,
    implementation: {
      version: 1,
      resultId: 'result',
      attemptId: 'writer',
      inputRevision: 'base',
      inputHash: hash,
      artifactRevision: 'commit',
      artifactHash: hash,
      summary: 'fixture completion',
      evidenceRefs: ['fixture'],
      completedAt: 1,
    },
    implementer: { ...selected, seatId: 'writer', role: 'coder', selectionId: 'writer-selection' },
    reviewer: selected,
    acceptanceCriteria: ['criterion'],
    limits: {
      version: 1,
      mode: 'application',
      maxHostTurns: 2,
      maxReviewCycles: 1,
      deadlineAt: Date.now() + 60000,
      noProgressLimit: 1,
    },
  });
  const request: ApplicationAttempt = {
    workflowId: 'policy',
    attemptId: 'review',
    policyReservationId: 'reservation',
    kind: 'review',
    actorSeatId: seat.id,
    artifactRevision: 'commit',
    artifactHash: hash,
    binding: {
      claimToken: work.input.claimToken,
      deliveryId: work.input.deliveryId,
      contentHash: createHash('sha256').update(work.input.content).digest('hex'),
      membershipGeneration: 2,
      configRevision: 4,
      accountId: seat.accountBinding.accountId,
      model: seat.accountBinding.model,
      profileId: 'reviewer',
      profileRevision: 'p1',
      accountProfileRevision: seat.accountBinding.profileRevision,
      authorityGrant: { grantId: 'authority', revision: 1 },
      contextGrant: { grantId: 'context', revision: 1 },
    },
  };
  const db = new Database(':memory:');
  const observations = new SymposiumNativeObservations(db, () => undefined);
  const assertArtifactCurrent = vi.fn();
  const policy = createSymposiumApplicationDispatchPolicy({
    store,
    observations,
    assertArtifactCurrent,
  });
  return {
    store,
    request,
    observations,
    policy,
    assertArtifactCurrent,
    close: () => {
      store.close();
      db.close();
    },
  };
}
it('binds successor provenance into runtime identity and the final artifact fence', () => {
  const work = fixture();
  const artifact = {
    version: 1 as const,
    transitionId: 'transition',
    artifactGenerationId: 'child',
    pointerRevision: 1,
    bindingDigest: 'a'.repeat(64),
  };
  const child = {
    ...work.input,
    provenance: { ...work.input.provenance, version: 3 as const, artifact },
  } as SymposiumSeatExecution;
  const fence = vi.fn();
  const facts = {
    ...work.facts,
    assertSymposiumArtifactWorkAllowed: fence,
    getSymposiumArtifactReference: () => artifact,
  };
  expect(admitSymposiumSeatDispatch(facts, profiles, child, hostGrants).kind).toBe('openai-api');
  expect(fence).toHaveBeenCalledWith(child.sessionId, artifact);
  expect(() =>
    admitSymposiumSeatDispatch(
      { ...facts, getSymposiumArtifactReference: () => null },
      profiles,
      child,
      hostGrants,
    ),
  ).toThrow(/artifact reference/i);
  expect(symposiumSeatRuntimeId(child)).not.toBe(symposiumSeatRuntimeId(work.input));
  const other = {
    ...child,
    provenance: {
      ...child.provenance,
      artifact: { ...artifact, artifactGenerationId: 'different' },
    },
  } as SymposiumSeatExecution;
  expect(symposiumSeatRuntimeId(other)).not.toBe(symposiumSeatRuntimeId(child));
});
it('requires the physical generation owner before setting up successor native work', async () => {
  const work = fixture();
  const artifact = {
    version: 1 as const,
    transitionId: 'transition',
    artifactGenerationId: 'child',
    pointerRevision: 1,
    bindingDigest: 'a'.repeat(64),
  };
  const input = {
    ...work.input,
    provenance: { ...work.input.provenance, version: 3 as const, artifact },
  } as SymposiumSeatExecution;
  const ensure = vi.fn();
  const executor = new SymposiumOpenShellSeatExecutor({
    facts: work.facts,
    profiles,
    hostGrants,
    owner: { ensure, readOnlyEnforced: { openaiApi: true, claudeVertex: false } },
    recordAccepted: () => true,
    openNative: vi.fn(),
  });
  await expect(executor.execute(input)).rejects.toThrow(/artifact admission owner/i);
  expect(ensure).not.toHaveBeenCalled();
});
it('retains the same artifact reference in native preparation before and during execution', async () => {
  const work = fixture();
  const artifact = {
    version: 1 as const,
    transitionId: 'transition',
    artifactGenerationId: 'child',
    pointerRevision: 1,
    bindingDigest: 'a'.repeat(64),
  };
  const input = {
    ...work.input,
    provenance: { ...work.input.provenance, version: 3 as const, artifact },
  } as SymposiumSeatExecution;
  const prepare = vi.fn();
  const executor = new SymposiumOpenShellSeatExecutor({
    facts: { ...work.facts, getSymposiumArtifactReference: () => artifact },
    profiles,
    hostGrants,
    attemptRegistry: { prepare } as never,
    assertArtifactAdmissionCurrent: () => undefined,
    owner: {
      ensure: vi.fn().mockRejectedValue(Error('stop after prepare')),
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
    },
    recordAccepted: () => true,
    openNative: vi.fn(),
  });
  executor.prepare({ sessionId: input.sessionId, claimToken: input.claimToken, artifact });
  await expect(executor.execute(input)).rejects.toThrow(/stop after prepare/);
  expect(prepare).toHaveBeenCalledTimes(2);
  for (const call of prepare.mock.calls)
    expect(call[0]).toEqual({ sessionId: input.sessionId, claimToken: input.claimToken, artifact });
});
it('selects only the reserved recipient claim and fences ordinary work in an application session', () => {
  const work = fixture();
  const f = applicationFixture(work);
  const input = {
    sessionId: work.input.sessionId,
    deliveryId: work.input.deliveryId,
    seatId: seat.id,
  };
  try {
    expect(() => selectSymposiumApplicationClaim(f.store, input)).toThrow(/reservation/);
    expect(
      selectSymposiumApplicationClaim(f.store, { ...input, sessionId: 'ordinary' }),
    ).toBeNull();
    f.store.reserveApplicationAttempt(f.request);
    expect(selectSymposiumApplicationClaim(f.store, input)).toBe(work.input.claimToken);
    expect(() => selectSymposiumApplicationClaim(f.store, { ...input, seatId: 'other' })).toThrow(
      /reservation/,
    );
    f.policy.consume(work.input);
    expect(() => selectSymposiumApplicationClaim(f.store, input)).toThrow(/dispatched/);
  } finally {
    f.close();
  }
});
it('binds the persisted application reservation to every actual native identity field', () => {
  const work = fixture();
  const f = applicationFixture(work);
  try {
    expect(() => f.policy.assertCurrent(work.input)).toThrow(/reservation/i);
    f.store.reserveApplicationAttempt(f.request);
    expect(() => f.policy.assertCurrent(work.input)).not.toThrow();
    for (const changed of [
      { ...work.input, deliveryId: 'other' },
      { ...work.input, content: 'Edited after reservation' },
      { ...work.input, sessionId: 'other' },
      { ...work.input, claimToken: 'other' },
      { ...work.input, provenance: { ...work.input.provenance, membershipGeneration: 3 } },
      { ...work.input, seat: { ...seat, authorityGrant: { ...seat.authorityGrant, revision: 2 } } },
    ])
      expect(() => f.policy.assertCurrent(changed)).toThrow();
    f.policy.consume(work.input);
    expect(() => f.policy.consume(work.input)).toThrow(/already_dispatched/);
    expect(f.store.get('policy')?.hostTurns).toBe(1);
  } finally {
    f.close();
  }
});
it('requires exact native completion independently of unknown usage and stop state', () => {
  const work = fixture();
  const f = applicationFixture(work);
  try {
    f.store.reserveApplicationAttempt(f.request);
    f.policy.consume(work.input);
    f.observations.accept({
      claimToken: work.input.claimToken,
      sessionId: work.input.sessionId,
      seatId: seat.id,
      membershipGeneration: 2,
      accountBinding: seat.accountBinding,
      provenance: work.input.provenance,
      providerThreadId: 'thread',
      providerTurnId: 'turn',
    });
    f.policy.accepted(work.input, 'thread', 'turn');
    expect(() => f.policy.completed(work.input)).toThrow(/terminal/i);
    f.store.stopApplication('policy', 'user', 'user_stop');
    f.observations.terminal({
      claimToken: work.input.claimToken,
      providerThreadId: 'thread',
      providerTurnId: 'turn',
      status: 'completed',
    });
    expect(() => f.policy.completed(work.input)).not.toThrow();
    expect(f.store.get('policy')?.applicationAttempts[0].terminalOutcome).toBe('completed');
    expect(f.observations.get(work.input.claimToken)?.usageStatus).toBe('unknown');
  } finally {
    f.close();
  }
});
it('requests exact cancellation when persisted policy stops or its deadline expires', async () => {
  vi.useFakeTimers();
  try {
    for (const reason of ['user_stop', 'deadline_exceeded'] as const) {
      const work = fixture();
      const f = applicationFixture(work);
      try {
        f.store.reserveApplicationAttempt(f.request);
        f.policy.consume(work.input);
        const cancel = vi.fn();
        const dispose = f.policy.watch!(work.input, cancel);
        if (reason === 'user_stop') f.store.stopApplication('policy', 'user', reason);
        else vi.advanceTimersByTime(60000);
        await vi.advanceTimersByTimeAsync(250);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(f.store.get('policy')?.decisionCode).toBe(reason);
        expect(f.store.get('policy')?.applicationAttempts[0].settled).toBe(false);
        dispose();
        await vi.advanceTimersByTimeAsync(1000);
        expect(cancel).toHaveBeenCalledTimes(1);
      } finally {
        f.close();
      }
    }
  } finally {
    vi.useRealTimers();
  }
});
it('reconciles a known interrupted operation without settling unknown native execution', () => {
  const work = fixture();
  const f = applicationFixture(work);
  try {
    f.store.reserveApplicationAttempt(f.request);
    f.policy.consume(work.input);
    f.policy.reconcile?.(work.input);
    expect(f.store.get('policy')?.applicationAttempts[0].settled).toBe(false);
    f.observations.accept({
      claimToken: work.input.claimToken,
      sessionId: work.input.sessionId,
      seatId: seat.id,
      membershipGeneration: 2,
      accountBinding: seat.accountBinding,
      provenance: work.input.provenance,
      providerThreadId: 'thread',
      providerTurnId: 'turn',
    });
    f.observations.terminal({
      claimToken: work.input.claimToken,
      providerThreadId: 'thread',
      providerTurnId: 'turn',
      status: 'interrupted',
    });
    f.policy.reconcile?.(work.input);
    expect(f.store.get('policy')?.applicationAttempts[0]).toMatchObject({
      settled: true,
      terminalOutcome: 'cancelled',
    });
    expect(f.store.get('policy')?.hostTurns).toBe(1);
  } finally {
    f.close();
  }
});
it('does not let artifact-check failures reach policy consumption', () => {
  const work = fixture();
  const f = applicationFixture(work);
  try {
    f.store.reserveApplicationAttempt(f.request);
    f.assertArtifactCurrent.mockImplementation(() => {
      throw new Error('Artifact changed');
    });
    expect(() => f.policy.consume(work.input)).toThrow('Artifact changed');
    expect(f.store.get('policy')?.applicationAttempts[0].dispatched).toBe(false);
  } finally {
    f.close();
  }
});

it('checks the durable seal at final dispatch even for an already claimed recipient', () => {
  const { facts, input } = fixture();
  facts.assertSymposiumArtifactWorkAllowed = () => {
    throw new Error('artifact seal pending');
  };
  expect(() => admitSymposiumSeatDispatch(facts, profiles, input, hostGrants)).toThrow(
    'artifact seal pending',
  );
});

function seatSandboxRegistry() {
  const rows = new Map<string, SymposiumSeatSandboxRecord>();
  const fences = new Map<string, string>();
  const key = (sessionId: string, seatId: string, generation: number) =>
    `${sessionId}:${seatId}:${generation}`;
  return {
    listSymposiumSessionSandboxes(sessionId: string) {
      return [...rows.values()].filter((row) => row.sessionId === sessionId);
    },
    claimSymposiumSeatLifecycle(sessionId: string, seatId: string, token: string) {
      const id = `${sessionId}:${seatId}`;
      if (fences.has(id)) return false;
      fences.set(id, token);
      return true;
    },
    releaseSymposiumSeatLifecycle(sessionId: string, seatId: string, token: string) {
      const id = `${sessionId}:${seatId}`;
      if (fences.get(id) !== token) throw new Error('lifecycle fence changed');
      fences.delete(id);
    },
    reserveSymposiumSeatSandbox(
      input: Omit<
        SymposiumSeatSandboxRecord,
        'sandboxName' | 'physicalId' | 'creationStarted' | 'creationCompleted' | 'state'
      >,
    ) {
      const id = key(input.sessionId, input.seatId, input.generation);
      const existing = rows.get(id);
      if (existing) {
        if (
          existing.runtimeId !== input.runtimeId ||
          existing.state === 'stopped' ||
          (existing.creationStarted && !existing.creationCompleted)
        )
          throw new Error('reservation changed');
        return existing;
      }
      if (
        [...rows.values()].some(
          (row) =>
            row.sessionId === input.sessionId &&
            row.seatId === input.seatId &&
            row.state !== 'stopped',
        )
      )
        throw new Error('previous sandbox requires stop');
      const row: SymposiumSeatSandboxRecord = {
        ...input,
        sandboxName: null,
        physicalId: null,
        creationStarted: false,
        creationCompleted: false,
        state: 'reserved',
      };
      rows.set(id, row);
      return row;
    },
    markSymposiumSeatSandboxCreationStarted(input: {
      sessionId: string;
      seatId: string;
      generation: number;
      runtimeId: string;
    }) {
      const row = rows.get(key(input.sessionId, input.seatId, input.generation));
      if (
        !row ||
        row.runtimeId !== input.runtimeId ||
        row.creationStarted ||
        row.state !== 'reserved'
      )
        throw new Error('creation requires reconciliation');
      row.creationStarted = true;
    },
    rollbackUndispatchedSymposiumSeatCreation(input: {
      sessionId: string;
      seatId: string;
      generation: number;
      runtimeId: string;
      fenceToken: string;
    }) {
      const row = rows.get(key(input.sessionId, input.seatId, input.generation));
      if (!row || row.runtimeId !== input.runtimeId || row.physicalId || row.state !== 'reserved')
        throw new Error('intent changed');
      row.creationStarted = false;
    },
    recordSymposiumSeatCreationDiagnostic(input: {
      sessionId: string;
      seatId: string;
      generation: number;
      phase: 'create' | 'upload' | 'provider' | 'mount';
      failed: boolean;
    }) {
      const row = rows.get(key(input.sessionId, input.seatId, input.generation))!;
      row.creationPhase = input.phase;
      row.creationFailureCode = input.failed ? `SEAT_${input.phase.toUpperCase()}_FAILED` : null;
    },
    recordSymposiumSeatSandboxTerminalCreate(input: {
      sessionId: string;
      seatId: string;
      generation: number;
      runtimeId: string;
      sandboxName: string;
      physicalId: string;
    }) {
      const row = rows.get(key(input.sessionId, input.seatId, input.generation));
      if (
        !row ||
        row.runtimeId !== input.runtimeId ||
        !row.creationStarted ||
        row.creationCompleted ||
        row.physicalId
      )
        throw new Error('terminal identity changed');
      row.sandboxName = input.sandboxName;
      row.physicalId = input.physicalId;
      row.creationCompleted = true;
    },
    markSymposiumSeatSandboxCreationCompleted(input: {
      sessionId: string;
      seatId: string;
      generation: number;
      runtimeId: string;
      physicalId: string;
    }) {
      const row = rows.get(key(input.sessionId, input.seatId, input.generation));
      if (
        !row ||
        row.runtimeId !== input.runtimeId ||
        row.physicalId !== input.physicalId ||
        !row.creationStarted ||
        row.creationCompleted ||
        row.state !== 'ready'
      )
        throw new Error('completion changed');
      row.creationCompleted = true;
    },
    confirmSymposiumSeatSandbox(input: {
      sessionId: string;
      seatId: string;
      generation: number;
      runtimeId: string;
      sandboxName: string;
      physicalId: string;
    }) {
      const row = rows.get(key(input.sessionId, input.seatId, input.generation));
      if (
        !row ||
        row.runtimeId !== input.runtimeId ||
        (row.physicalId && row.physicalId !== input.physicalId)
      )
        throw new Error('identity changed');
      row.sandboxName = input.sandboxName;
      row.physicalId = input.physicalId;
      row.state = 'ready';
    },
    getSymposiumSeatSandbox: (sessionId: string, seatId: string, generation: number) =>
      rows.get(key(sessionId, seatId, generation)),
    listUnstoppedSymposiumSeatSandboxes: (sessionId: string, seatId: string) =>
      [...rows.values()]
        .filter(
          (row) => row.sessionId === sessionId && row.seatId === seatId && row.state !== 'stopped',
        )
        .map((row) => ({ ...row })),
    confirmSymposiumSeatSandboxStopped(input: {
      sessionId: string;
      seatId: string;
      generation: number;
      physicalId: string;
    }) {
      const row = rows.get(key(input.sessionId, input.seatId, input.generation));
      if (
        !row ||
        row.physicalId !== input.physicalId ||
        (row.creationStarted && !row.creationCompleted)
      )
        throw new Error('stop identity changed');
      row.state = 'stopped';
    },
    confirmAbsentSymposiumSeatSandboxStopped(input: {
      sessionId: string;
      seatId: string;
      generation: number;
    }) {
      const row = rows.get(key(input.sessionId, input.seatId, input.generation));
      if (!row || row.physicalId || row.creationStarted) throw new Error('absence changed');
      row.state = 'stopped';
    },
  };
}

const registryDirectories: string[] = [];
afterEach(() => {
  for (const directory of registryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function registryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'symposium-executor-'));
  registryDirectories.push(directory);
  return directory;
}

describe('last native Symposium dispatch fence', () => {
  it.each(['admission', 'setup', 'initialization'])(
    'confirms a never-launched claim after %s failure, including host restart',
    async (failure) => {
      const work = fixture();
      const directory = registryDirectory();
      const host = initializeSymposiumNativeHost(directory);
      const deps = {
        facts: work.facts,
        profiles,
        attemptRegistry: host.registry,
        hostGrants: {
          verifySeat: () => {
            if (failure === 'admission') throw new Error('Setup failed');
          },
        },
        owner: {
          ensure: async () => {
            if (failure === 'setup') throw new Error('Setup failed');
            return {
              sandboxName: 'shared',
              workdir: '/sandbox/workspaces/mgmt',
              cli: 'openshell',
              gateway: 'test-gateway',
              workspace: 'test-workspace',
              gatewayInsecure: false,
            };
          },
          readOnlyEnforced: { openaiApi: true, claudeVertex: false },
        },
        recordAccepted: () => true,
        openNative: vi.fn(async () => {
          throw new Error('Setup failed');
        }),
      };
      await expect(new SymposiumOpenShellSeatExecutor(deps).execute(work.input)).rejects.toThrow(
        'Setup failed',
      );
      host.registry.close();
      const restarted = initializeSymposiumNativeHost(directory);
      expect(restarted.quarantinedClaims).toEqual([]);
      const executor = new SymposiumOpenShellSeatExecutor({
        ...deps,
        attemptRegistry: restarted.registry,
      });
      await expect(executor.cancel({ claimToken: work.input.claimToken })).resolves.toBeUndefined();
      expect(() =>
        restarted.registry.reserve({
          claimToken: work.input.claimToken,
          sessionId: work.input.sessionId,
          sandbox: { sandboxName: 'shared', workdir: '/work' },
        }),
      ).toThrow(/closed/);
      await expect(executor.cancel({ claimToken: 'unknown' })).rejects.toThrow(/unavailable/);
      restarted.registry.close();
    },
  );

  it('recovers a launched claim after restart only with exact controller cleanup proof', async () => {
    const work = fixture();
    const directory = registryDirectory();
    const host = initializeSymposiumNativeHost(directory);
    const sandbox = {
      sandboxName: 'shared',
      workdir: '/sandbox/workspaces/mgmt',
      cli: 'openshell',
      gateway: 'test-gateway',
      workspace: 'test-workspace',
      gatewayInsecure: false,
    };
    host.registry.prepare(work.input);
    // reserve is the durable pre-side-effect boundary; a crash here is uncertain.
    host.registry.reserve({ ...work.input, sandbox });
    host.registry.close();
    const restarted = initializeSymposiumNativeHost(directory);
    expect(restarted.quarantinedClaims).toEqual([work.input.claimToken]);
    expect(restarted.registry.get(work.input.claimToken)?.state).toBe('uncertain');
    restarted.registry.close();
    const confirm = vi
      .fn()
      .mockRejectedValueOnce(new Error('Observer unavailable'))
      .mockResolvedValueOnce(undefined);
    const registry = new SymposiumAttemptRegistry(join(directory, 'claims.db'), {
      launch: vi.fn(),
      confirm,
    });
    const executor = new SymposiumOpenShellSeatExecutor({
      facts: work.facts,
      profiles,
      hostGrants,
      attemptRegistry: registry,
      owner: { ensure: vi.fn(), readOnlyEnforced: { openaiApi: true, claudeVertex: false } },
      recordAccepted: () => true,
      openNative: vi.fn(),
    });
    await expect(executor.cancel({ claimToken: work.input.claimToken })).rejects.toThrow(
      /quarantined/,
    );
    expect(() => registry.assertSandboxAvailable(sandbox.sandboxName)).toThrow(/quarantined/);
    await expect(executor.cancel({ claimToken: work.input.claimToken })).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledWith(sandbox, work.input.claimToken);
    expect(() => registry.assertSandboxAvailable(sandbox.sandboxName)).not.toThrow();
    registry.close();
  });

  it('shutdown waits for already-started setup, fences new work and prevents late native launch', async () => {
    const work = fixture();
    const host = initializeSymposiumNativeHost(registryDirectory());
    let finish!: (value: { sandboxName: string; workdir: string }) => void;
    const openNative = vi.fn();
    const executor = new SymposiumOpenShellSeatExecutor({
      facts: work.facts,
      profiles,
      hostGrants,
      attemptRegistry: host.registry,
      owner: {
        ensure: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      },
      recordAccepted: () => true,
      openNative,
    });
    const running = executor.execute(work.input);
    const rejected = expect(running).rejects.toThrow('shutting down');
    let drained = false;
    const drain = executor.drain(new AbortController().signal).then(() => {
      drained = true;
    });
    await expect(executor.execute(work.input)).rejects.toThrow('shutting down');
    await Promise.resolve();
    expect(drained).toBe(false);
    finish({ sandboxName: 'shared', workdir: '/work' });
    await rejected;
    await drain;
    expect(openNative).not.toHaveBeenCalled();
    host.registry.close();
  });

  it('shutdown waits for in-flight setup even when cancellation fails', async () => {
    const work = fixture();
    const host = initializeSymposiumNativeHost(registryDirectory());
    let finish!: (value: { sandboxName: string; workdir: string }) => void;
    const openNative = vi.fn();
    const executor = new SymposiumOpenShellSeatExecutor({
      facts: work.facts,
      profiles,
      hostGrants,
      attemptRegistry: host.registry,
      owner: {
        ensure: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      },
      recordAccepted: () => true,
      openNative,
    });
    vi.spyOn(executor, 'cancel').mockRejectedValue(new Error('cancel failed'));
    const running = executor.execute(work.input);
    const rejected = expect(running).rejects.toThrow('shutting down');
    let drained = false;
    const drain = executor.drain(new AbortController().signal);
    void drain.catch(() => {
      drained = true;
    });
    const drainRejected = expect(drain).rejects.toThrow('cleanup incomplete');
    await expect(executor.execute(work.input)).rejects.toThrow('shutting down');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drained).toBe(false);
    finish({ sandboxName: 'shared', workdir: '/work' });
    await rejected;
    await drainRejected;
    expect(openNative).not.toHaveBeenCalled();
    host.registry.close();
  });

  it('prevents setup from launching after a concurrent prelaunch cancellation', async () => {
    const work = fixture();
    const host = initializeSymposiumNativeHost(registryDirectory());
    let finish!: (value: { sandboxName: string; workdir: string }) => void;
    const openNative = vi.fn();
    const executor = new SymposiumOpenShellSeatExecutor({
      facts: work.facts,
      profiles,
      hostGrants,
      attemptRegistry: host.registry,
      owner: {
        ensure: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      },
      recordAccepted: () => true,
      openNative,
    });
    const running = executor.execute(work.input);
    await executor.cancel({ claimToken: work.input.claimToken });
    finish({ sandboxName: 'shared', workdir: '/work' });
    await expect(running).rejects.toThrow(/cancelled/);
    expect(openNative).not.toHaveBeenCalled();
    host.registry.close();
  });

  it('re-probes the exact host and provider immediately before native dispatch', async () => {
    const work = fixture();
    let available = true;
    const verifyHostCapability = vi.fn(() => {
      if (!available) throw new Error('Selected gateway capability changed');
      return { attestedProviderInstances: new Map() };
    });
    const send = vi.fn();
    const executor = new SymposiumOpenShellSeatExecutor({
      facts: work.facts,
      profiles,
      hostGrants,
      verifyHostCapability,
      owner: {
        ensure: async () => ({
          sandboxName: 'seat',
          workdir: '/sandbox/workspaces/mgmt',
          cli: 'openshell',
          gateway: 'test-gateway',
          workspace: 'test-workspace',
          gatewayInsecure: false,
        }),
        readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      },
      recordAccepted: vi.fn(() => true),
      openNative: async () => ({
        run: async (_input, callbacks) => {
          callbacks.beforeDispatch();
          send();
          return { providerThreadId: 'thread-1', content: 'sent' };
        },
        cancel: async () => undefined,
      }),
    });
    await expect(executor.execute(work.input)).rejects.toThrow('outside the host attestation');
    expect(verifyHostCapability).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    available = false;
    await expect(executor.execute({ ...work.input, claimToken: 'claim-2' })).rejects.toThrow(
      'Selected gateway capability changed',
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('checks application policy before setup and consumes it only at final native dispatch', async () => {
    const work = fixture();
    const order: string[] = [];
    const applicationPolicy = {
      assertCurrent: () => {
        order.push('policy-check');
      },
      consume: () => {
        order.push('policy-consumed');
      },
      accepted: (_input: SymposiumSeatExecution, thread: string, turn: string) => {
        order.push(`accepted:${thread}:${turn}`);
      },
      completed: () => {
        order.push('completed');
      },
    };
    const executor = new SymposiumOpenShellSeatExecutor({
      facts: work.facts,
      profiles,
      hostGrants,
      applicationPolicy,
      owner: {
        ensure: async () => {
          order.push('setup');
          return {
            sandboxName: 'shared',
            workdir: '/sandbox/workspaces/mgmt',
            cli: 'openshell',
            gateway: 'test-gateway',
            workspace: 'test-workspace',
            gatewayInsecure: false,
          };
        },
        readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      },
      recordAccepted: () => {
        order.push('event-receipt');
        return true;
      },
      openNative: async () => ({
        run: async (_input, callbacks) => {
          callbacks.beforeDispatch('thread-1');
          order.push('send');
          callbacks.accepted('thread-1', 'turn-1');
          return { providerThreadId: 'thread-1', content: 'reviewed' };
        },
        cancel: async () => undefined,
      }),
    });
    await executor.execute(work.input);
    expect(order[0]).toBe('policy-check');
    expect(order.filter((value) => value === 'policy-consumed')).toHaveLength(1);
    expect(order.indexOf('policy-consumed')).toBeLessThan(order.indexOf('send'));
    expect(order.indexOf('event-receipt')).toBeLessThan(order.indexOf('accepted:thread-1:turn-1'));
    expect(order.at(-1)).toBe('completed');
  });
  it('blocks stopped application work before sandbox setup and after native initialization', async () => {
    for (const stopDuringInitialization of [false, true]) {
      const work = fixture();
      let stopped = !stopDuringInitialization;
      const send = vi.fn();
      const ensure = vi.fn(async () => ({
        sandboxName: 'shared',
        workdir: '/sandbox/workspaces/mgmt',
        cli: 'openshell',
        gateway: 'test-gateway',
        workspace: 'test-workspace',
        gatewayInsecure: false,
      }));
      const consume = vi.fn();
      const executor = new SymposiumOpenShellSeatExecutor({
        facts: work.facts,
        profiles,
        hostGrants,
        applicationPolicy: {
          assertCurrent: () => {
            if (stopped) throw new Error('Application run stopped');
          },
          consume,
          accepted: () => undefined,
          completed: () => undefined,
        },
        owner: { ensure, readOnlyEnforced: { openaiApi: true, claudeVertex: false } },
        recordAccepted: () => true,
        openNative: async () => {
          stopped = true;
          return {
            run: async (_input, callbacks) => {
              callbacks.beforeDispatch('thread-1');
              send();
              return { providerThreadId: 'thread-1', content: 'unexpected' };
            },
            cancel: async () => undefined,
          };
        },
      });
      await expect(executor.execute(work.input)).rejects.toThrow('Application run stopped');
      expect(send).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
      expect(ensure).toHaveBeenCalledTimes(stopDuringInitialization ? 1 : 0);
    }
  });
  it('rejects a first-turn result whose thread differs from the accepted receipt', async () => {
    const work = fixture();
    const executor = new SymposiumOpenShellSeatExecutor({
      facts: work.facts,
      profiles,
      hostGrants,
      owner: {
        ensure: async () => ({
          sandboxName: 'shared',
          workdir: '/sandbox/workspaces/mgmt',
          cli: 'openshell',
          gateway: 'test-gateway',
          workspace: 'test-workspace',
          gatewayInsecure: false,
        }),
        readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      },
      recordAccepted: () => true,
      openNative: async () => ({
        run: async (_input, callbacks) => {
          callbacks.beforeDispatch('accepted-thread');
          callbacks.accepted('accepted-thread', 'turn');
          return { providerThreadId: 'unrelated-thread', content: 'wrong' };
        },
        cancel: async () => undefined,
      }),
    });
    await expect(executor.execute(work.input)).rejects.toThrow(/thread identity/);
  });
  it('rechecks the host grant after sandbox setup and records only exact accepted turns', async () => {
    const work = fixture();
    let permitted = true;
    const verifySeat = vi.fn(() => {
      if (!permitted) throw new Error('Host grant revoked');
    });
    const receipts: Array<Record<string, unknown>> = [];
    const run = vi.fn(async (_input, callbacks) => {
      callbacks.beforeDispatch();
      callbacks.accepted('thread-1', 'turn-1');
      return { providerThreadId: 'thread-1', content: 'reviewed' };
    });
    const executor = new SymposiumOpenShellSeatExecutor({
      facts: work.facts,
      profiles,
      hostGrants: { verifySeat },
      owner: {
        ensure: async () => ({
          sandboxName: 'shared',
          workdir: '/sandbox/workspaces/mgmt',
          cli: 'openshell',
          gateway: 'test-gateway',
          workspace: 'test-workspace',
          gatewayInsecure: false,
        }),
        readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      },
      recordAccepted: (input) => {
        receipts.push(input);
        return true;
      },
      openNative: async () => ({ run, cancel: async () => undefined }),
    });
    await expect(executor.execute(work.input)).resolves.toMatchObject({
      providerThreadId: 'thread-1',
      content: 'reviewed',
    });
    expect(receipts).toEqual([
      {
        deliveryId: 'delivery-1',
        seatId: 'reviewer',
        claimToken: 'claim-1',
        providerThreadId: 'thread-1',
        providerTurnId: 'turn-1',
        acceptedAt: expect.any(Number),
      },
    ]);
    permitted = false;
    await expect(executor.execute({ ...work.input, claimToken: 'claim-2' })).rejects.toThrow(
      'Host grant revoked',
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('opens an independent Codex thread and accepts only its actual routed prompt', async () => {
    const work = fixture();
    const profiled = {
      ...work.input,
      seat: {
        ...work.input.seat,
        expectedOutput: 'A focused review',
        acceptanceCriteria: ['Cite each finding', 'Name remaining risk'],
      },
    };
    let options: Record<string, unknown> | undefined;
    const sent: Array<Record<string, unknown>> = [];
    const controllerProof = vi.fn().mockResolvedValue(undefined);
    const native = await createOpenAiCodexSeat({
      sandbox: {
        sandboxName: 'shared',
        workdir: '/sandbox/workspaces/mgmt',
        cli: 'openshell',
        gateway: 'test-gateway',
        workspace: 'test-workspace',
        gatewayInsecure: false,
      },
      route: admitSymposiumSeatDispatch(work.facts, profiles, work.input, hostGrants),
      execution: profiled,
      store: {} as never,
      testConfirmStopped: controllerProof,
      createConversation: (opts) => {
        options = opts as unknown as Record<string, unknown>;
        return {
          initialize: async () => undefined,
          getThreadId: () => 'thread-1',
          send: async (command) => {
            sent.push(command);
            (opts.onProviderDispatch as (id: string) => void)(command.id);
            (opts.onProviderAccepted as (id: string, thread: string, turn: string) => void)(
              command.id,
              'thread-1',
              'turn-1',
            );
            (opts.emit as (event: Record<string, unknown>) => void)({
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'specific review' }] },
            });
            (opts.onProviderComplete as (id: string, status: string) => void)(
              command.id,
              'completed',
            );
          },
          interrupt: async () => undefined,
          close: () => undefined,
        };
      },
    });
    const accepted: string[] = [];
    const result = await native.run(profiled, {
      beforeDispatch: () => accepted.push('dispatch'),
      accepted: (_thread, turn) => accepted.push(turn),
    });
    expect(sent).toEqual([
      expect.objectContaining({
        id: work.input.claimToken,
        prompt: 'Only this approved excerpt.',
        model: 'gpt-test',
      }),
    ]);
    expect(accepted).toEqual(['dispatch', 'turn-1']);
    expect(result).toEqual({ providerThreadId: 'thread-1', content: 'specific review' });
    expect(options?.conversationId).toBe(symposiumSeatRuntimeId(work.input));
    expect(options?.systemPrompt).toBe(
      'Review only.\n\nExpected output:\nA focused review\n\nAcceptance criteria:\n- Cite each finding\n- Name remaining risk',
    );
    expect(options?.turnSandboxPolicy).toEqual({ type: 'readOnly' });
    expect(options?.runtimeConfig).toEqual({
      web_search: 'disabled',
      'features.use_legacy_landlock': true,
      'features.shell_tool': false,
      'features.unified_exec': false,
      'features.code_mode': false,
      'features.code_mode_host': false,
    });
    expect(controllerProof).toHaveBeenCalledOnce();
  });
  it('refuses the real Codex transport without an attested controller command', async () => {
    const work = fixture();
    await expect(
      createOpenAiCodexSeat({
        sandbox: {
          sandboxName: 'shared',
          workdir: '/sandbox/workspaces/mgmt',
          cli: 'openshell',
          gateway: 'test-gateway',
          workspace: 'test-workspace',
          gatewayInsecure: false,
        },
        route: admitSymposiumSeatDispatch(work.facts, profiles, work.input, hostGrants),
        execution: work.input,
        store: {} as never,
      }),
    ).rejects.toThrow(/controller capability is unavailable/);
  });
  it('pins the controller to the direct reviewed app-server argv', () => {
    expect(SYMPOSIUM_CODEX_CONTROLLER_COMMAND[0]).toBe('/usr/bin/codex');
    expect(() => assertCodexControllerCommand(SYMPOSIUM_CODEX_CONTROLLER_COMMAND)).not.toThrow();
    expect(() => assertCodexControllerCommand(['/sandbox/run-mitzo-app-server'])).toThrow(
      /reviewed API launcher/,
    );
    expect(() =>
      assertCodexControllerCommand([...SYMPOSIUM_CODEX_CONTROLLER_COMMAND, 'extra']),
    ).toThrow(/reviewed API launcher/);
  });
  it('keeps native cleanup reserved after transport loss until the exact turn terminates', async () => {
    const work = fixture();
    let complete: (id: string, status: 'failed') => void = () => undefined;
    let terminal: (id: string, turn: string, status: 'interrupted') => void = () => undefined;
    const controllerProof = vi.fn().mockResolvedValue(undefined);
    const native = await createOpenAiCodexSeat({
      sandbox: {
        sandboxName: 'shared',
        workdir: '/sandbox/workspaces/mgmt',
        cli: 'openshell',
        gateway: 'test-gateway',
        workspace: 'test-workspace',
        gatewayInsecure: false,
      },
      route: admitSymposiumSeatDispatch(work.facts, profiles, work.input, hostGrants),
      execution: work.input,
      store: {} as never,
      testConfirmStopped: controllerProof,
      createConversation: (opts) => {
        complete = (id, status) => opts.onProviderComplete?.(id, status);
        terminal = (id, turn, status) => opts.onProviderTerminal?.(id, turn, status);
        return {
          initialize: async () => undefined,
          getThreadId: () => 'thread-1',
          send: async (command) => {
            opts.onProviderDispatch?.(command.id);
            opts.onProviderAccepted?.(command.id, 'thread-1', 'turn-1');
          },
          interrupt: async () => undefined,
          close: () => undefined,
        };
      },
    });
    const run = native.run(work.input, {
      beforeDispatch: () => undefined,
      accepted: () => undefined,
    });
    complete(work.input.claimToken, 'failed');
    await expect(run).rejects.toThrow(/did not complete/);
    let settled = false;
    const cancel = native.cancel().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    terminal(work.input.claimToken, 'other-turn', 'interrupted');
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    terminal(work.input.claimToken, 'turn-1', 'interrupted');
    await expect(cancel).resolves.toBeUndefined();
    expect(controllerProof).toHaveBeenCalledOnce();
  });
  it('keeps Codex cleanup unconfirmed when the controller observer loses its marker', async () => {
    const work = fixture();
    const native = await createOpenAiCodexSeat({
      sandbox: {
        sandboxName: 'shared',
        workdir: '/sandbox/workspaces/mgmt',
        cli: 'openshell',
        gateway: 'test-gateway',
        workspace: 'test-workspace',
        gatewayInsecure: false,
      },
      route: admitSymposiumSeatDispatch(work.facts, profiles, work.input, hostGrants),
      execution: work.input,
      store: {} as never,
      testConfirmStopped: async () => {
        throw new Error('Native attempt cleanup is unconfirmed');
      },
      createConversation: (opts) => ({
        initialize: async () => undefined,
        getThreadId: () => 'thread-1',
        send: async (command) => {
          opts.onProviderDispatch?.(command.id);
          opts.onProviderAccepted?.(command.id, 'thread-1', 'turn-1');
          opts.onProviderTerminal?.(command.id, 'turn-1', 'completed');
          opts.onProviderComplete?.(command.id, 'completed');
        },
        interrupt: async () => undefined,
        close: () => undefined,
      }),
    });
    await expect(
      native.run(work.input, { beforeDispatch: () => undefined, accepted: () => undefined }),
    ).rejects.toThrow(/cleanup is unconfirmed/);
    await expect(native.cancel()).rejects.toThrow(/cleanup is unconfirmed/);
  });
  it('pins a mixed OpenAI and Claude union but blocks attachment before private state isolation', async () => {
    const work = fixture();
    const claudeSeat = {
      ...seat,
      id: 'claude',
      name: 'Claude',
      role: 'implementer',
      model: 'claude-test',
      accountBinding: AccountBindingSchema.parse(profiles.resolve('work-vertex', 'claude-test')),
    };
    const mixed = {
      ...config,
      anchorSeatId: 'reviewer',
      seats: [seat, claudeSeat],
    } as SymposiumConfig;
    const facts = {
      ...work.facts,
      assertSymposiumArtifactWorkAllowed: () => {},
      getActiveSymposiumConfig: () => mixed,
      getLatestSymposiumMembership: (_sessionId: string, seatId: string) =>
        seatId === 'claude'
          ? {
              ...membership,
              seatId: 'claude',
              bindingKey: JSON.stringify([
                claudeSeat.accountBinding,
                claudeSeat.profileBinding,
                undefined,
                claudeSeat.contextGrant,
                claudeSeat.authorityGrant,
                claudeSeat.isolationRequest,
              ]),
            }
          : membership,
      getLatestSymposiumAdmission: (_sessionId: string, seatId: string) =>
        seatId === 'claude'
          ? {
              ...admission,
              seatId: 'claude',
              provider: 'anthropic-vertex',
              accountId: 'work-vertex',
              model: 'claude-test',
              accountProfileRevision: claudeSeat.accountBinding.profileRevision,
            }
          : admission,
    };
    let vertexType = 'google-vertex-ai';
    const identities = (name: string) => ({
      name,
      id: name === 'vertex-work' ? 'vertex-object' : 'openai-object',
      type: name === 'vertex-work' ? vertexType : 'openai',
      workspace: 'default',
    });
    const union = snapshotSymposiumProviderUnion(
      'symposium',
      facts,
      profiles,
      hostGrants,
      identities,
      'default',
    );
    expect(union.owner).toEqual({ kind: 'api', provider: 'openai-work', model: 'gpt-test' });
    expect(union.bindings).toEqual([
      { name: 'openai-work', id: 'openai-object', type: 'openai' },
      { name: 'vertex-work', id: 'vertex-object', type: 'google-vertex-ai' },
    ]);
    const openaiOnly = snapshotSymposiumSeatProvider(
      'symposium',
      'reviewer',
      facts,
      profiles,
      hostGrants,
      identities,
      'default',
    );
    const vertexOnly = snapshotSymposiumSeatProvider(
      'symposium',
      'claude',
      facts,
      profiles,
      hostGrants,
      identities,
      'default',
    );
    expect(openaiOnly.bindings).toEqual([
      { name: 'openai-work', id: 'openai-object', type: 'openai' },
    ]);
    expect(vertexOnly.bindings).toEqual([
      { name: 'vertex-work', id: 'vertex-object', type: 'google-vertex-ai' },
    ]);
    expect(openaiOnly.runtimeId).not.toBe(vertexOnly.runtimeId);
    expect(union.verify).not.toThrow();
    vertexType = 'openai';
    expect(() =>
      snapshotSymposiumProviderUnion(
        'symposium',
        facts,
        profiles,
        hostGrants,
        identities,
        'default',
      ),
    ).toThrow(/provider type/i);
    vertexType = 'google-vertex-ai';
    const owner = new SymposiumSharedSandboxOwner({
      sessionId: 'symposium',
      facts,
      profiles,
      hostGrants,
      resolveProviderIdentity: identities,
      runtimeConfig: {
        cli: 'openshell',
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      managerFactory: () => ({
        ensure: async () => {
          throw new Error('must not attach');
        },
      }),
    });
    await expect(owner.ensure('symposium', new AbortController().signal)).rejects.toThrow(
      /private Claude seat state isolation/i,
    );
    vertexType = 'another-provider-type';
    expect(union.verify).toThrow(/provider type/i);
  });
  it('blocks two Codex seats from sharing native HOME state before OS isolation is proved', async () => {
    const work = fixture();
    const secondSeat = { ...seat, id: 'builder', name: 'Builder', role: 'implementer' };
    const facts = {
      ...work.facts,
      assertSymposiumArtifactWorkAllowed: () => {},
      getActiveSymposiumConfig: () => ({ ...config, seats: [seat, secondSeat] }),
      getLatestSymposiumMembership: (_sessionId: string, seatId: string) => ({
        ...membership,
        seatId,
      }),
      getLatestSymposiumAdmission: (_sessionId: string, seatId: string) => ({
        ...admission,
        seatId,
      }),
    } as SymposiumDispatchFacts;
    const owner = new SymposiumSharedSandboxOwner({
      sessionId: 'symposium',
      facts,
      profiles,
      hostGrants,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      managerFactory: () => ({
        ensure: async () => {
          throw new Error('must not attach');
        },
      }),
    });
    await expect(owner.ensure('symposium', new AbortController().signal)).rejects.toThrow(
      /private native seat state isolation/i,
    );
  });
  it('pins one attachment and one sandbox identity per confirmed seat', async () => {
    const work = fixture();
    const secondSeat = { ...seat, id: 'builder', name: 'Builder', role: 'implementer' };
    const facts: SymposiumDispatchFacts = {
      ...work.facts,
      assertSymposiumArtifactWorkAllowed: () => {},
      getActiveSymposiumConfig: () => ({ ...config, seats: [seat, secondSeat] }),
      getLatestSymposiumMembership: (_sessionId, seatId) => ({ ...membership, seatId }),
      getLatestSymposiumAdmission: (_sessionId, seatId) => ({ ...admission, seatId }),
    };
    const identities = (name: string, id: string) => ({
      name,
      id,
      type: 'openai',
      workspace: 'default',
    });
    const first = snapshotSymposiumSeatProvider(
      'symposium',
      'reviewer',
      facts,
      profiles,
      hostGrants,
      identities,
      'default',
    );
    const second = snapshotSymposiumSeatProvider(
      'symposium',
      'builder',
      facts,
      profiles,
      hostGrants,
      identities,
      'default',
    );
    expect(first.runtimeId).not.toBe(second.runtimeId);
    expect(first.bindings).toEqual([{ name: 'openai-work', type: 'openai', id: 'openai-object' }]);
    expect(second.bindings).toEqual(first.bindings);
    const configurations: Array<{ accountProviderBindings?: readonly { name: string }[] }> = [];
    let creationFenceEntries = 0;
    let rejectQueued = true;
    const creationRegistry = seatSandboxRegistry();
    const owner = new SymposiumPerSeatSandboxOwner({
      runSandboxCreation: async (verify, operation) => {
        if (rejectQueued) throw new Error('queued admission revoked');
        verify();
        creationFenceEntries++;
        return operation(() => {});
      },
      sessionId: 'symposium',
      facts,
      profiles,
      hostGrants,
      seatSandboxRegistry: creationRegistry,
      resolveProviderIdentity: identities,
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      perSeatSandboxVerified: true,
      managerFactory: (runtimeConfig) => {
        configurations.push(runtimeConfig);
        return {
          ensure: async (runtimeId) => {
            runtimeConfig.beforeSandboxCreate?.();
            return {
              sandboxName: runtimeId,
              sandboxId: `id:${runtimeId}`,
              workdir: '/sandbox/workspaces/mgmt',
            };
          },
        };
      },
    });
    await expect(
      owner.ensure('symposium', 'reviewer', new AbortController().signal),
    ).rejects.toThrow('queued admission revoked');
    expect(
      creationRegistry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.creationStarted,
    ).toBe(false);
    rejectQueued = false;
    configurations.length = 0;
    const [a, b] = await Promise.all([
      owner.ensure('symposium', 'reviewer', new AbortController().signal),
      owner.ensure('symposium', 'builder', new AbortController().signal),
    ]);
    expect(creationFenceEntries).toBe(2);
    expect(a.sandboxName).not.toBe(b.sandboxName);
    expect(configurations.map((value) => value.accountProviderBindings)).toEqual([
      first.bindings,
      second.bindings,
    ]);
  });
  it('quarantines a timed-out create even when an absence probe precedes late gateway creation', async () => {
    const work = fixture();
    const registry = seatSandboxRegistry();
    let gatewaySandbox: { id: string; name: string; phase: string } | undefined;
    let finishGatewayCreate: (() => void) | undefined;
    const gatewayCreate = new Promise<void>((resolve) => {
      finishGatewayCreate = () => {
        gatewaySandbox = { id: 'late-physical', name: 'late-seat', phase: 'Ready' };
        resolve();
      };
    });
    const ensure = vi.fn(async () => {
      // The CLI request times out while the gateway continues creating the sandbox.
      void gatewayCreate;
      throw new Error('gateway create timed out');
    });
    const owner = new SymposiumPerSeatSandboxOwner({
      sessionId: 'symposium',
      facts: work.facts,
      profiles,
      hostGrants,
      seatSandboxRegistry: registry,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      perSeatSandboxVerified: true,
      managerFactory: () => ({
        ensure,
        inspectReserved: async () => gatewaySandbox,
        inspect: async () => gatewaySandbox,
        stop: async () => {
          throw new Error('uncertain create must not be stopped as settled');
        },
      }),
    });
    const signal = new AbortController().signal;
    await expect(owner.ensure('symposium', 'reviewer', signal)).rejects.toThrow(/timed out/);
    expect(registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)).toMatchObject({
      state: 'reserved',
      creationStarted: true,
      creationCompleted: false,
    });
    await expect(owner.stop('symposium', 'reviewer', 2, signal)).rejects.toThrow(
      /may still complete/,
    );
    expect(registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe('reserved');
    finishGatewayCreate!();
    await gatewayCreate;
    await expect(owner.stop('symposium', 'reviewer', 2, signal)).rejects.toThrow(/uncertain/);
    expect(registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)).toMatchObject({
      state: 'ready',
      physicalId: 'late-physical',
      creationCompleted: false,
    });
    await expect(owner.ensure('symposium', 'reviewer', signal)).rejects.toThrow(
      /reservation changed/,
    );
    expect(ensure).toHaveBeenCalledTimes(1);
  });
  it('re-probes host and exact provider before a queued sandbox reservation', async () => {
    const work = fixture();
    const registry = seatSandboxRegistry();
    const managerFactory = vi.fn(() => ({
      ensure: async () => ({
        sandboxName: 'seat',
        sandboxId: 'physical-seat',
        workdir: '/sandbox/workspaces/mgmt',
      }),
    }));
    const verifyHostCapability = vi.fn(() => ({
      attestedProviderInstances: new Map(),
    }));
    const owner = new SymposiumPerSeatSandboxOwner({
      sessionId: 'symposium',
      facts: work.facts,
      profiles,
      hostGrants,
      seatSandboxRegistry: registry,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      perSeatSandboxVerified: true,
      verifyHostCapability,
      managerFactory,
    });
    await expect(
      owner.ensure('symposium', 'reviewer', new AbortController().signal),
    ).rejects.toThrow('outside the host attestation');
    expect(registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)).toBeUndefined();
    expect(managerFactory).not.toHaveBeenCalled();
    expect(verifyHostCapability).toHaveBeenCalledTimes(1);
  });

  it('reuses the retained sandbox after a benign config revision but rejects a changed authority grant', async () => {
    const work = fixture();
    const registry = seatSandboxRegistry();
    const ensure = vi.fn(async (runtimeId: string) => ({
      sandboxName: runtimeId,
      sandboxId: `physical:${runtimeId}`,
      workdir: '/sandbox/workspaces/mgmt',
    }));
    const stopped: string[] = [];
    let phase = 'Ready';
    const owner = new SymposiumPerSeatSandboxOwner({
      sessionId: 'symposium',
      facts: work.facts,
      profiles,
      hostGrants,
      seatSandboxRegistry: registry,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      perSeatSandboxVerified: true,
      managerFactory: () => ({
        ensure,
        inspectReserved: async () => undefined,
        inspect: async (_runtimeId, physicalId) => ({ id: physicalId, phase }),
        stop: async (runtimeId, physicalId) => {
          stopped.push(`${runtimeId}:${physicalId}`);
          phase = 'Stopped';
        },
      }),
    });
    const signal = new AbortController().signal;
    const first = await owner.ensure('symposium', 'reviewer', signal);
    const retained = registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)!;

    work.setConfig({ ...config, revision: 5 });
    work.setAdmission({ ...admission, configRevision: 5 });
    const second = await owner.ensure('symposium', 'reviewer', signal);
    expect(second).toEqual(first);
    expect(ensure).toHaveBeenCalledTimes(2);

    work.setConfig({
      ...config,
      revision: 6,
      seats: [{ ...seat, authorityGrant: { ...seat.authorityGrant!, revision: 2 } }],
    });
    work.setAdmission({ ...admission, configRevision: 6 });
    await expect(owner.ensure('symposium', 'reviewer', signal)).rejects.toThrow(
      /reservation changed/,
    );
    expect(ensure).toHaveBeenCalledTimes(2);
    await owner.stop('symposium', 'reviewer', 2, signal);
    expect(stopped).toEqual([`${retained.runtimeId}:${retained.physicalId}`]);
    expect(registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe('stopped');
  });
  it('changes the sandbox identity when the physical provider binding changes', () => {
    const work = fixture();
    const identity = (name: string, id: string) => ({
      name,
      id,
      type: 'openai',
      workspace: 'default',
    });
    const first = snapshotSymposiumSeatProvider(
      'symposium',
      'reviewer',
      work.facts,
      profiles,
      hostGrants,
      identity,
      'default',
    );
    const changedProfiles = new AccountProfiles([
      {
        id: 'work-api',
        label: 'Work OpenAI',
        provider: 'openai',
        credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
        sandboxProvider: 'openai-work',
        sandboxProviderId: 'replacement-object',
        models: [{ id: 'gpt-test', label: 'Test' }],
      },
    ]);
    const replacementBinding = AccountBindingSchema.parse(
      changedProfiles.resolve('work-api', 'gpt-test'),
    );
    work.setConfig({
      ...config,
      revision: 5,
      seats: [{ ...seat, accountBinding: replacementBinding }],
    });
    work.setAdmission({
      ...admission,
      configRevision: 5,
      accountProfileRevision: replacementBinding.profileRevision,
    });
    const changed = snapshotSymposiumSeatProvider(
      'symposium',
      'reviewer',
      work.facts,
      changedProfiles,
      hostGrants,
      identity,
      'default',
    );
    expect(changed.runtimeId).not.toBe(first.runtimeId);
    expect(() => first.verify()).toThrow(/Account configuration changed/i);
  });
  it('admits a pending seat before attaching its verified provider, then requires admission', () => {
    let currentAdmission: SymposiumAdmissionRecord | undefined;
    let currentMembership: SymposiumMembershipRecord = {
      ...membership,
      reconciliation: 'pending',
    };
    const facts: SymposiumDispatchFacts = {
      assertSymposiumArtifactWorkAllowed: () => {},
      getActiveSymposiumConfig: () => config,
      getLatestSymposiumMembership: () => currentMembership,
      getLatestSymposiumAdmission: () => currentAdmission,
      getSymposiumDelivery: () => undefined,
    };
    const identity = (name: string, id: string) => ({
      name,
      id,
      type: 'openai',
      workspace: 'default',
    });
    const snapshot = (phase: 'candidate' | 'retained' | 'reconciling' | 'confirmed') =>
      snapshotSymposiumSeatProvider(
        'symposium',
        'reviewer',
        facts,
        profiles,
        hostGrants,
        identity,
        'default',
        phase,
      );
    expect(snapshot('candidate').bindings).toEqual([
      { name: 'openai-work', id: 'openai-object', type: 'openai' },
    ]);
    expect(() => snapshot('reconciling')).toThrow(/admission/i);
    currentAdmission = { ...admission, decision: 'refused' };
    expect(() => snapshot('candidate')).toThrow(/admission/i);
    currentAdmission = { ...admission };
    expect(snapshot('reconciling').generation).toBe(2);
    expect(() => snapshot('confirmed')).toThrow(/membership/i);
    currentMembership = { ...membership };
    expect(snapshot('confirmed').generation).toBe(2);
    expect(() => snapshot('candidate')).toThrow(/membership/i);
    currentAdmission = undefined;
    const retained = snapshot('retained');
    expect(retained.generation).toBe(2);
    expect(() => snapshot('confirmed')).toThrow(/admission/i);
    currentAdmission = { ...admission, decision: 'refused' };
    expect(() => snapshot('retained')).toThrow(/admission/i);
    currentAdmission = { ...admission, membershipGeneration: 999 };
    expect(() => snapshot('retained')).toThrow(/admission/i);
    currentAdmission = undefined;
    currentMembership = { ...membership, reconciliation: 'pending' };
    expect(() => snapshot('retained')).toThrow(/membership/i);
    expect(() => retained.verify()).toThrow(/membership/i);
  });
  it('ignores a prior generation admission only while inspecting a restored candidate', () => {
    const personalProfiles = new AccountProfiles(
      [
        {
          id: 'personal',
          label: 'Personal',
          provider: 'openai-codex',
          nativeAuth: 'sandbox-chatgpt',
          email: 'personal@example.test',
          planType: 'plus',
          sandboxProvider: 'codex-personal',
          sandboxProviderId: 'codex-object',
          sandboxProviderType: 'codex',
          models: [{ id: 'luna', label: 'Luna' }],
        },
      ],
      { codexEnabled: true },
    );
    const cases = [
      { selectedSeat: seat, selectedProfiles: profiles, physicalType: 'openai' },
      {
        selectedSeat: {
          ...seat,
          model: 'luna',
          accountBinding: AccountBindingSchema.parse(personalProfiles.resolve('personal', 'luna')),
        },
        selectedProfiles: personalProfiles,
        physicalType: 'codex',
      },
    ];
    for (const { selectedSeat, selectedProfiles, physicalType } of cases) {
      let restored: SymposiumMembershipRecord = {
        ...membership,
        generation: 3,
        reconciliation: 'pending',
      };
      let currentAdmission = {
        ...admission,
        membershipGeneration: 1,
        provider: selectedSeat.accountBinding.provider,
        accountId: selectedSeat.accountBinding.accountId,
        model: selectedSeat.accountBinding.model,
        accountProfileRevision: selectedSeat.accountBinding.profileRevision,
      };
      const facts: SymposiumDispatchFacts = {
        assertSymposiumArtifactWorkAllowed: () => {},
        getActiveSymposiumConfig: () => ({ ...config, seats: [selectedSeat] }),
        getLatestSymposiumMembership: () => restored,
        getLatestSymposiumAdmission: () => currentAdmission,
        getSymposiumDelivery: () => undefined,
      };
      const snapshot = (phase: 'candidate' | 'reconciling' | 'retained' | 'confirmed') =>
        snapshotSymposiumSeatProvider(
          'symposium',
          'reviewer',
          facts,
          selectedProfiles,
          hostGrants,
          (name, id) => ({ name, id, type: physicalType, workspace: 'default' }),
          'default',
          phase,
        );
      expect(snapshot('candidate').generation).toBe(3);
      expect(() => snapshot('reconciling')).toThrow(/admission/i);
      restored = { ...restored, reconciliation: 'confirmed' };
      expect(() => snapshot('retained')).toThrow(/admission/i);
      expect(() => snapshot('confirmed')).toThrow(/admission/i);
      restored = { ...restored, reconciliation: 'pending' };
      currentAdmission = { ...currentAdmission, membershipGeneration: 3, decision: 'refused' };
      expect(() => snapshot('candidate')).toThrow(/admission/i);
      currentAdmission = { ...currentAdmission, decision: 'admitted', accountId: 'other-account' };
      expect(() => snapshot('candidate')).toThrow(/admission/i);
      currentAdmission = { ...currentAdmission, accountId: selectedSeat.accountBinding.accountId };
      expect(snapshot('reconciling').generation).toBe(3);
    }
  });
  it('does not create a pending seat sandbox until its provider admission is recorded', async () => {
    // The admission changes between the two ensure attempts in this test.
    let currentAdmission: SymposiumAdmissionRecord | undefined = undefined;
    const facts: SymposiumDispatchFacts = {
      assertSymposiumArtifactWorkAllowed: () => {},
      getActiveSymposiumConfig: () => config,
      getLatestSymposiumMembership: () => ({ ...membership, reconciliation: 'pending' }),
      getLatestSymposiumAdmission: () => currentAdmission,
      getSymposiumDelivery: () => undefined,
    };
    const ensure = vi.fn(async (runtimeId: string) => ({
      sandboxName: runtimeId,
      sandboxId: `physical:${runtimeId}`,
      workdir: '/sandbox/workspaces/mgmt',
    }));
    const owner = new SymposiumPerSeatSandboxOwner({
      sessionId: 'symposium',
      facts,
      profiles,
      hostGrants,
      seatSandboxRegistry: seatSandboxRegistry(),
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      perSeatSandboxVerified: true,
      managerFactory: () => ({ ensure }),
    });
    await expect(
      owner.ensure('symposium', 'reviewer', new AbortController().signal),
    ).rejects.toThrow(/admission/i);
    expect(ensure).not.toHaveBeenCalled();
    currentAdmission = { ...admission };
    await expect(
      owner.ensure('symposium', 'reviewer', new AbortController().signal),
    ).resolves.toMatchObject({ sandboxId: expect.stringMatching(/^physical:/) });
    expect(ensure).toHaveBeenCalledTimes(1);
  });
  it('stops the recorded physical sandbox after seat configuration changes', async () => {
    const work = fixture();
    const registry = seatSandboxRegistry();
    const stopped: string[] = [];
    let phase = 'Ready';
    const owner = new SymposiumPerSeatSandboxOwner({
      sessionId: 'symposium',
      facts: work.facts,
      profiles,
      hostGrants,
      seatSandboxRegistry: registry,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      perSeatSandboxVerified: true,
      managerFactory: () => ({
        ensure: async () => ({
          sandboxName: 'original',
          sandboxId: 'physical-1',
          workdir: '/sandbox/workspaces/mgmt',
        }),
        inspectReserved: async () => ({ id: 'physical-1', name: 'original', phase }),
        inspect: async (_runtimeId, physicalId) => {
          expect(physicalId).toBe('physical-1');
          return { id: physicalId, phase };
        },
        stop: async (runtimeId, physicalId) => {
          stopped.push(`${runtimeId}:${physicalId}`);
          phase = 'Stopped';
        },
      }),
    });
    await owner.ensure('symposium', 'reviewer', new AbortController().signal);
    const record = registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)!;
    work.setConfig({ ...config, seats: [] });
    await owner.stop('symposium', 'reviewer', 3, new AbortController().signal);
    expect(stopped).toEqual([`${record.runtimeId}:physical-1`]);
    expect(registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe('stopped');
    await owner.stop('symposium', 'reviewer', 3, new AbortController().signal);
    expect(stopped).toHaveLength(1);
  });
  it('keeps a late ensure quarantined until another worker physically stops it', async () => {
    const work = fixture();
    const registry = seatSandboxRegistry();
    let finishCreate!: () => void;
    let creationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      creationStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      finishCreate = resolve;
    });
    let phase = 'Ready';
    const stop = vi.fn(async () => {
      phase = 'Stopped';
    });
    const makeOwner = () =>
      new SymposiumPerSeatSandboxOwner({
        sessionId: 'symposium',
        facts: work.facts,
        profiles,
        hostGrants,
        seatSandboxRegistry: registry,
        resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
        runtimeConfig: {
          cli: 'openshell',
          cliContract: 'v0.1',
          image: 'image',
          policy: '/policy',
          seed: '/seed',
          serviceProviders: [],
          grantableServiceProviders: [],
          workspace: 'default',
          gateway: 'openshell',
          gatewayInsecure: false,
          createDetached: true,
          sandboxIdLength: 13,
          workdir: '/sandbox/workspaces/mgmt',
          webSearch: 'disabled',
        },
        readOnlyEnforced: { openaiApi: true, claudeVertex: false },
        perSeatSandboxVerified: true,
        managerFactory: () => ({
          ensure: async () => {
            creationStarted();
            await createGate;
            return {
              sandboxName: 'late-sandbox',
              sandboxId: 'late-physical',
              workdir: '/sandbox/workspaces/mgmt',
            };
          },
          inspectReserved: async () => ({ id: 'late-physical', name: 'late-sandbox', phase }),
          inspect: async () => ({ id: 'late-physical', phase }),
          stop,
        }),
      });
    const signal = new AbortController().signal;
    const create = makeOwner().ensure('symposium', 'reviewer', signal);
    await started;
    work.setConfig({ ...config, seats: [] });
    const stopping = makeOwner().stop('symposium', 'reviewer', 2, signal);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(stop).not.toHaveBeenCalled();
    finishCreate();
    await expect(create).rejects.toThrow(/no longer configured/);
    await stopping;
    expect(stop).toHaveBeenCalledOnce();
    expect(registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)).toMatchObject({
      physicalId: 'late-physical',
      state: 'stopped',
    });
  });
  it('keeps seat attachment closed without a verified per-seat capability', async () => {
    const work = fixture();
    const ensure = vi.fn();
    const owner = new SymposiumPerSeatSandboxOwner({
      sessionId: 'symposium',
      facts: work.facts,
      profiles,
      hostGrants,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      managerFactory: () => ({ ensure }),
    });
    expect(() => owner.ensure('symposium', 'reviewer', new AbortController().signal)).toThrow(
      /not verified/,
    );
    expect(ensure).not.toHaveBeenCalled();
  });
  it('serializes concurrent seat setup through one session-owned provider policy', async () => {
    const work = fixture();
    let inFlight = 0;
    let maxInFlight = 0;
    const configurations: Array<Record<string, unknown>> = [];
    const owner = new SymposiumSharedSandboxOwner({
      sessionId: 'symposium',
      facts: work.facts,
      profiles,
      hostGrants,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      managerFactory: (config) => {
        configurations.push(config as unknown as Record<string, unknown>);
        return {
          ensure: async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            config.verifyAccountProviderUnion?.();
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            return {
              sandboxName: 'shared',
              workdir: '/sandbox/workspaces/mgmt',
              cli: 'openshell',
              gateway: 'test-gateway',
              workspace: 'test-workspace',
              gatewayInsecure: false,
            };
          },
        };
      },
    });
    const signal = new AbortController().signal;
    await Promise.all([owner.ensure('symposium', signal), owner.ensure('symposium', signal)]);
    expect(maxInFlight).toBe(1);
    expect(configurations).toHaveLength(2);
    expect(configurations[0].accountProviderBindings).toEqual([
      { name: 'openai-work', type: 'openai', id: 'openai-object' },
    ]);
  });
  it('invalidates a cached provider union when the host account profile changes', () => {
    const work = fixture();
    let current = profiles;
    const union = snapshotSymposiumProviderUnion(
      'symposium',
      work.facts,
      () => current,
      hostGrants,
      (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      'default',
    );
    expect(union.verify).not.toThrow();
    current = new AccountProfiles([
      {
        id: 'work-api',
        label: 'Updated OpenAI',
        provider: 'openai',
        credentialRef: { provider: 'keychain', service: 'mitzo', account: 'updated' },
        sandboxProvider: 'openai-work',
        sandboxProviderId: 'openai-object',
        models: [{ id: 'gpt-test', label: 'Test' }],
      },
    ]);
    expect(union.verify).toThrow(/Account configuration changed/);
  });
  it('refuses an OpenAI account bound to a physical Vertex provider', () => {
    const work = fixture();
    expect(() =>
      snapshotSymposiumProviderUnion(
        'symposium',
        work.facts,
        profiles,
        hostGrants,
        (name, id) => ({ name, id, type: 'google-vertex-ai', workspace: 'default' }),
        'default',
      ),
    ).toThrow(/provider type/i);
  });
  it('refuses a claimed Claude read-only deployment without a verified native wrapper', () => {
    const work = fixture();
    expect(
      () =>
        new SymposiumSharedSandboxOwner({
          sessionId: 'symposium',
          facts: work.facts,
          profiles,
          hostGrants,
          resolveProviderIdentity: (name, id) => ({
            name,
            id,
            type: 'openai',
            workspace: 'default',
          }),
          runtimeConfig: {
            cli: 'openshell',
            image: 'image',
            policy: '/policy',
            seed: '/seed',
            serviceProviders: [],
            grantableServiceProviders: [],
            workspace: 'default',
            gateway: 'openshell',
            gatewayInsecure: false,
            createDetached: true,
            sandboxIdLength: 13,
            workdir: '/sandbox/workspaces/mgmt',
            webSearch: 'disabled',
          },
          readOnlyEnforced: { openaiApi: true, claudeVertex: true },
        }),
    ).toThrow(/Claude.*read-only/i);
  });
  it('loads actual gateway name, type, ID, and workspace without trusting account labels', () => {
    const resolve = createOpenShellProviderIdentityResolver(
      { cli: 'openshell', gateway: 'openshell', workspace: 'default', gatewayInsecure: false },
      () =>
        JSON.stringify([
          {
            name: 'openai-work',
            id: 'openai-object',
            type: 'openai',
            workspace: 'default',
            credential_keys: ['OPENAI_API_KEY'],
          },
        ]),
    );
    expect(resolve('openai-work', 'openai-object')).toEqual({
      name: 'openai-work',
      id: 'openai-object',
      type: 'openai',
      workspace: 'default',
    });
    expect(() => resolve('openai-work', 'replaced-id')).toThrow(/identity/i);
  });
  it('reads the 0.1 paginated workspace provider inventory', () => {
    const requests: string[][] = [];
    const resolve = createOpenShellProviderIdentityResolver(
      {
        cli: 'openshell',
        cliContract: 'v0.1',
        gateway: 'openshell',
        workspace: 'default',
        gatewayInsecure: false,
      },
      (args) => {
        requests.push([...args]);
        return args.includes('--page-token')
          ? JSON.stringify({
              providers: [
                { name: 'openai-work', id: 'openai-object', type: 'openai', workspace: 'default' },
              ],
              next_page_token: '',
            })
          : JSON.stringify({ providers: [], next_page_token: 'next' });
      },
    );
    expect(resolve('openai-work', 'openai-object').id).toBe('openai-object');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(
      expect.arrayContaining(['--workspace', 'default', '--page-token', 'next']),
    );
  });
  it('passes the page token to the default CLI runner', () => {
    const spawn = vi.fn((_cli: string, args: readonly string[]) => ({
      status: 0,
      stdout: args.includes('--page-token')
        ? JSON.stringify({
            providers: [
              { name: 'openai-work', id: 'openai-object', type: 'openai', workspace: 'default' },
            ],
            next_page_token: '',
          })
        : JSON.stringify({ providers: [], next_page_token: 'next' }),
    }));
    const resolve = createOpenShellProviderIdentityResolver(
      {
        cli: 'openshell',
        cliContract: 'v0.1',
        gateway: 'openshell',
        workspace: 'default',
        gatewayInsecure: false,
      },
      undefined,
      spawn as unknown as typeof import('node:child_process').spawnSync,
    );
    expect(resolve('openai-work', 'openai-object').id).toBe('openai-object');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][1]).toEqual(expect.arrayContaining(['--page-token', 'next']));
  });
  it('builds a runnable seat executor from one shared owner and exact receipt sink', async () => {
    const work = fixture();
    const accepted: string[] = [];
    const recordEvent = vi.fn();
    const consume = vi.fn();
    const runtime = createSymposiumSessionRuntime({
      applicationPolicy: {
        assertCurrent: () => undefined,
        consume,
        accepted: () => undefined,
        completed: () => undefined,
      },
      sessionId: 'symposium',
      store: { ...work.facts, ...seatSandboxRegistry() } as never,
      recordEvent,
      profiles,
      hostGrants,
      codexStore: {} as never,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      perSeatSandboxVerified: true,
      recordAccepted: ({ providerTurnId }) => {
        accepted.push(providerTurnId);
        return true;
      },
      managerFactory: () => ({
        ensure: async () => ({
          sandboxName: 'shared',
          sandboxId: 'physical-shared',
          workdir: '/sandbox/workspaces/mgmt',
        }),
      }),
      openNative: async () => ({
        run: async (_input, callbacks) => {
          callbacks.beforeDispatch();
          callbacks.accepted('thread', 'turn');
          return { providerThreadId: 'thread', content: 'done' };
        },
        cancel: async () => undefined,
      }),
    });
    await expect(runtime.executors.reviewer.execute(work.input)).resolves.toEqual({
      providerThreadId: 'thread',
      content: 'done',
    });
    expect(accepted).toEqual(['turn']);
    expect(consume).toHaveBeenCalledWith(work.input);
    expect(recordEvent).toHaveBeenCalledWith(work.input, { type: 'symposium_attempt_accepted' });
    expect(recordEvent).toHaveBeenCalledWith(work.input, { type: 'symposium_attempt_released' });
    expect(runtime.owner).toBeDefined();
  });
  it.each([false, true])(
    'drains all physical seats after cancellation failure (native failure %s)',
    async (nativeFailure) => {
      const work = fixture();
      const confirm = vi.fn();
      const runtime = createSymposiumSessionRuntime({
        sessionId: 'symposium',
        store: {
          ...work.facts,
          ...seatSandboxRegistry(),
          listSymposiumSessionSandboxes: () => [{ seatId: 'orphan', generation: 9 }],
          getSymposiumMembershipHistory: () => [
            { seatId: 'reviewer', generation: 2 },
            { seatId: 'other', generation: 1 },
          ],
          getUnsettledSymposiumSeatExecutions: (_session: string, seat: string) =>
            seat === 'reviewer'
              ? [
                  { claimToken: 'bad', attemptId: 'bad-attempt', idempotencyKey: 'bad-key' },
                  { claimToken: 'good', attemptId: 'good-attempt', idempotencyKey: 'good-key' },
                ]
              : [],
          confirmSymposiumAttemptCleanup: confirm,
        } as never,
        profiles,
        hostGrants,
        codexStore: {} as never,
        recordAccepted: () => true,
        resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
        runtimeConfig: {
          cli: 'openshell',
          cliContract: 'v0.1',
          image: 'image',
          policy: '/policy',
          seed: '/seed',
          serviceProviders: [],
          grantableServiceProviders: [],
          workspace: 'default',
          gateway: 'openshell',
          gatewayInsecure: false,
          createDetached: true,
          sandboxIdLength: 13,
          workdir: '/sandbox/workspaces/mgmt',
          webSearch: 'disabled',
        },
        readOnlyEnforced: { openaiApi: true, claudeVertex: false },
        perSeatSandboxVerified: true,
      });
      const executor = runtime.executors.reviewer as SymposiumOpenShellSeatExecutor;
      vi.spyOn(executor, 'drain').mockImplementation(async () => {
        if (nativeFailure) throw new Error('native failure');
      });
      let finish!: () => void;
      const cancel = vi.spyOn(executor, 'cancel').mockImplementation(async ({ claimToken }) => {
        if (claimToken === 'bad') throw new Error('cancel failed');
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      const stop = vi.spyOn(runtime.owner, 'stop').mockResolvedValue(undefined);
      const draining = runtime.drain(new AbortController().signal);
      const rejected = expect(draining).rejects.toThrow('cleanup incomplete');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(stop).not.toHaveBeenCalledWith('symposium', 'reviewer', 2, expect.anything());
      finish();
      await rejected;
      expect(stop).toHaveBeenCalledWith('symposium', 'reviewer', 2, expect.anything());
      expect(stop).toHaveBeenCalledWith('symposium', 'other', 1, expect.anything());
      expect(stop).toHaveBeenCalledWith('symposium', 'orphan', 9, expect.anything());
      expect(confirm.mock.calls).toEqual([['good-attempt', 'good-key']]);
    },
  );
  it('requires a current host-issued grant at the native boundary', () => {
    const { facts, input } = fixture();
    const verifier = {
      verifySeat: vi.fn(() => {
        throw new Error('Host grant revoked');
      }),
    };
    expect(() => admitSymposiumSeatDispatch(facts, profiles, input, verifier)).toThrow(
      'Host grant revoked',
    );
    expect(verifier.verifySeat).toHaveBeenCalledWith({
      sessionId: input.sessionId,
      seat: input.seat,
      membershipGeneration: 2,
    });
  });
  it('binds the real recipient to an explicit account provider and read-only route', () => {
    const { facts, input } = fixture();
    expect(admitSymposiumSeatDispatch(facts, profiles, input, hostGrants)).toEqual({
      kind: 'openai-api',
      provider: 'openai-work',
      providerId: 'openai-object',
      model: 'gpt-test',
      effort: null,
      readOnly: true,
    });
  });
  it('rejects revocation or provider refusal that happens after the earlier claim', () => {
    const work = fixture();
    work.setMembership({
      ...membership,
      generation: 3,
      state: 'suspended',
      reconciliation: 'pending',
    });
    expect(() => admitSymposiumSeatDispatch(work.facts, profiles, work.input, hostGrants)).toThrow(
      /membership/i,
    );
    work.setMembership({ ...membership });
    work.setAdmission({ ...admission, decision: 'refused' });
    expect(() => admitSymposiumSeatDispatch(work.facts, profiles, work.input, hostGrants)).toThrow(
      /admission/i,
    );
  });
  it('rejects a prompt or recipient that differs from the durably approved delivery', () => {
    const { facts, input } = fixture();
    expect(() =>
      admitSymposiumSeatDispatch(
        facts,
        profiles,
        {
          ...input,
          content: 'Aggregate conversation the seat never received',
        },
        hostGrants,
      ),
    ).toThrow(/recipient delivery/i);
    expect(() =>
      admitSymposiumSeatDispatch(
        facts,
        profiles,
        {
          ...input,
          idempotencyKey: 'another-attempt',
        },
        hostGrants,
      ),
    ).toThrow(/recipient delivery/i);
  });
  it('refuses native budgeted dispatch until a trusted provider cost reservation exists', () => {
    const work = fixture();
    work.setConfig({ ...config, turnRules: { mode: 'budgeted', maxTurns: 3, budgetUsd: 1 } });
    expect(() => admitSymposiumSeatDispatch(work.facts, profiles, work.input, hostGrants)).toThrow(
      /cost reservation/i,
    );
  });
  it('never resumes the old native thread after restore or binding replacement', () => {
    const { input } = fixture();
    expect(symposiumSeatRuntimeId(input)).not.toBe(
      symposiumSeatRuntimeId({
        ...input,
        provenance: { ...input.provenance, membershipGeneration: 3 },
      }),
    );
    expect(symposiumSeatRuntimeId(input)).not.toBe(
      symposiumSeatRuntimeId({
        ...input,
        seat: { ...input.seat, authorityGrant: { ...seat.authorityGrant, revision: 2 } },
      }),
    );
  });
  it('routes a Vertex Claude seat without ever returning host ADC material', () => {
    const work = fixture();
    const claudeSeat = {
      ...seat,
      model: 'claude-test',
      accountBinding: AccountBindingSchema.parse(profiles.resolve('work-vertex', 'claude-test')),
    };
    work.setConfig({ ...config, seats: [claudeSeat] });
    work.setAdmission({
      ...admission,
      provider: 'anthropic-vertex',
      accountId: 'work-vertex',
      model: 'claude-test',
      accountProfileRevision: claudeSeat.accountBinding.profileRevision,
    });
    const route = admitSymposiumSeatDispatch(
      work.facts,
      profiles,
      {
        ...work.input,
        seat: claudeSeat,
        provenance: {
          ...work.input.provenance,
          accountBinding: claudeSeat.accountBinding,
          accountProfileRevision: claudeSeat.accountBinding.profileRevision,
        },
      },
      hostGrants,
    );
    expect(route).toMatchObject({
      kind: 'claude-vertex',
      provider: 'vertex-work',
      providerId: 'vertex-object',
    });
    expect(JSON.stringify(route)).not.toContain('/host/adc.json');
  });
});

describe('per-seat artifact admission', () => {
  function setup(
    access: ArtifactAccess,
    options: {
      failMount?: boolean;
      failCreate?: boolean;
      failDriverConfig?: boolean;
      failManager?: boolean;
      failFinalCapability?: boolean;
      creationFence?: boolean;
      revokeBeforeDispatch?: boolean;
    } = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), 'symposium-owner-artifact-'));
    const lifecycle = new SymposiumWorkspaceLifecycle(join(root, 'fence.json'), () => {});
    const request: ArtifactLeaseRequest = {
      sessionId: 'symposium',
      workspaceId: 'default',
      seatId: 'reviewer',
      volumeName: 'symposium-artifacts',
      volumeGeneration: 'gen-1',
      driver: 'podman',
      access,
    };
    const labels = {
      'openshell.ai/sandbox-attachable': 'true',
      'openshell.ai/sandbox-attachable-workspace': 'default',
      'mitzo.symposium.purpose': 'artifacts',
      'mitzo.symposium.session': 'symposium',
      'mitzo.symposium.workspace': 'default',
      'mitzo.symposium.generation': 'gen-1',
    };
    const verifyMount = vi.fn(async () => {
      if (options.failMount) throw new Error('physical mount mismatch');
    });
    const verifyDeleted = vi.fn(async () => {});
    const host = new SqliteArtifactLeaseHost(
      join(root, 'leases.sqlite'),
      {
        verifyGateway: async () => {
          if (options.failDriverConfig) throw new Error('driver config unavailable');
        },
        verifyMount,
        verifyDeleted,
      },
      async () => [{ Name: request.volumeName, Driver: 'local', Options: {}, Labels: labels }],
    );
    const ensure = vi.fn(async (runtimeId: string) => {
      if (options.failCreate) throw new Error('create response lost');
      return {
        sandboxName: sandboxNameForConversation(runtimeId, 13),
        sandboxId: 'physical-1',
        workdir: '/sandbox/workspaces/mgmt',
      };
    });
    const configurations: BoundOpenShellRuntimeConfig[] = [];
    const registry = seatSandboxRegistry();
    let phase: 'Ready' | 'Stopped' | 'Absent' = 'Ready';
    const stop = vi.fn(async () => {
      phase = 'Stopped';
    });
    const remove = vi.fn(async () => {
      phase = 'Absent';
    });
    let rejectDispatch = false;
    let capabilityChecks = 0;
    let artifactReady = true;
    const owner = () =>
      new SymposiumPerSeatSandboxOwner({
        sessionId: 'symposium',
        facts: fixture().facts,
        profiles,
        hostGrants,
        seatSandboxRegistry: registry,
        resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
        runtimeConfig: {
          cli: 'openshell',
          cliContract: 'v0.1',
          image: 'image',
          policy: '/policy',
          seed: '/seed',
          serviceProviders: [],
          grantableServiceProviders: [],
          workspace: 'default',
          gateway: 'openshell',
          gatewayInsecure: false,
          createDetached: true,
          sandboxIdLength: 13,
          workdir: '/sandbox/workspaces/mgmt',
          webSearch: 'disabled',
        },
        readOnlyEnforced: { openaiApi: true, claudeVertex: false },
        perSeatSandboxVerified: true,
        verifyHostCapability: () => {
          capabilityChecks += 1;
          if (rejectDispatch) {
            rejectDispatch = false;
            throw new Error('seat revoked at dispatch');
          }
          if (options.failFinalCapability && capabilityChecks === 2)
            throw new Error('host capability changed');
          return {
            attestedProviderInstances: new Map([
              [
                'openai-work',
                {
                  id: 'openai-object',
                  type: 'openai',
                  profileName: 'openai',
                  workspace: 'default',
                },
              ],
            ]),
          };
        },
        runSandboxCreation: options.creationFence ? lifecycle.create : undefined,
        artifactLeaseHost: host,
        artifactRequest: (_session, _seat, _generation, purpose) => {
          if (!artifactReady && purpose !== 'cleanup')
            throw new Error('Artifact admission blocked');
          return request;
        },
        managerFactory: (config) => {
          if (options.failManager) throw new Error('manager construction failed');
          configurations.push(config);
          return {
            ensure: options.creationFence
              ? async (runtimeId) => {
                  rejectDispatch = Boolean(options.revokeBeforeDispatch);
                  config.beforeSandboxCreate?.();
                  return ensure(runtimeId);
                }
              : ensure,
            inspect: async (_runtimeId: string, physicalId: string) =>
              phase === 'Absent' ? undefined : { id: physicalId, phase },
            inspectReserved: async (runtimeId: string) =>
              phase === 'Absent'
                ? undefined
                : {
                    id: 'physical-1',
                    name: sandboxNameForConversation(runtimeId, 13),
                    phase,
                  },
            stop,
            delete: remove,
          };
        },
      });
    return {
      root,
      request,
      host,
      owner,
      ensure,
      verifyMount,
      verifyDeleted,
      stop,
      remove,
      registry,
      configurations,
      lifecycle,
      setArtifactReady: (ready: boolean) => {
        artifactReady = ready;
      },
      setPhase: (next: typeof phase) => {
        phase = next;
      },
    };
  }

  for (const access of ['writer', 'reviewer'] as const) {
    it(`attests and retains the ${access} mount on an exact retry`, async () => {
      const state = setup(access);
      try {
        await state.owner().ensure('symposium', 'reviewer', new AbortController().signal);
        await state.owner().ensure('symposium', 'reviewer', new AbortController().signal);
        expect(state.configurations).toHaveLength(2);
        expect(state.configurations[0].artifactDriverConfig).toEqual({
          podman: {
            mounts: [
              {
                type: 'volume',
                source: state.request.volumeName,
                target: '/sandbox/workspaces/mgmt',
                read_only: access === 'reviewer',
              },
            ],
          },
        });
        expect(state.verifyMount).toHaveBeenCalledWith(
          expect.any(String),
          'physical-1',
          state.configurations[0].artifactDriverConfig,
        );
      } finally {
        state.host.close();
        rmSync(state.root, { recursive: true, force: true });
      }
    });
  }

  it.each(['provider attachment changed', 'provider identity changed'])(
    'revalidates retained Ready seats and rejects %s',
    async (message) => {
      const state = setup('writer');
      try {
        await state.owner().ensure('symposium', 'reviewer', new AbortController().signal);
        const record = state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)!;
        const markStarted = vi.spyOn(state.host, 'markCreationStarted');
        state.ensure.mockRejectedValueOnce(new Error(message));
        await expect(
          state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
        ).rejects.toThrow(message);
        expect(state.ensure).toHaveBeenLastCalledWith(record.runtimeId, expect.anything(), {
          sandboxName: record.sandboxName,
          sandboxId: record.physicalId,
        });
        expect(markStarted).not.toHaveBeenCalled();
        expect(record.state).toBe('ready');
      } finally {
        state.host.close();
        rmSync(state.root, { recursive: true, force: true });
      }
    },
  );

  it.each(['lease', 'seat', 'lease-after-write', 'seat-after-write'] as const)(
    'recovers only local markers when %s persistence rejects before dispatch',
    async (target) => {
      const state = setup('writer', { creationFence: true });
      try {
        const original = target.startsWith('lease')
          ? state.host.markCreationStarted.bind(state.host)
          : state.registry.markSymposiumSeatSandboxCreationStarted.bind(state.registry);
        const spy = target.startsWith('lease')
          ? vi.spyOn(state.host, 'markCreationStarted')
          : vi.spyOn(state.registry, 'markSymposiumSeatSandboxCreationStarted');
        spy.mockImplementationOnce((...args: unknown[]) => {
          if (target.endsWith('after-write')) (original as (...args: unknown[]) => void)(...args);
          throw new Error('local marker failed');
        });
        await expect(
          state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
        ).rejects.toThrow('local marker failed');
        expect(state.ensure).not.toHaveBeenCalled();
        await expect(state.lifecycle.cleanup(async () => 'available')).resolves.toBe('available');
        spy.mockRestore();
        await expect(
          state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
        ).resolves.toMatchObject({ sandboxId: 'physical-1' });
      } finally {
        state.host.close();
        rmSync(state.root, { recursive: true, force: true });
      }
    },
  );

  it('rolls back local intent when final dispatch verification rejects before gateway creation', async () => {
    const options = { creationFence: true, revokeBeforeDispatch: true };
    const state = setup('writer', options);
    try {
      await expect(
        state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
      ).rejects.toThrow('seat revoked at dispatch');
      expect(state.ensure).not.toHaveBeenCalled();
      await expect(state.lifecycle.cleanup(async () => 'available')).resolves.toBe('available');
      options.revokeBeforeDispatch = false;
      await expect(
        state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
      ).resolves.toMatchObject({ sandboxId: 'physical-1' });
    } finally {
      state.host.close();
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('does not roll back local intent when the workspace uncertainty write fails', async () => {
    const state = setup('writer', { creationFence: true });
    try {
      mkdirSync(join(state.root, 'fence.json'));
      await expect(
        state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
      ).rejects.toThrow();
      expect(state.ensure).not.toHaveBeenCalled();
      expect(
        state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.creationStarted,
      ).toBe(true);
      await expect(state.lifecycle.cleanup(async () => 'available')).rejects.toThrow('recovery');
    } finally {
      state.host.close();
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('retains a local recovery block if undispatched marker rollback fails', async () => {
    const state = setup('writer', { creationFence: true });
    try {
      vi.spyOn(state.registry, 'markSymposiumSeatSandboxCreationStarted').mockImplementationOnce(
        () => {
          throw new Error('local write failed');
        },
      );
      vi.spyOn(state.host, 'rollbackUndispatchedCreation').mockImplementationOnce(() => {
        throw new Error('rollback failed');
      });
      await expect(
        state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
      ).rejects.toThrow('rollback failed');
      expect(state.ensure).not.toHaveBeenCalled();
      await expect(state.lifecycle.cleanup(async () => 'available')).resolves.toBe('available');
      await expect(
        state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
      ).rejects.toThrow();
      expect(state.ensure).not.toHaveBeenCalled();
    } finally {
      state.host.close();
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('retains a closed lease when creation loses its response or mount proof fails', async () => {
    for (const options of [{ failCreate: true }, { failMount: true }]) {
      const state = setup('writer', options);
      try {
        await expect(
          state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
        ).rejects.toThrow(options.failCreate ? 'create response lost' : 'physical mount mismatch');
        await expect(
          state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
        ).rejects.toThrow('reservation changed');
        expect(state.ensure).toHaveBeenCalledTimes(1);
      } finally {
        state.host.close();
        rmSync(state.root, { recursive: true, force: true });
      }
    }
  });

  it.each([
    ['failDriverConfig', 'driver config unavailable'],
    ['failManager', 'manager construction failed'],
    ['failFinalCapability', 'host capability changed'],
  ] as const)('releases the never-started writer after %s', async (failure, message) => {
    const options = { [failure]: true };
    const state = setup('writer', options);
    try {
      await expect(
        state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
      ).rejects.toThrow(message);
      expect(state.ensure).not.toHaveBeenCalled();
      options[failure] = false;
      expect(state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)).toMatchObject({
        state: 'reserved',
        creationStarted: false,
      });
      state.setPhase('Absent');
      await state.owner().stop('symposium', 'reviewer', 2, new AbortController().signal);
      expect(state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe(
        'stopped',
      );
      await expect(
        acquireSymposiumArtifactLease(state.host, { ...state.request, seatId: 'next' }),
      ).resolves.toMatchObject({ request: { seatId: 'next' } });
    } finally {
      state.host.close();
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('quarantines a started writer when the seat registry still says unstarted', async () => {
    const state = setup('writer', { failDriverConfig: true });
    try {
      await expect(
        state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
      ).rejects.toThrow('driver config unavailable');
      const record = state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)!;
      const lease = await state.host.reserve(state.request);
      state.host.markCreationStarted(
        lease.token,
        lease.revision,
        sandboxNameForConversation(record.runtimeId, 13),
      );
      state.setPhase('Absent');
      await expect(
        state.owner().stop('symposium', 'reviewer', 2, new AbortController().signal),
      ).rejects.toThrow('creation may be in flight');
      expect(state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe(
        'reserved',
      );
      await expect(
        acquireSymposiumArtifactLease(state.host, { ...state.request, seatId: 'next' }),
      ).rejects.toThrow('already has a writer');
    } finally {
      state.host.close();
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('retains cleanup identity after artifact readiness is revoked', async () => {
    const state = setup('writer');
    try {
      const owner = state.owner();
      await owner.ensure('symposium', 'reviewer', new AbortController().signal);
      state.setArtifactReady(false);
      await expect(
        owner.ensure('symposium', 'reviewer', new AbortController().signal),
      ).rejects.toThrow('Artifact admission blocked');
      await owner.stop('symposium', 'reviewer', 2, new AbortController().signal);
      expect(state.remove).toHaveBeenCalledOnce();
      expect(state.verifyDeleted).toHaveBeenCalledOnce();
      expect(state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe(
        'stopped',
      );
    } finally {
      state.host.close();
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('deletes the exact stopped sandbox before releasing the writer for rotation', async () => {
    const state = setup('writer');
    try {
      const owner = state.owner();
      await owner.ensure('symposium', 'reviewer', new AbortController().signal);
      const record = state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)!;
      await owner.stop('symposium', 'reviewer', 2, new AbortController().signal);
      expect(state.stop).toHaveBeenCalledWith(record.runtimeId, 'physical-1', expect.anything());
      expect(state.remove).toHaveBeenCalledWith(record.runtimeId, 'physical-1', expect.anything());
      expect(state.verifyDeleted).toHaveBeenCalledWith(record.sandboxName, 'physical-1');
      expect(state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe(
        'stopped',
      );
      await expect(
        acquireSymposiumArtifactLease(state.host, { ...state.request, seatId: 'next' }),
      ).resolves.toMatchObject({ request: { seatId: 'next' } });
    } finally {
      state.host.close();
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('does not silently replace a missing artifact lease for a live Ready sandbox', async () => {
    const state = setup('writer');
    try {
      await state.owner().ensure('symposium', 'reviewer', new AbortController().signal);
      const leases = new Database(join(state.root, 'leases.sqlite'));
      try {
        leases.prepare('DELETE FROM symposium_artifact_leases').run();
      } finally {
        leases.close();
      }
      const reserve = vi.spyOn(state.host, 'reserve');
      await expect(
        state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
      ).rejects.toThrow(/unavailable/);
      expect(reserve).not.toHaveBeenCalled();
      expect(state.ensure).toHaveBeenCalledTimes(1);
      expect(state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe(
        'ready',
      );
    } finally {
      state.host.close();
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('retries stop after lease release succeeds but lifecycle confirmation fails', async () => {
    const state = setup('writer');
    try {
      await state.owner().ensure('symposium', 'reviewer', new AbortController().signal);
      const confirm = vi
        .spyOn(state.registry, 'confirmSymposiumSeatSandboxStopped')
        .mockImplementationOnce(() => {
          throw new Error('lifecycle commit failed');
        });
      await expect(
        state.owner().stop('symposium', 'reviewer', 2, new AbortController().signal),
      ).rejects.toThrow('lifecycle commit failed');
      expect(state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe(
        'ready',
      );
      const reserve = vi.spyOn(state.host, 'reserve');
      await expect(
        state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
      ).rejects.toThrow(/cleanup|unavailable/);
      expect(reserve).not.toHaveBeenCalled();
      expect(state.ensure).toHaveBeenCalledTimes(1);
      await state.owner().stop('symposium', 'reviewer', 2, new AbortController().signal);
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe(
        'stopped',
      );
      expect(state.remove).toHaveBeenCalledOnce();
      const replacement = await acquireSymposiumArtifactLease(state.host, {
        ...state.request,
        seatId: 'next',
      });
      await state.owner().stop('symposium', 'reviewer', 2, new AbortController().signal);
      expect(await state.host.inspectLease(replacement.token)).toEqual(replacement);
    } finally {
      state.host.close();
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('uses the durable physical identity after discovering a reserved sandbox', async () => {
    const state = setup('writer');
    try {
      const owner = state.owner();
      await owner.ensure('symposium', 'reviewer', new AbortController().signal);
      const record = state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)!;
      const sandboxName = record.sandboxName;
      // Simulate a crash after the artifact lease was bound but before the
      // seat registry committed its physical identity.
      record.sandboxName = null;
      record.physicalId = null;
      record.state = 'reserved';
      await owner.stop('symposium', 'reviewer', 2, new AbortController().signal);
      expect(state.remove).toHaveBeenCalledWith(record.runtimeId, 'physical-1', expect.anything());
      expect(state.verifyDeleted).toHaveBeenCalledWith(sandboxName, 'physical-1');
      expect(state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe(
        'stopped',
      );
      await expect(
        acquireSymposiumArtifactLease(state.host, { ...state.request, seatId: 'next' }),
      ).resolves.toMatchObject({ request: { seatId: 'next' } });
    } finally {
      state.host.close();
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('retains the writer and retries absence proof when deletion is uncertain', async () => {
    const state = setup('writer');
    try {
      const owner = state.owner();
      await owner.ensure('symposium', 'reviewer', new AbortController().signal);
      state.remove.mockRejectedValueOnce(new Error('gateway deletion uncertain'));
      await expect(
        owner.stop('symposium', 'reviewer', 2, new AbortController().signal),
      ).rejects.toThrow('gateway deletion uncertain');
      expect(state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe(
        'ready',
      );
      await expect(
        acquireSymposiumArtifactLease(state.host, { ...state.request, seatId: 'next' }),
      ).rejects.toThrow('already has a writer');
      await owner.stop('symposium', 'reviewer', 2, new AbortController().signal);
      expect(state.stop).toHaveBeenCalledOnce();
      expect(state.remove).toHaveBeenCalledTimes(2);
    } finally {
      state.host.close();
      rmSync(state.root, { recursive: true, force: true });
    }
  });
});

describe('mixed personal subscription and work seat isolation', () => {
  it('pins three distinct native providers and blocks personal creation without private auth evidence', async () => {
    const personal = new AccountProfiles(
      [
        {
          id: 'personal',
          label: 'Personal',
          provider: 'openai-codex',
          nativeAuth: 'sandbox-chatgpt',
          email: 'personal@example.test',
          planType: 'plus',
          sandboxProvider: 'codex-personal',
          sandboxProviderId: 'codex-object',
          sandboxProviderType: 'codex',
          models: [{ id: 'luna', label: 'Luna' }],
        },
      ],
      { codexEnabled: true },
    );
    const selectedProfiles = {
      resume: (binding: typeof seat.accountBinding) =>
        (binding.accountId === 'personal' ? personal : profiles).resume(binding),
      apiProfile: profiles.apiProfile.bind(profiles),
      vertexSandboxRoute: profiles.vertexSandboxRoute.bind(profiles),
      codexProfile: personal.codexProfile.bind(personal),
    } as AccountProfiles;
    const seats = [
      seat,
      {
        ...seat,
        id: 'claude',
        model: 'claude-test',
        accountBinding: AccountBindingSchema.parse(profiles.resolve('work-vertex', 'claude-test')),
      },
      {
        ...seat,
        id: 'personal',
        model: 'luna',
        accountBinding: AccountBindingSchema.parse(personal.resolve('personal', 'luna')),
      },
    ];
    const facts: SymposiumDispatchFacts = {
      ...fixture().facts,
      assertSymposiumArtifactWorkAllowed: () => {},
      getActiveSymposiumConfig: () => ({ ...config, seats }),
      getLatestSymposiumMembership: (_sessionId, seatId) => ({ ...membership, seatId }),
      getLatestSymposiumAdmission: (_sessionId, seatId) => {
        const binding = seats.find((candidate) => candidate.id === seatId)!.accountBinding;
        return {
          ...admission,
          seatId,
          provider: binding.provider,
          accountId: binding.accountId,
          model: binding.model,
          accountProfileRevision: binding.profileRevision,
        };
      },
    };
    const identities = (name: string, id: string) => ({
      name,
      id,
      workspace: 'default',
      type:
        name === 'codex-personal'
          ? 'codex'
          : name === 'vertex-work'
            ? 'google-vertex-ai'
            : 'openai',
    });
    const snapshots = seats.map((selected) =>
      snapshotSymposiumSeatProvider(
        'symposium',
        selected.id,
        facts,
        selectedProfiles,
        hostGrants,
        identities,
        'default',
      ),
    );
    expect(new Set(snapshots.map((snapshot) => snapshot.runtimeId)).size).toBe(3);
    expect(snapshots.map((snapshot) => snapshot.bindings)).toEqual([
      [{ name: 'openai-work', id: 'openai-object', type: 'openai' }],
      [{ name: 'vertex-work', id: 'vertex-object', type: 'google-vertex-ai' }],
      [{ name: 'codex-personal', id: 'codex-object', type: 'codex' }],
    ]);
    expect(snapshots[2].account).toEqual({
      kind: 'chatgpt-subscription-native',
      provider: 'codex-personal',
      providerId: 'codex-object',
      providerType: 'codex',
      model: 'luna',
    });
    const configurations: BoundOpenShellRuntimeConfig[] = [];
    const managerFactory = vi.fn((configuration: BoundOpenShellRuntimeConfig) => {
      configurations.push(configuration);
      return {
        ensure: async (runtimeId: string) => ({
          sandboxName: runtimeId,
          sandboxId: `id:${runtimeId}`,
          workdir: '/sandbox/workspaces/mgmt',
        }),
      };
    });
    const deps = {
      sessionId: 'symposium',
      facts,
      profiles: selectedProfiles,
      hostGrants,
      seatSandboxRegistry: seatSandboxRegistry(),
      resolveProviderIdentity: identities,
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1' as const,
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled' as const,
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      perSeatSandboxVerified: true,
      managerFactory,
    };
    await expect(
      new SymposiumPerSeatSandboxOwner(deps).ensure(
        'symposium',
        'personal',
        new AbortController().signal,
      ),
    ).rejects.toThrow('private credential proof are unavailable');
    expect(managerFactory).not.toHaveBeenCalled();
    const owner = new SymposiumPerSeatSandboxOwner({
      ...deps,
      verifiedSubscriptionControllerCommand: ['/usr/local/bin/symposium-subscription-app-server'],
      verifySubscriptionPrivateAuth: async () => {},
    });
    await expect(owner.ensure('symposium', 'claude', new AbortController().signal)).rejects.toThrow(
      'Owned Vertex seat policy unavailable',
    );
    const sandboxes = await Promise.all(
      seats
        .filter((selected) => selected.id !== 'claude')
        .map((selected) => owner.ensure('symposium', selected.id, new AbortController().signal)),
    );
    expect(new Set(sandboxes.map((sandbox) => sandbox.sandboxName)).size).toBe(2);
    expect(configurations.map((configuration) => configuration.accountProviderBindings)).toEqual([
      snapshots[0].bindings,
      snapshots[2].bindings,
    ]);
    expect(configurations[1].account.kind).toBe('chatgpt-subscription-native');
    const incompleteRegistry = seatSandboxRegistry();
    let stopped = false;
    const postCreate = vi.fn(
      async (configuration: BoundOpenShellRuntimeConfig, runtimeId: string) => {
        configuration.beforeSandboxCreate!();
        configuration.onSandboxCreateSettled!({
          sandboxName: sandboxNameForConversation(runtimeId, 13),
          sandboxId: 'terminal-id',
          workspace: 'default',
          owner: 'mock-owner',
          accountProvider: 'codex-personal',
        });
        configuration.onSandboxCreationPhase?.('upload');
        throw new Error('upload failed');
      },
    );
    let phasedCustody = true;
    const phasedDeps = {
      ...deps,
      verifyHostCapability: () => {
        if (!phasedCustody) throw new Error('custody lost');
        return undefined as never;
      },
      seatSandboxRegistry: incompleteRegistry,
      verifiedSubscriptionControllerCommand: ['/usr/local/bin/symposium-subscription-app-server'],
      verifySubscriptionPrivateAuth: async () => {},
      runSandboxCreation: async <T>(
        _verify: () => void,
        operation: (dispatch: () => void, settled?: () => void) => Promise<T>,
      ) =>
        operation(
          () => {},
          () => {},
        ),
      managerFactory: (configuration: BoundOpenShellRuntimeConfig) => ({
        ensure: (runtimeId: string) => postCreate(configuration, runtimeId),
        inspect: async () => ({
          id: 'terminal-id',
          phase: stopped ? ('Stopped' as const) : ('Ready' as const),
        }),
        inspectReserved: async () => undefined,
        stop: async () => {
          stopped = true;
        },
      }),
    };
    const phased = new SymposiumPerSeatSandboxOwner(phasedDeps);
    await expect(
      phased.ensure('symposium', 'personal', new AbortController().signal),
    ).rejects.toThrow('upload failed');
    const incomplete = incompleteRegistry.getSymposiumSeatSandbox(
      'symposium',
      'personal',
      membership.generation,
    )!;
    expect(phased.creationDiagnostic('personal')).toEqual({
      phase: 'upload',
      code: 'SEAT_UPLOAD_FAILED',
      canCleanup: true,
    });
    phasedCustody = false;
    expect(() => phased.assertCreationCleanup('personal', membership.generation)).toThrow(
      'custody lost',
    );
    expect(phased.creationDiagnostic('personal')?.canCleanup).toBe(false);
    phasedCustody = true;
    expect(incomplete).toMatchObject({
      state: 'reserved',
      physicalId: 'terminal-id',
      creationCompleted: true,
    });
    await expect(
      phased.ensure('symposium', 'personal', new AbortController().signal),
    ).rejects.toThrow('explicit cleanup');
    expect(postCreate).toHaveBeenCalledOnce();
    await expect(
      new SymposiumPerSeatSandboxOwner(phasedDeps).stop(
        'symposium',
        'personal',
        membership.generation,
        new AbortController().signal,
      ),
    ).rejects.toThrow('retained terminal');
    await phased.stop('symposium', 'personal', membership.generation, new AbortController().signal);
    expect(
      incompleteRegistry.getSymposiumSeatSandbox('symposium', 'personal', membership.generation)
        ?.state,
    ).toBe('stopped');

    // A lease-binding rejection must not erase successful native create proof.
    const artifactRoot = mkdtempSync(join(tmpdir(), 'terminal-before-bind-'));
    const artifactPath = join(artifactRoot, 'leases.sqlite');
    const artifactRequest: ArtifactLeaseRequest = {
      sessionId: 'symposium',
      workspaceId: 'default',
      seatId: 'personal',
      volumeName: 'symposium-artifacts',
      volumeGeneration: 'gen-1',
      driver: 'podman',
      access: 'reviewer',
    };
    let deleted = false;
    stopped = false;
    const artifactHost = new SqliteArtifactLeaseHost(
      artifactPath,
      {
        verifyGateway: async () => {},
        verifyMount: async () => {},
        verifyDeleted: async () => {
          expect(deleted).toBe(true);
        },
      },
      async () => [
        {
          Name: artifactRequest.volumeName,
          Driver: 'local',
          Options: {},
          Labels: {
            'openshell.ai/sandbox-attachable': 'true',
            'openshell.ai/sandbox-attachable-workspace': 'default',
            'mitzo.symposium.purpose': 'artifacts',
            'mitzo.symposium.session': 'symposium',
            'mitzo.symposium.workspace': 'default',
            'mitzo.symposium.generation': 'gen-1',
          },
        },
      ],
    );
    const workspace = new SymposiumWorkspaceLifecycle(join(artifactRoot, 'fence.json'), () => {});
    const failedRegistry = seatSandboxRegistry();
    const bind = vi.spyOn(artifactHost, 'bindSandbox');
    bind.mockImplementationOnce(() => {
      throw Error('binding rejected before persistence');
    });
    const artifactOwner = new SymposiumPerSeatSandboxOwner({
      ...phasedDeps,
      seatSandboxRegistry: failedRegistry,
      artifactLeaseHost: artifactHost,
      artifactRequest: () => artifactRequest,
      runSandboxCreation: workspace.create,
      managerFactory: (configuration) => ({
        ...phasedDeps.managerFactory(configuration),
        inspect: async () =>
          deleted
            ? undefined
            : { id: 'terminal-id', phase: stopped ? ('Stopped' as const) : ('Ready' as const) },
        delete: async () => {
          deleted = true;
        },
      }),
    });
    try {
      const unreferencedReader = new SymposiumPerSeatSandboxOwner({
        ...phasedDeps,
        seatSandboxRegistry: seatSandboxRegistry(),
        artifactLeaseHost: artifactHost,
        artifactRequest: () => ({ ...artifactRequest, readerAdmissionId: 'reader-1' }),
      });
      await expect(
        unreferencedReader.ensure('symposium', 'personal', new AbortController().signal),
      ).rejects.toThrow('Current confirmed sealed reader reference required');
      await expect(
        artifactOwner.ensure('symposium', 'personal', new AbortController().signal),
      ).rejects.toThrow('binding rejected before persistence');
      const saved = failedRegistry.getSymposiumSeatSandbox(
        'symposium',
        'personal',
        membership.generation,
      )!;
      expect(saved).toMatchObject({
        state: 'reserved',
        physicalId: 'terminal-id',
        creationCompleted: true,
      });
      expect(artifactOwner.creationDiagnostic('personal')?.canCleanup).toBe(true);
      const leaseDb = new Database(artifactPath);
      try {
        expect(
          leaseDb
            .prepare('SELECT creation_started,sandbox_id FROM symposium_artifact_leases')
            .get(),
        ).toEqual({ creation_started: 1, sandbox_id: null });
        await workspace.drain(new AbortController().signal);
        await artifactOwner.stop(
          'symposium',
          'personal',
          membership.generation,
          new AbortController().signal,
        );
        expect(deleted).toBe(true);
        expect(
          leaseDb.prepare('SELECT count(*) AS n FROM symposium_artifact_leases').get(),
        ).toEqual({ n: 0 });
        expect(
          failedRegistry.getSymposiumSeatSandbox('symposium', 'personal', membership.generation)
            ?.state,
        ).toBe('stopped');
        expect(bind).toHaveBeenCalledTimes(2);
      } finally {
        leaseDb.close();
      }
    } finally {
      artifactHost.close();
      rmSync(artifactRoot, { recursive: true, force: true });
    }

    expect(() =>
      snapshotSymposiumSeatProvider(
        'symposium',
        'personal',
        facts,
        selectedProfiles,
        hostGrants,
        (name, id) => ({ name, id, type: 'openai-codex-oauth', workspace: 'default' }),
        'default',
      ),
    ).toThrow('physical provider type');
  });
});

it('retains the recovery claim when the production stop path times out before a late remote stop', async () => {
  const { EventStore } = await import('../event-store.js');
  const root = mkdtempSync(join(tmpdir(), 'cleanup-timeout-'));
  const store = new EventStore(join(root, 'events.sqlite'));
  const personal = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'Personal',
        provider: 'openai-codex',
        nativeAuth: 'sandbox-chatgpt',
        email: 'personal@example.test',
        planType: 'plus',
        sandboxProvider: 'codex-personal',
        sandboxProviderId: 'codex-object',
        sandboxProviderType: 'codex',
        models: [{ id: 'luna', label: 'Luna' }],
      },
    ],
    { codexEnabled: true },
  );
  const selectedSeat = {
    ...seat,
    model: 'luna',
    accountBinding: AccountBindingSchema.parse(personal.resolve('personal', 'luna')),
  };
  let remoteStopped = false;
  const stop = vi.fn(async () => {
    throw new Error('CLI timeout after gateway dispatch');
  });
  try {
    store.upsertSession({ sessionId: 'symposium', accountBinding: selectedSeat.accountBinding });
    store.setSymposiumConfig('symposium', { ...config, seats: [selectedSeat] });
    store.transitionSymposiumMembership({
      sessionId: 'symposium',
      seatId: 'reviewer',
      action: 'admit',
      expectedGeneration: 0,
      configRevision: 4,
      actor: 'director',
      reason: 'initial',
      idempotencyKey: 'initial',
      occurredAt: 1,
    });
    store.markSymposiumMembershipReconciled('symposium', 'reviewer', 1, 'confirmed');
    store.recordSymposiumAdmission({
      ...admission,
      membershipGeneration: 1,
      provider: 'openai-codex',
      accountId: 'personal',
      model: 'luna',
      accountProfileRevision: selectedSeat.accountBinding.profileRevision,
    });
    const runtime = createSymposiumSessionRuntime({
      sessionId: 'symposium',
      store,
      profiles: personal,
      hostGrants,
      codexStore: {} as never,
      recordAccepted: () => true,
      verifiedSubscriptionControllerCommand: ['/usr/local/bin/symposium-subscription-app-server'],
      verifySubscriptionPrivateAuth: async () => {},
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'codex', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      perSeatSandboxVerified: true,
      runSandboxCreation: async (_verify, operation) =>
        operation(
          () => {},
          () => {},
        ),
      managerFactory: (configuration) => ({
        ensure: async (runtimeId) => {
          configuration.beforeSandboxCreate!();
          configuration.onSandboxCreateSettled!({
            sandboxName: sandboxNameForConversation(runtimeId, 13),
            sandboxId: 'terminal-id',
            workspace: 'default',
            owner: 'mock-owner',
            accountProvider: 'codex-personal',
          });
          configuration.onSandboxCreationPhase?.('upload');
          throw new Error('upload failed');
        },
        inspect: async () => ({ id: 'terminal-id', phase: remoteStopped ? 'Stopped' : 'Ready' }),
        inspectReserved: async () => undefined,
        stop,
      }),
    });
    await expect(
      runtime.owner.ensure('symposium', 'reviewer', new AbortController().signal),
    ).rejects.toThrow('upload failed');
    const input = {
      sessionId: 'symposium',
      seatId: 'reviewer',
      expectedRevision: 4,
      expectedGeneration: 1,
      actor: 'operator:old',
      idempotencyKey: 'cleanup',
    };
    await expect(runtime.orchestrator.recoverCreation(input)).rejects.toThrow('cleanup incomplete');
    expect(stop).toHaveBeenCalledOnce();
    remoteStopped = true; // The gateway finishes after the local CLI timeout.
    await expect(runtime.orchestrator.recoverCreation(input)).rejects.toThrow(/execut/i);
    const auth = store.getSymposiumCreationRecoveryAuthorization(input)!;
    await expect(
      runtime.orchestrator.reauthorizeCreationRecovery({
        ...input,
        actor: 'operator:new',
        idempotencyKey: 'handoff',
        operationId: auth.operationId,
        expectedAuthorizationRevision: 0,
      }),
    ).rejects.toThrow(/execut/i);
    expect(store.getSymposiumSeatSandbox('symposium', 'reviewer', 1)?.state).toBe('reserved');
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe('trusted durable native review transport observer', () => {
  async function setupObserver(
    observer: NonNullable<
      import('../symposium-codex-native.js').OpenAiCodexSeatInput['observeDurableReviewToolResult']
    >,
  ) {
    const { EventStore } = await import('../event-store.js');
    const { CodexConversationStore } = await import('../codex-conversation-store.js');
    const work = fixture();
    const abortController = new AbortController();
    work.input.signal = abortController.signal;
    const route = admitSymposiumSeatDispatch(work.facts, profiles, work.input, hostGrants);
    work.input.provenance = {
      ...work.input.provenance,
      version: 3,
      artifact: {
        version: 1,
        kind: 'sealed_reader',
        readerAdmissionId: 'reader-admission',
        artifactGenerationId: 'generation',
        sealFenceId: 'fence',
        bindingDigest: 'a'.repeat(64),
      },
    };
    const root = registryDirectory();
    const eventPath = join(root, 'events.db');
    const events = new EventStore(eventPath);
    const db = new Database(eventPath);
    db.pragma('foreign_keys = OFF'); // isolated synthetic row setup only
    // Offline synthetic execution setup; real durable readers/registry/replay are tested,
    // not physical admission or real controller acceptance.
    db.prepare(
      `INSERT INTO symposium_recipient_attempts
      (delivery_id,seat_id,attempt_number,idempotency_key,claim_token,symposium_provenance,status,
       provider_thread_id,provider_turn_id,started_at,updated_at)
      VALUES (?,?,?,?,?,?,'executing','thread-1','turn-1',1,1)`,
    ).run(
      work.input.deliveryId,
      work.input.seat.id,
      1,
      work.input.idempotencyKey,
      work.input.claimToken,
      JSON.stringify(work.input.provenance),
    );
    const registry = new SymposiumAttemptRegistry(join(root, 'registry.db'));
    const sandbox = { sandboxName: 'offline-review', workdir: '/sandbox/workspaces/mgmt' };
    registry.reserve({
      sessionId: work.input.sessionId,
      claimToken: work.input.claimToken,
      sandbox,
      artifact:
        'version' in work.input.provenance && work.input.provenance.version === 3
          ? work.input.provenance.artifact
          : undefined,
    });
    const store = new CodexConversationStore(join(root, 'codex.db'));
    const conversationId = symposiumSeatRuntimeId(work.input);
    const binding = work.input.seat.accountBinding!;
    store.create(conversationId, binding, sandbox.workdir, null, 'symposium');
    const args = { pageIndex: 1, previousChallenge: 'a'.repeat(64) };
    const identity = {
      turnId: 'turn-1',
      toolName: 'SymposiumReadSealedReviewPage',
      requestHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
    };
    db.prepare('UPDATE symposium_recipient_attempts SET dispatched_content=?,dispatch_seq=0').run(
      work.input.content,
    );
    const result = { content: 'exact synthetic tool result', isError: false };
    store.enqueue(conversationId, binding, {
      id: work.input.claimToken,
      prompt: work.input.content,
    });
    store.claimNext(conversationId, binding);
    store.claimTool(conversationId, binding, work.input.claimToken, 'call-1', identity);
    store.recordToolResult(
      conversationId,
      binding,
      work.input.claimToken,
      'call-1',
      identity,
      result,
    );
    let options!: import('../codex-conversation.js').CodexConversationOptions;
    const original = vi.fn(async () => undefined);
    let current = true;
    const confirmStopped = vi.fn(async () => {
      registry.markConfirmed(work.input.claimToken);
    });
    const native = await createOpenAiCodexSeat({
      sandbox,
      route,
      execution: work.input,
      store,
      attemptRegistry: registry,
      resolveAttempt: (token) => events.getSymposiumRecipientAttemptByClaimToken(token),
      profileTools: {
        tools: [],
        instructions: '',
        executeTool: async () => result,
        onToolResultDurable: original,
      },
      testConfirmStopped: confirmStopped,
      observeDurableReviewToolResult: observer,
      assertDurableReviewToolCurrent: () => {
        if (!current) throw new Error('Reader provider/profile/grant no longer current');
      },
      createConversation: (opts) => {
        options = opts;
        return {
          initialize: async () => undefined,
          getThreadId: () => 'thread-1',
          send: async () => undefined,
          interrupt: async () => undefined,
          close() {},
        };
      },
    });
    options.onProviderAccepted!(work.input.claimToken, 'thread-1', 'turn-1');
    return {
      native,
      abortController,
      confirmStopped,
      setOwnerCurrent: (value: boolean) => {
        current = value;
      },
      work,
      events,
      registry,
      store,
      db,
      options,
      args,
      result,
      original,
      invoke: () =>
        options.onToolResultDurable!('SymposiumReadSealedReviewPage', args, result, {
          turnId: 'turn-1',
          callId: 'call-1',
        }),
      close: () => {
        events.close();
        registry.close();
        store.close();
        db.close();
      },
    };
  }
  it('notifies only after the original callback and real retained replay/accepted identity agree', async () => {
    const observer = vi.fn();
    const f = await setupObserver(observer);
    try {
      await f.invoke();
      expect(f.original).toHaveBeenCalledOnce();
      expect(observer).toHaveBeenCalledOnce();
      expect(f.original.mock.invocationCallOrder[0]).toBeLessThan(
        observer.mock.invocationCallOrder[0],
      );
    } finally {
      f.close();
    }
  });
  it('never notifies when the actual original owner callback rejects', async () => {
    const observer = vi.fn();
    const f = await setupObserver(observer);
    try {
      f.original.mockRejectedValueOnce(new Error('owner rejection'));
      await expect(f.invoke()).rejects.toThrow('owner rejection');
      expect(observer).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it.each(['claim', 'turn', 'replay', 'terminal', 'controller', 'uncertain'])(
    'refuses %s drift before notifying and permanently vetoes retry',
    async (drift) => {
      const observer = vi.fn();
      const f = await setupObserver(observer);
      try {
        if (drift === 'uncertain') f.registry.markUncertain(f.work.input.claimToken);
        if (drift === 'controller') f.registry.markConfirmed(f.work.input.claimToken);
        if (drift === 'claim')
          f.db.prepare("UPDATE symposium_recipient_attempts SET status='failed'").run();
        if (drift === 'turn')
          f.db
            .prepare("UPDATE symposium_recipient_attempts SET provider_turn_id='different'")
            .run();
        if (drift === 'replay') f.result.content = 'changed';
        if (drift === 'terminal')
          f.registry.observations.terminal({
            claimToken: f.work.input.claimToken,
            providerThreadId: 'thread-1',
            providerTurnId: 'turn-1',
            status: 'completed',
          });
        await expect(f.invoke()).rejects.toThrow();
        expect(observer).not.toHaveBeenCalled();
        f.db
          .prepare(
            "UPDATE symposium_recipient_attempts SET status='executing',provider_turn_id='turn-1'",
          )
          .run();
        await expect(f.invoke()).rejects.toThrow('permanently vetoed');
      } finally {
        f.close();
      }
    },
  );
  it('freezes observer payload and rechecks actual claim after an awaited observer', async () => {
    const observer = vi.fn(async (event) => {
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.arguments)).toBe(true);
      expect(Object.isFrozen(event.result)).toBe(true);
      await Promise.resolve();
      f.db.prepare("UPDATE symposium_recipient_attempts SET status='cancelled'").run();
    });
    const f: Awaited<ReturnType<typeof setupObserver>> = await setupObserver(observer);
    try {
      await expect(f.invoke()).rejects.toThrow('identity');
      expect(observer).toHaveBeenCalledOnce();
      await expect(f.invoke()).rejects.toThrow('permanently vetoed');
    } finally {
      f.close();
    }
  });
  it('observer failure cannot be retried as a new observation', async () => {
    const observer = vi.fn().mockRejectedValueOnce(new Error('transport lost'));
    const f = await setupObserver(observer);
    try {
      await expect(f.invoke()).rejects.toThrow('transport lost');
      await expect(f.invoke()).rejects.toThrow('permanently vetoed');
      expect(observer).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });
  it('paired provider/profile/grant revocation during observer await permanently vetoes subsequent work', async () => {
    const observer = vi.fn(async () => {
      await Promise.resolve();
      f.setOwnerCurrent(false);
    });
    const f: Awaited<ReturnType<typeof setupObserver>> = await setupObserver(observer);
    try {
      await expect(f.invoke()).rejects.toThrow('no longer current');
      f.setOwnerCurrent(true);
      await expect(f.invoke()).rejects.toThrow('permanently vetoed');
      expect(observer).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });
  it('live owner loss during the original callback prevents observer notification', async () => {
    const observer = vi.fn();
    const f = await setupObserver(observer);
    try {
      f.original.mockImplementationOnce(async () => {
        await Promise.resolve();
        f.setOwnerCurrent(false);
      });
      await expect(f.invoke()).rejects.toThrow('no longer current');
      expect(observer).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it('rejects observer construction without a paired live owner capability before conversation creation', async () => {
    const work = fixture();
    const createConversation = vi.fn();
    await expect(
      createOpenAiCodexSeat({
        sandbox: { sandboxName: 'offline-unlaunched', workdir: '/sandbox/workspaces/mgmt' },
        route: admitSymposiumSeatDispatch(work.facts, profiles, work.input, hostGrants),
        execution: work.input,
        store: {} as never,
        profileTools: {
          tools: [],
          instructions: '',
          executeTool: async () => ({ content: '', isError: true }),
          onToolResultDurable: () => undefined,
        },
        observeDurableReviewToolResult: () => undefined,
        createConversation,
      }),
    ).rejects.toThrow('paired current owner capability');
    expect(createConversation).not.toHaveBeenCalled();
  });
  it('does not publish favorable completion while an actual durable observer remains in flight', async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await setupObserver(async () => {
      started();
      await held;
      throw new Error('late observer failure');
    });
    let outcome = 'pending';
    try {
      const running = f.native.run(f.work.input, { beforeDispatch() {}, accepted() {} });
      void running.then(
        () => {
          outcome = 'favorable';
        },
        () => {
          outcome = 'refused';
        },
      );
      const observation = Promise.resolve(f.invoke());
      void observation.catch(() => undefined);
      await entered;
      f.options.onProviderTerminal!(f.work.input.claimToken, 'turn-1', 'completed');
      f.options.onProviderComplete!(f.work.input.claimToken, 'completed');
      f.options.emit({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'synthetic favorable output' }] },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(outcome).toBe('pending');
      expect(f.registry.checkpoints.get(f.work.input.claimToken)).toBeUndefined();
      release();
      await expect(observation).rejects.toThrow('late observer failure');
      await expect(running).rejects.toThrow();
    } finally {
      release();
      f.close();
    }
  });

  it('aborts an unresolved observer barrier after confirmed stop without a favorable checkpoint', async () => {
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await setupObserver(async () => {
      started();
      await held;
    });
    try {
      const running = f.native.run(f.work.input, { beforeDispatch() {}, accepted() {} });
      void running.catch(() => undefined);
      const observation = Promise.resolve(f.invoke());
      void observation.catch(() => undefined);
      await entered;
      f.options.onProviderTerminal!(f.work.input.claimToken, 'turn-1', 'completed');
      f.options.onProviderComplete!(f.work.input.claimToken, 'completed');
      await new Promise((resolve) => setImmediate(resolve));
      f.abortController.abort(new Error('existing execution deadline'));
      await expect(running).rejects.toThrow('existing execution deadline');
      expect(f.registry.get(f.work.input.claimToken)?.state).toBe('confirmed');
      expect(f.registry.checkpoints.get(f.work.input.claimToken)).toBeUndefined();
      release();
      await expect(observation).rejects.toThrow();
    } finally {
      release();
      f.close();
    }
  });
  it('rejects a new durable callback after closure begins and joins the original tracked callback', async () => {
    let entered!: () => void;
    let release!: () => void;
    let stopping!: () => void;
    let stopped!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stoppingPromise = new Promise<void>((resolve) => {
      stopping = resolve;
    });
    const stopHold = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const observer = vi.fn(async () => {
      entered();
      await held;
    });
    const f = await setupObserver(observer);
    f.confirmStopped.mockImplementation(async () => {
      stopping();
      await stopHold;
      f.registry.markConfirmed(f.work.input.claimToken);
    });
    try {
      const running = f.native.run(f.work.input, { beforeDispatch() {}, accepted() {} });
      void running.catch(() => undefined);
      const original = Promise.resolve(f.invoke());
      void original.catch(() => undefined);
      await enteredPromise;
      f.options.onProviderTerminal!(f.work.input.claimToken, 'turn-1', 'completed');
      f.options.onProviderComplete!(f.work.input.claimToken, 'completed');
      await stoppingPromise;
      await expect(f.invoke()).rejects.toThrow('completion fence');
      expect(observer).toHaveBeenCalledOnce();
      release();
      await expect(original).rejects.toThrow('permanently vetoed');
      stopped();
      await expect(running).rejects.toThrow();
      expect(f.registry.checkpoints.get(f.work.input.claimToken)).toBeUndefined();
    } finally {
      release();
      stopped();
      f.close();
    }
  });
  it('revalidates paired owner currentness after stop confirmation even when observer already settled', async () => {
    const f = await setupObserver(() => undefined);
    try {
      await f.invoke();
      f.confirmStopped.mockImplementation(async () => {
        await Promise.resolve();
        f.setOwnerCurrent(false);
        f.registry.markConfirmed(f.work.input.claimToken);
      });
      const running = f.native.run(f.work.input, { beforeDispatch() {}, accepted() {} });
      void running.catch(() => undefined);
      f.options.onProviderTerminal!(f.work.input.claimToken, 'turn-1', 'completed');
      f.options.onProviderComplete!(f.work.input.claimToken, 'completed');
      f.options.emit({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'synthetic output' }] },
      });
      await expect(running).rejects.toThrow('no longer current');
      expect(f.registry.checkpoints.get(f.work.input.claimToken)).toBeUndefined();
    } finally {
      f.close();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SymposiumConfig } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import {
  SymposiumOrchestrator,
  type SymposiumSeatExecutor,
  type SymposiumSeatExecution,
} from '../symposium-orchestrator.js';

const config: SymposiumConfig = {
  version: 1,
  revision: 3,
  state: 'active',
  seats: [
    {
      id: 'builder',
      name: 'Builder',
      role: 'primary',
      model: 'model-a',
      systemPrompt: 'Build.',
      color: '#8040cc',
      accountBinding: {
        accountId: 'work-builder',
        accountLabel: 'Work Builder',
        provider: 'openai-codex',
        model: 'model-a',
        profileRevision: 'account-1',
      },
      profileBinding: { profileId: 'builder', profileRevision: 'profile-1' },
      contextGrant: {
        grantId: 'context-builder',
        revision: 4,
        classification: 'work',
        sourceRefs: ['repo:mitzo'],
      },
      authorityGrant: {
        grantId: 'authority-builder',
        revision: 5,
        filesystem: 'write',
        tools: 'write',
        network: 'restricted',
      },
      isolationRequest: {
        trustDomainId: 'symposium-shared',
        revision: 2,
        placement: 'reuse-compatible',
      },
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      role: 'reviewer',
      model: 'model-b',
      systemPrompt: 'Review.',
      color: '#008888',
      accountBinding: {
        accountId: 'work-reviewer',
        accountLabel: 'Work Reviewer',
        provider: 'anthropic-vertex',
        model: 'model-b',
        profileRevision: 'account-2',
      },
      profileBinding: { profileId: 'reviewer', profileRevision: 'profile-2' },
      contextGrant: {
        grantId: 'context-reviewer',
        revision: 6,
        classification: 'work',
        sourceRefs: ['repo:mitzo'],
      },
      authorityGrant: {
        grantId: 'authority-reviewer',
        revision: 7,
        filesystem: 'read',
        tools: 'read',
        network: 'restricted',
      },
      isolationRequest: {
        trustDomainId: 'symposium-shared',
        revision: 2,
        placement: 'reuse-compatible',
      },
    },
  ],
  turnRules: { mode: 'directed', maxTurns: 4 },
  interceptMode: 'manual',
};

class FakeExecutor implements SymposiumSeatExecutor {
  calls: SymposiumSeatExecution[] = [];
  cancellations: string[] = [];
  cancellationThreadIds: Array<string | undefined> = [];
  private threadCount = 0;
  private results = new Map<
    string,
    { providerThreadId: string; content: string; costUsd: number }
  >();

  async execute(input: SymposiumSeatExecution) {
    this.calls.push(input);
    const prior = this.results.get(input.idempotencyKey);
    if (prior) return prior;
    this.threadCount += input.providerThreadId ? 0 : 1;
    const result = {
      providerThreadId:
        input.providerThreadId ??
        `thread-${input.seat.id}${this.threadCount === 1 ? '' : `-${this.threadCount}`}`,
      content: `${input.seat.id}: ${input.content}`,
      costUsd: 0.01,
    };
    this.results.set(input.idempotencyKey, result);
    return result;
  }

  async cancel(input: { providerThreadId?: string; idempotencyKey: string }) {
    this.cancellations.push(input.idempotencyKey);
    this.cancellationThreadIds.push(input.providerThreadId);
  }
}

let dir: string;
let dbPath: string;
let store: EventStore;
let builder: FakeExecutor;
let reviewer: FakeExecutor;
let orchestrator: SymposiumOrchestrator;

function openStore() {
  const opened = new EventStore(dbPath);
  opened.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
  if (opened.getSession('chat')?.sessionType !== 'symposium') {
    opened.setSymposiumConfig('chat', config);
  }
  return opened;
}

function createOrchestrator() {
  return new SymposiumOrchestrator({
    store,
    executors: { builder, reviewer },
    idFactory: (() => {
      let value = 0;
      return () => `delivery-${++value}`;
    })(),
    claimIdFactory: (() => {
      let value = 0;
      return () => `claim-${++value}`;
    })(),
    now: () => 1_700_000_000_000,
  });
}

function admit(seatId: 'builder' | 'reviewer', decision: 'admitted' | 'refused' = 'admitted') {
  return orchestrator.recordProviderAdmission({
    sessionId: 'chat',
    seatId,
    decision,
    reason: decision === 'admitted' ? 'Director accepted shared boundary' : 'Not approved',
    idempotencyKey: `admit-${seatId}-${decision}`,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mitzo-symposium-'));
  dbPath = join(dir, 'events.db');
  store = openStore();
  builder = new FakeExecutor();
  reviewer = new FakeExecutor();
  orchestrator = createOrchestrator();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SymposiumOrchestrator', () => {
  it('routes three v2 seats by stable IDs and revokes queued approvals before dispatch', async () => {
    const implementerSeat = {
      ...config.seats[1],
      id: 'implementer',
      role: 'implementer' as const,
      name: 'Implementer',
      accountBinding: { ...config.seats[1].accountBinding!, provider: 'openai-codex' as const },
    };
    store.setSymposiumConfig('chat', {
      ...config,
      version: 2,
      revision: 4,
      anchorSeatId: 'builder',
      activeSeatCap: 3,
      seats: [config.seats[1], implementerSeat, config.seats[0]],
    });
    const impl = new FakeExecutor();
    orchestrator = new SymposiumOrchestrator({
      store,
      executors: { builder, reviewer, implementer: impl },
      now: () => 123,
      stopSeat: async () => {},
      reconcileProviders: async () => {},
    });
    const move = (seatId: string, action: 'admit' | 'suspend', expectedGeneration: number) =>
      orchestrator.transitionMembership({
        sessionId: 'chat',
        seatId,
        action,
        expectedGeneration,
        configRevision: 4,
        actor: 'director',
        reason: action,
        idempotencyKey: `${seatId}:${action}`,
      });
    for (const seatId of ['builder', 'reviewer', 'implementer']) {
      await move(seatId, 'admit', 0);
      orchestrator.recordProviderAdmission({
        sessionId: 'chat',
        seatId,
        decision: 'admitted',
        reason: 'Approved',
        idempotencyKey: `admit:${seatId}`,
      });
      await orchestrator.reconcileMembership('chat', seatId, 1);
    }
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer', 'implementer'],
      originalContent: 'Do work',
      idempotencyKey: 'v2-work',
    });
    expect(staged.recipientSeatIds).toEqual(['reviewer', 'implementer']);
    await move('reviewer', 'suspend', 1);
    expect(() =>
      orchestrator.intervene({
        deliveryId: staged.deliveryId,
        action: 'approve',
        idempotencyKey: 'late-approval',
      }),
    ).toThrow();
    expect((await orchestrator.deliver(staged.deliveryId)).recipients[0].status).not.toBe(
      'delivered',
    );
    expect(reviewer.calls).toHaveLength(0);
  });
  it('retains a late result as audit evidence without reviving a suspended recipient', async () => {
    store.setSymposiumConfig('chat', {
      ...config,
      version: 2,
      revision: 4,
      anchorSeatId: 'builder',
      activeSeatCap: 2,
    });
    let release!: (result: { providerThreadId: string; content: string; costUsd: number }) => void;
    reviewer.execute = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    orchestrator = new SymposiumOrchestrator({
      store,
      executors: { builder, reviewer },
      now: () => 123,
      stopSeat: async () => {},
      reconcileProviders: async () => {},
    });
    for (const seatId of ['builder', 'reviewer']) {
      await orchestrator.transitionMembership({
        sessionId: 'chat',
        seatId,
        action: 'admit',
        expectedGeneration: 0,
        configRevision: 4,
        actor: 'director',
        reason: 'start',
        idempotencyKey: `membership:${seatId}`,
      });
      orchestrator.recordProviderAdmission({
        sessionId: 'chat',
        seatId,
        decision: 'admitted',
        reason: 'approved',
        idempotencyKey: `admission:${seatId}`,
      });
      await orchestrator.reconcileMembership('chat', seatId, 1);
    }
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'Review',
      idempotencyKey: 'late-stage',
    });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'approve',
      idempotencyKey: 'late-approve',
    });
    const pending = orchestrator.deliver(staged.deliveryId);
    await vi.waitFor(() => expect(reviewer.execute).toHaveBeenCalledOnce());
    await orchestrator.transitionMembership({
      sessionId: 'chat',
      seatId: 'reviewer',
      action: 'suspend',
      expectedGeneration: 1,
      configRevision: 4,
      actor: 'director',
      reason: 'pause',
      idempotencyKey: 'suspend:reviewer',
    });
    release({ providerThreadId: 'late-thread', content: 'Late answer', costUsd: 0.7 });
    await pending;
    expect(store.getSymposiumDelivery(staged.deliveryId)?.status).toBe('cancelled');
    expect(store.getSymposiumLateResults(staged.deliveryId)).toEqual([
      expect.objectContaining({ seatId: 'reviewer', resultContent: 'Late answer', costUsd: 0.7 }),
    ]);
    expect(store.getSymposiumDelivery(staged.deliveryId)?.recipients[0].resultContent).toBeNull();
    expect(store.getSymposiumUsage('chat')).toMatchObject({ attempts: 1, costUsd: 0.7 });
  });
  it('keeps uncertain admission blocked across restart until explicit reconciliation succeeds', async () => {
    store.setSymposiumConfig('chat', {
      ...config,
      version: 2,
      revision: 4,
      anchorSeatId: 'builder',
      activeSeatCap: 2,
    });
    orchestrator = new SymposiumOrchestrator({
      store,
      executors: { builder, reviewer },
      reconcileProviders: async () => {
        throw new Error('provider state unknown');
      },
    });
    const uncertain = await orchestrator.transitionMembership({
      sessionId: 'chat',
      seatId: 'builder',
      action: 'admit',
      expectedGeneration: 0,
      configRevision: 4,
      actor: 'director',
      reason: 'start',
      idempotencyKey: 'admit-builder',
    });
    expect(uncertain.reconciliation).toBe('pending');
    orchestrator.recordProviderAdmission({
      sessionId: 'chat',
      seatId: 'builder',
      decision: 'admitted',
      idempotencyKey: 'provider-builder',
    });
    expect((await orchestrator.reconcileMembership('chat', 'builder', 1)).reconciliation).toBe(
      'recovery_required',
    );
    store.close();
    store = new EventStore(dbPath);
    orchestrator = new SymposiumOrchestrator({
      store,
      executors: { builder, reviewer },
      reconcileProviders: async () => {},
    });
    expect((await orchestrator.reconcileMembership('chat', 'builder', 1)).reconciliation).toBe(
      'confirmed',
    );
    expect(store.getLatestSymposiumAdmission('chat', 'builder', 4)?.membershipGeneration).toBe(1);
  });
  it('does not attach a provider before explicit current-generation approval', async () => {
    store.setSymposiumConfig('chat', {
      ...config,
      version: 2,
      revision: 4,
      anchorSeatId: 'builder',
      activeSeatCap: 2,
    });
    const reconcileProviders = vi.fn(async () => {});
    orchestrator = new SymposiumOrchestrator({
      store,
      executors: { builder, reviewer },
      reconcileProviders,
    });
    const pending = await orchestrator.transitionMembership({
      sessionId: 'chat',
      seatId: 'builder',
      action: 'admit',
      expectedGeneration: 0,
      configRevision: 4,
      actor: 'director',
      reason: 'start',
      idempotencyKey: 'membership-builder',
    });
    expect(pending.reconciliation).toBe('pending');
    expect(reconcileProviders).not.toHaveBeenCalled();
    await expect(orchestrator.reconcileMembership('chat', 'builder', 1)).rejects.toThrow(
      /admission/i,
    );
    expect(reconcileProviders).not.toHaveBeenCalled();
    orchestrator.recordProviderAdmission({
      sessionId: 'chat',
      seatId: 'builder',
      decision: 'refused',
      idempotencyKey: 'refused-builder',
    });
    await expect(orchestrator.reconcileMembership('chat', 'builder', 1)).rejects.toThrow(
      /admission/i,
    );
    expect(reconcileProviders).not.toHaveBeenCalled();
  });
  it('keeps the original anchor usable when a reviewer is lazily added at a new revision', async () => {
    store.upsertSession({ sessionId: 'fresh', accountBinding: config.seats[0].accountBinding });
    store.setSymposiumConfig('fresh', {
      ...config,
      version: 2,
      revision: 1,
      anchorSeatId: 'builder',
      activeSeatCap: 2,
      seats: [config.seats[0]],
    });
    orchestrator = new SymposiumOrchestrator({
      store,
      executors: { builder, reviewer },
      reconcileProviders: async () => {},
    });
    await orchestrator.transitionMembership({
      sessionId: 'fresh',
      seatId: 'builder',
      action: 'admit',
      expectedGeneration: 0,
      configRevision: 1,
      actor: 'director',
      reason: 'start',
      idempotencyKey: 'builder-member',
    });
    orchestrator.recordProviderAdmission({
      sessionId: 'fresh',
      seatId: 'builder',
      decision: 'admitted',
      idempotencyKey: 'builder-admission-v1',
    });
    await orchestrator.reconcileMembership('fresh', 'builder', 1);
    store.setSymposiumConfig('fresh', {
      ...config,
      version: 2,
      revision: 2,
      anchorSeatId: 'builder',
      activeSeatCap: 2,
    });
    await orchestrator.transitionMembership({
      sessionId: 'fresh',
      seatId: 'reviewer',
      action: 'admit',
      expectedGeneration: 0,
      configRevision: 2,
      actor: 'director',
      reason: 'add reviewer',
      idempotencyKey: 'reviewer-member',
    });
    orchestrator.recordProviderAdmission({
      sessionId: 'fresh',
      seatId: 'reviewer',
      decision: 'admitted',
      idempotencyKey: 'reviewer-admission',
    });
    await orchestrator.reconcileMembership('fresh', 'reviewer', 1);
    orchestrator.recordProviderAdmission({
      sessionId: 'fresh',
      seatId: 'builder',
      decision: 'admitted',
      idempotencyKey: 'builder-admission-v2',
    });
    const staged = orchestrator.stageDelivery({
      sessionId: 'fresh',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'Review this',
      idempotencyKey: 'new-review',
    });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'approve',
      idempotencyKey: 'approved',
    });
    expect((await orchestrator.deliver(staged.deliveryId)).status).toBe('delivered');
  });
  it('frees a denied pending seat after confirmed removal without attaching its provider', async () => {
    const implementer = { ...config.seats[1], id: 'implementer', role: 'implementer' };
    store.setSymposiumConfig('chat', {
      ...config,
      version: 2,
      revision: 4,
      anchorSeatId: 'builder',
      activeSeatCap: 2,
      seats: [...config.seats, implementer],
    });
    const reconcileProviders = vi.fn(async () => {});
    orchestrator = new SymposiumOrchestrator({
      store,
      executors: { builder, reviewer },
      stopSeat: async () => {},
      reconcileProviders,
    });
    const move = (seatId: string, action: 'admit' | 'remove', expectedGeneration: number) =>
      orchestrator.transitionMembership({
        sessionId: 'chat',
        seatId,
        action,
        expectedGeneration,
        configRevision: 4,
        actor: 'director',
        reason: action,
        idempotencyKey: `${seatId}:${action}`,
      });
    await move('builder', 'admit', 0);
    orchestrator.recordProviderAdmission({
      sessionId: 'chat',
      seatId: 'builder',
      decision: 'admitted',
      idempotencyKey: 'approve-builder',
    });
    await orchestrator.reconcileMembership('chat', 'builder', 1);
    await move('reviewer', 'admit', 0);
    orchestrator.recordProviderAdmission({
      sessionId: 'chat',
      seatId: 'reviewer',
      decision: 'refused',
      idempotencyKey: 'deny-reviewer',
    });
    expect(store.getSymposiumRequiredProviders('chat')).toEqual(['openai-codex']);
    expect(reconcileProviders).toHaveBeenCalledTimes(1);
    expect((await move('reviewer', 'remove', 1)).reconciliation).toBe('confirmed');
    expect(reconcileProviders).toHaveBeenLastCalledWith({
      sessionId: 'chat',
      requiredProviders: ['openai-codex'],
    });
    expect((await move('implementer', 'admit', 0)).state).toBe('active');
    expect(store.getSymposiumMembershipHistory('chat', 'reviewer')).toMatchObject([
      { reconciliation: 'pending' },
      { reconciliation: 'confirmed' },
    ]);
  });
  it('serializes a late admission reconcile ahead of revoked-seat cleanup', async () => {
    store.setSymposiumConfig('chat', {
      ...config,
      version: 2,
      revision: 4,
      anchorSeatId: 'builder',
      activeSeatCap: 2,
    });
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const providerCalls: string[][] = [];
    const stopSeat = vi.fn(async () => {});
    const reconcileProviders = async ({ requiredProviders }: { requiredProviders: string[] }) => {
      providerCalls.push(requiredProviders);
      if (requiredProviders.includes('anthropic-vertex')) {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    };
    orchestrator = new SymposiumOrchestrator({
      store,
      executors: { builder, reviewer },
      stopSeat,
      reconcileProviders,
    });
    for (const seatId of ['builder', 'reviewer']) {
      await orchestrator.transitionMembership({
        sessionId: 'chat',
        seatId,
        action: 'admit',
        expectedGeneration: 0,
        configRevision: 4,
        actor: 'director',
        reason: 'start',
        idempotencyKey: `member:${seatId}`,
      });
      orchestrator.recordProviderAdmission({
        sessionId: 'chat',
        seatId,
        decision: 'admitted',
        idempotencyKey: `provider:${seatId}`,
      });
      if (seatId === 'builder') await orchestrator.reconcileMembership('chat', seatId, 1);
    }
    const oldReconcile = orchestrator.reconcileMembership('chat', 'reviewer', 1);
    await enteredPromise;
    const revoker = new SymposiumOrchestrator({
      store,
      executors: { builder, reviewer },
      stopSeat,
      reconcileProviders,
    });
    const revoke = revoker.transitionMembership({
      sessionId: 'chat',
      seatId: 'reviewer',
      action: 'suspend',
      expectedGeneration: 1,
      configRevision: 4,
      actor: 'director',
      reason: 'pause',
      idempotencyKey: 'pause-reviewer',
    });
    expect(store.getLatestSymposiumMembership('chat', 'reviewer')?.state).toBe('suspended');
    expect(stopSeat).not.toHaveBeenCalled();
    release();
    expect((await oldReconcile).reconciliation).not.toBe('confirmed');
    expect((await revoke).reconciliation).toBe('confirmed');
    expect(providerCalls.at(-1)).toEqual(['openai-codex']);
    expect(stopSeat).toHaveBeenCalledOnce();
  });
  it('records explicit provider admission against one shared trust boundary', () => {
    const admission = admit('reviewer');

    expect(admission).toMatchObject({
      sessionId: 'chat',
      seatId: 'reviewer',
      decision: 'admitted',
      configRevision: 3,
      model: 'model-b',
      accountProfileRevision: 'account-2',
      isolationDomainId: 'symposium-shared',
      isolationDomainRevision: 2,
    });
    expect(store.getSymposiumAdmissions('chat')).toEqual([admission]);
  });

  it('preserves original and edited delivery content, recipients, interventions, and grants', async () => {
    admit('builder');
    admit('reviewer');
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'Unredacted draft',
      idempotencyKey: 'stage-1',
    });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'edit',
      content: 'Redacted draft',
      reason: 'Removed customer data',
      idempotencyKey: 'edit-1',
    });

    const delivered = await orchestrator.deliver(staged.deliveryId);

    expect(delivered).toMatchObject({
      originalContent: 'Unredacted draft',
      deliveredContent: 'Redacted draft',
      recipientSeatIds: ['reviewer'],
      status: 'delivered',
      intervention: 'edit',
    });
    expect(delivered.recipients[0]).toMatchObject({
      seatId: 'reviewer',
      configRevision: 3,
      contextGrantRevision: 6,
      authorityGrantRevision: 7,
      providerThreadId: 'thread-reviewer',
      resultContent: 'reviewer: Redacted draft',
    });
    expect(store.getSymposiumInterventions(staged.deliveryId)).toEqual([
      expect.objectContaining({ action: 'edit', reason: 'Removed customer data' }),
    ]);
  });

  it('reuses one durable provider thread per seat instead of issuing fresh queries', async () => {
    admit('builder');
    admit('reviewer');
    for (const [index, content] of ['first', 'second'].entries()) {
      const staged = orchestrator.stageDelivery({
        sessionId: 'chat',
        sourceSeatId: 'builder',
        recipientSeatIds: ['reviewer'],
        originalContent: content,
        idempotencyKey: `stage-${index}`,
      });
      orchestrator.intervene({
        deliveryId: staged.deliveryId,
        action: 'approve',
        idempotencyKey: `approve-${index}`,
      });
      await orchestrator.deliver(staged.deliveryId);
    }

    expect(reviewer.calls).toHaveLength(2);
    expect(reviewer.calls[0].providerThreadId).toBeUndefined();
    expect(reviewer.calls[1].providerThreadId).toBe('thread-reviewer');
    expect(store.getSymposiumSeatThreads('chat')).toEqual([
      expect.objectContaining({ seatId: 'reviewer', providerThreadId: 'thread-reviewer' }),
    ]);
  });

  it('starts a new thread when a persisted grant revision changes', async () => {
    admit('builder');
    admit('reviewer');
    const first = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'under grant 6',
      idempotencyKey: 'stage-old-grant',
    });
    orchestrator.intervene({
      deliveryId: first.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-old-grant',
    });
    await orchestrator.deliver(first.deliveryId);

    const nextConfig: SymposiumConfig = {
      ...config,
      revision: 4,
      seats: [
        config.seats[0],
        {
          ...config.seats[1],
          contextGrant: { ...config.seats[1].contextGrant!, revision: 7 },
        },
      ],
    };
    store.setSymposiumConfig('chat', nextConfig);
    expect(() =>
      orchestrator.stageDelivery({
        sessionId: 'chat',
        sourceSeatId: 'builder',
        recipientSeatIds: ['reviewer'],
        originalContent: 'under grant 7',
        idempotencyKey: 'stage-new-grant',
      }),
    ).toThrow('not admitted');
    orchestrator.recordProviderAdmission({
      sessionId: 'chat',
      seatId: 'builder',
      decision: 'admitted',
      idempotencyKey: 'admit-builder-new-grant',
    });
    orchestrator.recordProviderAdmission({
      sessionId: 'chat',
      seatId: 'reviewer',
      decision: 'admitted',
      idempotencyKey: 'admit-new-grant',
    });
    const second = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'under grant 7',
      idempotencyKey: 'stage-new-grant',
    });
    orchestrator.intervene({
      deliveryId: second.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-new-grant',
    });
    await orchestrator.deliver(second.deliveryId);

    expect(reviewer.calls[1].providerThreadId).toBeUndefined();
    expect(store.getSymposiumSeatThreads('chat')).toHaveLength(2);
  });

  it('starts a new thread when reasoning effort changes without changing the account', async () => {
    admit('builder');
    admit('reviewer');
    const send = async (key: string) => {
      const staged = orchestrator.stageDelivery({
        sessionId: 'chat',
        sourceSeatId: 'builder',
        recipientSeatIds: ['reviewer'],
        originalContent: key,
        idempotencyKey: `stage:${key}`,
      });
      orchestrator.intervene({
        deliveryId: staged.deliveryId,
        action: 'approve',
        idempotencyKey: `approve:${key}`,
      });
      await orchestrator.deliver(staged.deliveryId);
    };
    await send('first');
    store.setSymposiumConfig('chat', {
      ...config,
      revision: 4,
      seats: [config.seats[0], { ...config.seats[1], reasoningEffort: 'high' }],
    });
    for (const seatId of ['builder', 'reviewer']) {
      orchestrator.recordProviderAdmission({
        sessionId: 'chat',
        seatId,
        decision: 'admitted',
        idempotencyKey: `new:${seatId}`,
      });
    }
    await send('second');
    expect(reviewer.calls[1].providerThreadId).toBeUndefined();
  });

  it('fails closed when provider admission was refused or is missing', () => {
    admit('builder');
    admit('reviewer');
    admit('reviewer', 'refused');
    expect(() =>
      orchestrator.stageDelivery({
        sessionId: 'chat',
        sourceSeatId: 'builder',
        recipientSeatIds: ['reviewer'],
        originalContent: 'draft',
        idempotencyKey: 'stage-refused',
      }),
    ).toThrow('not admitted');
  });

  it('requires admission for a non-director source seat before claiming its provenance', () => {
    admit('reviewer');
    expect(() =>
      orchestrator.stageDelivery({
        sessionId: 'chat',
        sourceSeatId: 'builder',
        recipientSeatIds: ['reviewer'],
        originalContent: 'unadmitted source output',
        idempotencyKey: 'stage-unadmitted-source',
      }),
    ).toThrow('builder is not admitted');
  });

  it('makes staging, intervention, and execution retries idempotent', async () => {
    admit('builder');
    admit('reviewer');
    const input = {
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'] as ['reviewer'],
      originalContent: 'draft',
      idempotencyKey: 'same-stage',
    };
    const first = orchestrator.stageDelivery(input);
    const duplicate = orchestrator.stageDelivery(input);
    expect(duplicate.deliveryId).toBe(first.deliveryId);

    const intervention = {
      deliveryId: first.deliveryId,
      action: 'approve' as const,
      idempotencyKey: 'same-approval',
    };
    orchestrator.intervene(intervention);
    orchestrator.intervene(intervention);
    await Promise.all([
      orchestrator.deliver(first.deliveryId),
      orchestrator.deliver(first.deliveryId),
    ]);

    expect(reviewer.calls).toHaveLength(1);
    expect(store.getSymposiumInterventions(first.deliveryId)).toHaveLength(1);

    store.setSymposiumConfig('chat', { ...config, revision: 4 });
    expect(orchestrator.stageDelivery(input).deliveryId).toBe(first.deliveryId);
    expect(
      orchestrator.recordProviderAdmission({
        sessionId: 'chat',
        seatId: 'reviewer',
        decision: 'admitted',
        reason: 'Director accepted shared boundary',
        idempotencyKey: 'admit-reviewer-admitted',
      }).configRevision,
    ).toBe(3);
  });

  it('records replace and drop interventions without losing the original content', async () => {
    admit('builder');
    admit('reviewer');
    const replaced = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'unsafe original',
      idempotencyKey: 'stage-replace',
    });
    orchestrator.intervene({
      deliveryId: replaced.deliveryId,
      action: 'replace',
      content: 'safe replacement',
      idempotencyKey: 'replace-1',
    });
    expect(await orchestrator.deliver(replaced.deliveryId)).toMatchObject({
      originalContent: 'unsafe original',
      deliveredContent: 'safe replacement',
      intervention: 'replace',
      status: 'delivered',
    });

    const dropped = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'do not send',
      idempotencyKey: 'stage-drop',
    });
    const result = orchestrator.intervene({
      deliveryId: dropped.deliveryId,
      action: 'drop',
      reason: 'Director rejected it',
      idempotencyKey: 'drop-1',
    });
    expect(result).toMatchObject({
      originalContent: 'do not send',
      deliveredContent: null,
      intervention: 'drop',
      status: 'dropped',
    });
    expect((await orchestrator.deliver(dropped.deliveryId)).status).toBe('dropped');
    expect(reviewer.calls).toHaveLength(1);
  });

  it('retries a failed seat attempt with the same provider idempotency key', async () => {
    admit('builder');
    admit('reviewer');
    let calls = 0;
    reviewer.execute = vi.fn(async (input: SymposiumSeatExecution) => {
      reviewer.calls.push(input);
      calls += 1;
      if (calls === 1) throw new Error('temporary provider failure');
      return { providerThreadId: 'thread-reviewer', content: 'recovered', costUsd: 0 };
    });
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'review this',
      idempotencyKey: 'stage-failure',
    });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-failure',
    });
    expect(await orchestrator.deliver(staged.deliveryId)).toMatchObject({ status: 'failed' });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'retry',
      reason: 'Provider recovered',
      idempotencyKey: 'retry-failure',
    });
    expect(await orchestrator.deliver(staged.deliveryId)).toMatchObject({ status: 'delivered' });
    expect(reviewer.calls.map((call) => call.idempotencyKey)).toEqual([
      'delivery:delivery-1:seat:reviewer',
      'delivery:delivery-1:seat:reviewer',
    ]);
    expect(store.getSymposiumRecipientAttempts(staged.deliveryId, 'reviewer')).toMatchObject([
      {
        attemptNumber: 1,
        idempotencyKey: 'delivery:delivery-1:seat:reviewer',
        status: 'failed',
        error: 'temporary provider failure',
      },
      {
        attemptNumber: 2,
        idempotencyKey: 'delivery:delivery-1:seat:reviewer',
        status: 'delivered',
        resultContent: 'recovered',
        costUsd: 0,
      },
    ]);
  });

  it('retries a failed second recipient without re-executing the delivered first recipient', async () => {
    admit('builder');
    admit('reviewer');
    let reviewerCalls = 0;
    reviewer.execute = vi.fn(async (input: SymposiumSeatExecution) => {
      reviewer.calls.push(input);
      reviewerCalls += 1;
      if (reviewerCalls === 1) throw new Error('temporary reviewer failure');
      return { providerThreadId: 'thread-reviewer', content: 'review recovered', costUsd: 0 };
    });
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: null,
      recipientSeatIds: ['builder', 'reviewer'],
      originalContent: 'review together',
      idempotencyKey: 'stage-partial-retry',
    });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-partial-retry',
    });

    expect(await orchestrator.deliver(staged.deliveryId)).toMatchObject({
      status: 'failed',
      recipients: [
        expect.objectContaining({ seatId: 'builder', status: 'delivered' }),
        expect.objectContaining({ seatId: 'reviewer', status: 'failed' }),
      ],
    });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'retry',
      idempotencyKey: 'retry-partial-retry',
    });

    expect(await orchestrator.deliver(staged.deliveryId)).toMatchObject({ status: 'delivered' });
    expect(builder.calls).toHaveLength(1);
    expect(reviewer.calls).toHaveLength(2);
    expect(reviewer.calls[0].idempotencyKey).toBe(reviewer.calls[1].idempotencyKey);
  });

  it('persists cancellation and aborts an in-flight injected executor', async () => {
    admit('builder');
    admit('reviewer');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    reviewer.execute = vi.fn(async (input: SymposiumSeatExecution) => {
      reviewer.calls.push(input);
      await waiting;
      return { providerThreadId: 'late-thread', content: 'late', costUsd: 0 };
    });
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'draft',
      idempotencyKey: 'stage-cancel',
    });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-cancel',
    });

    const running = orchestrator.deliver(staged.deliveryId);
    await vi.waitFor(() => expect(reviewer.calls).toHaveLength(1));
    await orchestrator.cancel({
      deliveryId: staged.deliveryId,
      reason: 'Director stopped review',
      idempotencyKey: 'cancel-1',
    });
    release();
    const cancelled = await running;

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'Director stopped review',
      cancellationIdempotencyKey: 'cancel-1',
    });
    expect(cancelled.recipients[0].status).toBe('cancelled');
    expect(reviewer.cancellations).toEqual(['delivery:delivery-1:seat:reviewer']);
    expect(store.getSymposiumSeatThreads('chat')).toEqual([]);
    await expect(
      orchestrator.cancel({
        deliveryId: staged.deliveryId,
        reason: 'Director stopped review',
        idempotencyKey: 'cancel-1',
      }),
    ).resolves.toEqual(cancelled);
    await expect(
      orchestrator.cancel({
        deliveryId: staged.deliveryId,
        reason: 'A conflicting reason',
        idempotencyKey: 'cancel-1',
      }),
    ).rejects.toThrow('idempotency key was reused with a different reason');
  });

  it('returns the durable cancellation when optional provider cleanup rejects', async () => {
    admit('builder');
    admit('reviewer');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    reviewer.execute = vi.fn(async (input: SymposiumSeatExecution) => {
      reviewer.calls.push(input);
      await waiting;
      return { providerThreadId: 'late-thread', content: 'late', costUsd: 0 };
    });
    reviewer.cancel = vi.fn(async () => {
      throw new Error('provider cleanup unavailable');
    });
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'draft',
      idempotencyKey: 'stage-cancel-cleanup-failure',
    });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-cancel-cleanup-failure',
    });

    const running = orchestrator.deliver(staged.deliveryId);
    await vi.waitFor(() => expect(reviewer.calls).toHaveLength(1));
    const cancelled = await orchestrator.cancel({
      deliveryId: staged.deliveryId,
      reason: 'Director stopped review',
      idempotencyKey: 'cancel-cleanup-failure',
    });
    release();
    await running;

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancellationIdempotencyKey: 'cancel-cleanup-failure',
    });
    expect(reviewer.cancel).toHaveBeenCalledOnce();
    expect(store.getSymposiumDelivery(staged.deliveryId)).toMatchObject({ status: 'cancelled' });
  });

  it('passes a reused durable provider thread to in-flight cancellation cleanup', async () => {
    admit('builder');
    admit('reviewer');
    const first = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'first review',
      idempotencyKey: 'stage-cancel-reused-thread-first',
    });
    orchestrator.intervene({
      deliveryId: first.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-cancel-reused-thread-first',
    });
    await orchestrator.deliver(first.deliveryId);

    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    reviewer.execute = vi.fn(async (input: SymposiumSeatExecution) => {
      reviewer.calls.push(input);
      await waiting;
      return {
        providerThreadId: input.providerThreadId!,
        content: 'late',
        costUsd: 0,
      };
    });
    const second = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'second review',
      idempotencyKey: 'stage-cancel-reused-thread-second',
    });
    orchestrator.intervene({
      deliveryId: second.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-cancel-reused-thread-second',
    });

    const running = orchestrator.deliver(second.deliveryId);
    await vi.waitFor(() => expect(reviewer.calls).toHaveLength(2));
    await orchestrator.cancel({
      deliveryId: second.deliveryId,
      idempotencyKey: 'cancel-reused-thread',
    });
    release();
    await running;

    expect(reviewer.calls[1].providerThreadId).toBe('thread-reviewer');
    expect(reviewer.cancellationThreadIds).toEqual(['thread-reviewer']);
  });

  it('marks crash-interrupted attempts for explicit recovery and reuses their execution key', async () => {
    admit('builder');
    admit('reviewer');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const execute = reviewer.execute.bind(reviewer);
    reviewer.execute = vi.fn(async (input: SymposiumSeatExecution) => {
      if (reviewer.calls.length === 0) await waiting;
      return execute(input);
    });
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'draft',
      idempotencyKey: 'stage-recovery',
    });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-recovery',
    });
    const interrupted = orchestrator.deliver(staged.deliveryId);
    await vi.waitFor(() => expect(reviewer.execute).toHaveBeenCalledTimes(1));
    expect(orchestrator.recover()).toEqual([
      expect.objectContaining({ deliveryId: staged.deliveryId, status: 'recovery_required' }),
    ]);
    expect(store.getSymposiumRecipientAttempts(staged.deliveryId, 'reviewer')).toMatchObject([
      { attemptNumber: 1, status: 'recovery_required' },
    ]);
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'retry',
      reason: 'Resume after restart',
      idempotencyKey: 'retry-recovery',
    });
    release();
    await expect(interrupted).resolves.toMatchObject({ status: 'ready' });
    expect(store.getSymposiumSeatThreads('chat')).toEqual([]);
    const recovered = await orchestrator.deliver(staged.deliveryId);

    expect(recovered.status).toBe('delivered');
    expect(reviewer.calls.map((call) => call.idempotencyKey)).toEqual([
      'delivery:delivery-1:seat:reviewer',
      'delivery:delivery-1:seat:reviewer',
    ]);
    expect(store.getSymposiumSeatThreads('chat')).toEqual([
      expect.objectContaining({ seatId: 'reviewer', providerThreadId: 'thread-reviewer' }),
    ]);
    expect(store.getSymposiumRecipientAttempts(staged.deliveryId, 'reviewer')).toMatchObject([
      { attemptNumber: 1, status: 'recovery_required' },
      { attemptNumber: 2, status: 'delivered', resultContent: 'reviewer: draft' },
    ]);
  });

  it('counts failed provider attempts against the durable turn cap', async () => {
    store.setSymposiumConfig('chat', {
      ...config,
      revision: 4,
      turnRules: { mode: 'directed', maxTurns: 1 },
    });
    orchestrator.recordProviderAdmission({
      sessionId: 'chat',
      seatId: 'builder',
      decision: 'admitted',
      idempotencyKey: 'admit-builder-failed-cap',
    });
    orchestrator.recordProviderAdmission({
      sessionId: 'chat',
      seatId: 'reviewer',
      decision: 'admitted',
      idempotencyKey: 'admit-reviewer-failed-cap',
    });
    reviewer.execute = vi.fn(async (input: SymposiumSeatExecution) => {
      reviewer.calls.push(input);
      throw new Error('permanent provider failure');
    });
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'one allowed attempt',
      idempotencyKey: 'stage-failed-cap',
    });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-failed-cap',
    });

    await expect(orchestrator.deliver(staged.deliveryId)).resolves.toMatchObject({
      status: 'failed',
    });
    expect(store.getSymposiumRecipientAttempts(staged.deliveryId, 'reviewer')).toMatchObject([
      { attemptNumber: 1, status: 'failed', error: 'permanent provider failure' },
    ]);
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'retry',
      idempotencyKey: 'retry-failed-cap',
    });
    await expect(orchestrator.deliver(staged.deliveryId)).rejects.toThrow('turn limit');
    expect(reviewer.calls).toHaveLength(1);
  });

  it('enforces the persisted turn limit before dispatch', async () => {
    admit('builder');
    admit('reviewer');
    const first = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: null,
      recipientSeatIds: ['builder', 'reviewer'],
      originalContent: 'both seats',
      idempotencyKey: 'stage-both',
    });
    orchestrator.intervene({
      deliveryId: first.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-both',
    });
    await orchestrator.deliver(first.deliveryId);

    const second = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'third turn',
      idempotencyKey: 'stage-third',
    });
    orchestrator.intervene({
      deliveryId: second.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-third',
    });
    await orchestrator.deliver(second.deliveryId);

    const third = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'reviewer',
      recipientSeatIds: ['builder', 'reviewer'],
      originalContent: 'would exceed four',
      idempotencyKey: 'stage-over-limit',
    });
    orchestrator.intervene({
      deliveryId: third.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-over-limit',
    });
    await expect(orchestrator.deliver(third.deliveryId)).rejects.toThrow('turn limit');
  });

  it('reserves the turn cap atomically across orchestrator instances', async () => {
    store.setSymposiumConfig('chat', {
      ...config,
      revision: 4,
      turnRules: { mode: 'directed', maxTurns: 1 },
    });
    orchestrator.recordProviderAdmission({
      sessionId: 'chat',
      seatId: 'builder',
      decision: 'admitted',
      idempotencyKey: 'admit-builder-concurrent',
    });
    orchestrator.recordProviderAdmission({
      sessionId: 'chat',
      seatId: 'reviewer',
      decision: 'admitted',
      idempotencyKey: 'admit-concurrent',
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    reviewer.execute = vi.fn(async (input: SymposiumSeatExecution) => {
      reviewer.calls.push(input);
      await waiting;
      return { providerThreadId: 'thread-reviewer', content: 'done', costUsd: 0 };
    });
    const deliveries = ['one', 'two'].map((content) => {
      const staged = orchestrator.stageDelivery({
        sessionId: 'chat',
        sourceSeatId: 'builder',
        recipientSeatIds: ['reviewer'],
        originalContent: content,
        idempotencyKey: `stage-concurrent-${content}`,
      });
      orchestrator.intervene({
        deliveryId: staged.deliveryId,
        action: 'approve',
        idempotencyKey: `approve-concurrent-${content}`,
      });
      return staged;
    });
    const secondStore = new EventStore(dbPath);
    const secondOrchestrator = new SymposiumOrchestrator({
      store: secondStore,
      executors: { builder, reviewer },
    });
    try {
      const firstRun = orchestrator.deliver(deliveries[0].deliveryId);
      await vi.waitFor(() => expect(reviewer.calls).toHaveLength(1));
      await expect(secondOrchestrator.deliver(deliveries[1].deliveryId)).rejects.toThrow(
        'turn limit',
      );
      release();
      await firstRun;
    } finally {
      release();
      secondStore.close();
    }
  });

  it('treats a concurrent duplicate claim as an idempotent observation', async () => {
    store.setSymposiumConfig('chat', {
      ...config,
      revision: 4,
      turnRules: { mode: 'directed', maxTurns: 1 },
    });
    orchestrator.recordProviderAdmission({
      sessionId: 'chat',
      seatId: 'reviewer',
      decision: 'admitted',
      idempotencyKey: 'admit-duplicate-claim',
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    reviewer.execute = vi.fn(async (input: SymposiumSeatExecution) => {
      reviewer.calls.push(input);
      await waiting;
      return { providerThreadId: 'thread-reviewer', content: 'done', costUsd: 0 };
    });
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: null,
      recipientSeatIds: ['reviewer'],
      originalContent: 'one turn',
      idempotencyKey: 'stage-duplicate-claim',
    });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-duplicate-claim',
    });
    const secondStore = new EventStore(dbPath);
    const secondOrchestrator = new SymposiumOrchestrator({
      store: secondStore,
      executors: { builder, reviewer },
    });
    try {
      const firstRun = orchestrator.deliver(staged.deliveryId);
      await vi.waitFor(() => expect(reviewer.calls).toHaveLength(1));
      await expect(secondOrchestrator.deliver(staged.deliveryId)).resolves.toMatchObject({
        status: 'delivering',
      });
      expect(reviewer.calls).toHaveLength(1);
      release();
      await firstRun;
    } finally {
      release();
      secondStore.close();
    }
  });

  it('serializes concurrent deliveries through one durable seat thread', async () => {
    admit('builder');
    admit('reviewer');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    reviewer.execute = vi.fn(async (input: SymposiumSeatExecution) => {
      reviewer.calls.push(input);
      if (reviewer.calls.length === 1) await waiting;
      return {
        providerThreadId: input.providerThreadId ?? 'thread-reviewer',
        content: `${input.content} complete`,
        costUsd: 0,
      };
    });
    const deliveries = ['first', 'second'].map((content) => {
      const staged = orchestrator.stageDelivery({
        sessionId: 'chat',
        sourceSeatId: 'builder',
        recipientSeatIds: ['reviewer'],
        originalContent: content,
        idempotencyKey: `stage-seat-claim-${content}`,
      });
      orchestrator.intervene({
        deliveryId: staged.deliveryId,
        action: 'approve',
        idempotencyKey: `approve-seat-claim-${content}`,
      });
      return staged;
    });
    const secondStore = new EventStore(dbPath);
    const secondOrchestrator = new SymposiumOrchestrator({
      store: secondStore,
      executors: { builder, reviewer },
      claimIdFactory: () => 'claim-second-orchestrator',
    });
    try {
      const firstRun = orchestrator.deliver(deliveries[0].deliveryId);
      await vi.waitFor(() => expect(reviewer.calls).toHaveLength(1));

      await expect(secondOrchestrator.deliver(deliveries[1].deliveryId)).resolves.toMatchObject({
        status: 'ready',
      });
      expect(reviewer.calls).toHaveLength(1);

      release();
      await expect(firstRun).resolves.toMatchObject({ status: 'delivered' });
      await expect(secondOrchestrator.deliver(deliveries[1].deliveryId)).resolves.toMatchObject({
        status: 'delivered',
      });
      expect(reviewer.calls).toHaveLength(2);
      expect(reviewer.calls[1].providerThreadId).toBe('thread-reviewer');
      expect(store.getSymposiumSeatThreads('chat')).toEqual([
        expect.objectContaining({ seatId: 'reviewer', providerThreadId: 'thread-reviewer' }),
      ]);
    } finally {
      release();
      secondStore.close();
    }
  });

  it('rechecks the active configuration before dispatching each recipient', async () => {
    admit('builder');
    admit('reviewer');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    builder.execute = vi.fn(async (input: SymposiumSeatExecution) => {
      builder.calls.push(input);
      await waiting;
      return { providerThreadId: 'thread-builder', content: 'builder done', costUsd: 0 };
    });
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: null,
      recipientSeatIds: ['builder', 'reviewer'],
      originalContent: 'both seats',
      idempotencyKey: 'stage-revision-race',
    });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-revision-race',
    });
    const running = orchestrator.deliver(staged.deliveryId);
    await vi.waitFor(() => expect(builder.calls).toHaveLength(1));
    store.setSymposiumConfig('chat', { ...config, revision: 4 });
    release();
    const result = await running;

    expect(result.status).toBe('failed');
    expect(result.recipients[1]).toMatchObject({
      seatId: 'reviewer',
      status: 'failed',
      error: 'Delivery configuration revision is stale',
    });
    expect(reviewer.calls).toHaveLength(0);
  });

  it('atomically rejects a provider refusal recorded between validation and execution claim', async () => {
    admit('builder');
    admit('reviewer');
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'review this',
      idempotencyKey: 'stage-admission-claim-race',
    });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-admission-claim-race',
    });
    const concurrentStore = new EventStore(dbPath);
    const concurrentOrchestrator = new SymposiumOrchestrator({
      store: concurrentStore,
      executors: { builder, reviewer },
      now: () => 1_700_000_000_001,
    });
    const claim = store.claimSymposiumRecipientExecution.bind(store);
    const claimSpy = vi
      .spyOn(store, 'claimSymposiumRecipientExecution')
      .mockImplementation((input) => {
        concurrentOrchestrator.recordProviderAdmission({
          sessionId: 'chat',
          seatId: 'reviewer',
          decision: 'refused',
          reason: 'Director withdrew admission',
          idempotencyKey: 'refuse-during-claim',
        });
        return claim(input);
      });
    try {
      await expect(orchestrator.deliver(staged.deliveryId)).resolves.toMatchObject({
        status: 'failed',
        recipients: [
          expect.objectContaining({
            status: 'failed',
            error: 'Provider for Symposium seat reviewer is not admitted',
          }),
        ],
      });
      expect(reviewer.calls).toHaveLength(0);
    } finally {
      claimSpy.mockRestore();
      concurrentStore.close();
    }
  });

  it('atomically rejects a config change recorded between validation and execution claim', async () => {
    admit('builder');
    admit('reviewer');
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'review this',
      idempotencyKey: 'stage-config-claim-race',
    });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-config-claim-race',
    });
    const concurrentStore = new EventStore(dbPath);
    const claim = store.claimSymposiumRecipientExecution.bind(store);
    const claimSpy = vi
      .spyOn(store, 'claimSymposiumRecipientExecution')
      .mockImplementation((input) => {
        concurrentStore.setSymposiumConfig('chat', { ...config, revision: 4 });
        return claim(input);
      });
    try {
      await expect(orchestrator.deliver(staged.deliveryId)).resolves.toMatchObject({
        status: 'failed',
        recipients: [
          expect.objectContaining({
            status: 'failed',
            error: 'Delivery configuration revision is stale',
          }),
        ],
      });
      expect(reviewer.calls).toHaveLength(0);
    } finally {
      claimSpy.mockRestore();
      concurrentStore.close();
    }
  });

  it('records a stale configuration failure before dispatch so intervention remains possible', async () => {
    admit('builder');
    admit('reviewer');
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: 'builder',
      recipientSeatIds: ['reviewer'],
      originalContent: 'approved under revision 3',
      idempotencyKey: 'stage-stale-before-dispatch',
    });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-stale-before-dispatch',
    });
    store.setSymposiumConfig('chat', { ...config, revision: 4 });

    expect(await orchestrator.deliver(staged.deliveryId)).toMatchObject({
      status: 'failed',
      recipients: [
        expect.objectContaining({
          status: 'failed',
          error: 'Delivery configuration revision is stale',
        }),
      ],
    });
    expect(reviewer.calls).toHaveLength(0);
    expect(
      orchestrator.intervene({
        deliveryId: staged.deliveryId,
        action: 'retry',
        idempotencyKey: 'retry-stale-before-dispatch',
      }).status,
    ).toBe('ready');
  });

  it('allows distinct seat providers to return the same opaque thread id', async () => {
    admit('builder');
    admit('reviewer');
    builder.execute = vi.fn(async (input: SymposiumSeatExecution) => {
      builder.calls.push(input);
      return { providerThreadId: 'thread-1', content: 'builder done', costUsd: 0 };
    });
    reviewer.execute = vi.fn(async (input: SymposiumSeatExecution) => {
      reviewer.calls.push(input);
      return { providerThreadId: 'thread-1', content: 'reviewer done', costUsd: 0 };
    });
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: null,
      recipientSeatIds: ['builder', 'reviewer'],
      originalContent: 'both seats',
      idempotencyKey: 'stage-opaque-threads',
    });
    orchestrator.intervene({
      deliveryId: staged.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-opaque-threads',
    });

    expect(await orchestrator.deliver(staged.deliveryId)).toMatchObject({ status: 'delivered' });
    expect(store.getSymposiumSeatThreads('chat')).toEqual([
      expect.objectContaining({ seatId: 'builder', providerThreadId: 'thread-1' }),
      expect.objectContaining({ seatId: 'reviewer', providerThreadId: 'thread-1' }),
    ]);
  });
});

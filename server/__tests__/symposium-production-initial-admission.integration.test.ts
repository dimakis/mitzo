/** Credential-free positive custody seam. The durable EventStore and ReviewStore
 * exercise charged initial admission against a fixture copy/activation receipt.
 * Actual Podman copy and native execution have separate physical contracts. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SymposiumConfig } from '@mitzo/protocol';
import { artifactAdmissionDigest } from '@mitzo/protocol/event-store';
import { EventStore } from '../event-store.js';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import { SymposiumReviewCoordinator } from '../symposium-review-coordinator.js';
import { createSymposiumProductionReviewComposition } from '../symposium-production-review-composition.js';
import { SymposiumOrchestrator, type SymposiumSeatExecution } from '../symposium-orchestrator.js';
import { SymposiumNativeEventSink } from '../symposium-native-event-sink.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('charges, confirms the exact source child, and persists one bound initial attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-initial-admission-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const events = new EventStore(path);
  const reviews = new SymposiumReviewStore(path);
  const context = { owner: 'user', sessionId: 'session' };
  const seat = (id: string, role: 'coder' | 'reviewer') => ({
    id,
    name: id,
    role,
    model: 'offline-fixture',
    systemPrompt: 'Credential-free seam test',
    color: '#123456',
    accountBinding: {
      accountId: `${id}-account`,
      accountLabel: id,
      provider: 'openai-codex' as const,
      model: 'offline-fixture',
      profileRevision: '1',
    },
    profileBinding: { profileId: id, profileRevision: '1' },
    contextGrant: {
      grantId: `context-${id}`,
      revision: 1,
      classification: 'work' as const,
      sourceRefs: ['repo:fixture'],
    },
    authorityGrant: {
      grantId: `authority-${id}`,
      revision: 1,
      filesystem: role === 'coder' ? ('write' as const) : ('read' as const),
      tools: role === 'coder' ? ('write' as const) : ('read' as const),
      network: 'restricted' as const,
    },
    isolationRequest: {
      trustDomainId: 'fixture',
      revision: 1,
      placement: 'reuse-compatible' as const,
    },
  });
  const config: SymposiumConfig = {
    version: 2,
    revision: 1,
    state: 'active',
    anchorSeatId: 'coder',
    activeSeatCap: 2,
    seats: [seat('coder', 'coder'), seat('reviewer', 'reviewer')],
    turnRules: { mode: 'directed', maxTurns: 4 },
    interceptMode: 'manual',
  };
  events.upsertSession({
    sessionId: context.sessionId,
    accountBinding: config.seats[0].accountBinding,
  });
  events.setSymposiumConfig(context.sessionId, config);
  for (const seatId of ['coder', 'reviewer']) {
    events.transitionSymposiumMembership({
      sessionId: context.sessionId,
      seatId,
      action: 'admit',
      expectedGeneration: 0,
      configRevision: 1,
      actor: 'fixture',
      reason: 'Fixture admission',
      idempotencyKey: `admit-${seatId}`,
      occurredAt: Date.now(),
    });
    events.markSymposiumMembershipReconciled(context.sessionId, seatId, 1, 'confirmed');
  }
  const commit = 'a'.repeat(40),
    hash = 'b'.repeat(64),
    digest = 'c'.repeat(64);
  const source = {
    receipt: {
      sessionId: context.sessionId,
      operationId: 'source-seal',
      volumeGeneration: 'source-generation',
      volumeName: 'source-volume',
      git: { commit, committedTreeDigest: hash },
    },
    digest,
    exported: { receipt: { selection: { defaultBranch: 'main' } } },
  };
  const order: string[] = [];
  const bundle = Buffer.from('fixture bundle');
  const copy = vi.fn(async () => {
    order.push('copy');
    return { generationId: 'child-generation', volumeName: 'child-volume' };
  });
  const admit = vi.fn(
    async (
      _request: unknown,
      binding: Parameters<EventStore['beginSymposiumArtifactAdmission']>[0],
    ) => {
      order.push('admit');
      const sourceProof = (selected: typeof binding) => {
        if (
          selected.kind !== 'initial' ||
          selected.sourceSealId !== source.receipt.operationId ||
          selected.parentSealDigest !== digest
        )
          throw new Error('Fixture source parent changed');
        return true as const;
      };
      const intent = events.beginSymposiumArtifactAdmission(
        binding,
        () => true as const,
        sourceProof,
      );
      const receipt = {
        version: 1 as const,
        transitionId: binding.transitionId,
        bindingDigest: intent.reference.bindingDigest,
        sessionId: binding.sessionId,
        parentGenerationId: binding.parentGenerationId,
        childGenerationId: binding.childGenerationId,
        childVolumeName: binding.childVolumeName,
        expectedPointerRevision: binding.expectedPointerRevision,
        pointerRevision: binding.activatedPointerRevision,
        copyReceiptDigest: binding.copyReceiptDigest,
      };
      const confirmed = events.confirmSymposiumArtifactAdmission(
        binding,
        receipt,
        () => true as const,
        sourceProof,
      );
      return { reference: confirmed.reference, receipt: confirmed.receipt };
    },
  );
  const sink = new SymposiumNativeEventSink(events, vi.fn());
  let acceptedExecution: SymposiumSeatExecution | undefined;
  const execute = vi.fn(async (execution: SymposiumSeatExecution) => {
    acceptedExecution = execution;
    expect(
      events.markSymposiumRecipientAccepted({
        deliveryId: execution.deliveryId,
        seatId: execution.seat.id,
        claimToken: execution.claimToken,
        providerThreadId: 'offline-thread',
        providerTurnId: 'offline-turn',
        acceptedAt: Date.now(),
      }),
    ).toBe(true);
    expect(
      events.getSymposiumRecipientAttemptByClaimToken(execution.claimToken)?.provenance,
    ).toEqual(execution.provenance);
    sink.record(execution, {
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'offline-message' } },
    });
    sink.record(execution, { type: 'result', usage_status: 'unknown' });
    return { providerThreadId: 'offline-thread', content: 'done', costUsd: 0 };
  });
  const orchestrator = new SymposiumOrchestrator({
    store: events,
    executors: { coder: { execute } },
    artifactReady: (sessionId, seatId, generation) =>
      Boolean(events.getSymposiumArtifactReference(sessionId, seatId, generation)),
  });
  for (const seatId of ['coder', 'reviewer'])
    orchestrator.recordProviderAdmission({
      sessionId: context.sessionId,
      seatId,
      decision: 'admitted',
      idempotencyKey: `preinitial-${seatId}`,
    });
  expect(() =>
    orchestrator.stageDelivery({
      sessionId: context.sessionId,
      sourceSeatId: null,
      recipientSeatIds: ['coder'],
      originalContent: 'Premature work',
      idempotencyKey: 'premature-work',
    }),
  ).toThrow('not active');
  expect(events.getSymposiumDeliveries(context.sessionId)).toEqual([]);
  const stageDelivery = vi.fn((input: Parameters<SymposiumOrchestrator['stageDelivery']>[0]) => {
    order.push('delivery');
    return orchestrator.stageDelivery(input);
  });
  const runtime = {
    recordProviderAdmission(
      input: Parameters<SymposiumOrchestrator['recordProviderAdmission']>[0],
    ) {
      order.push(`provider:${input.seatId}`);
      return orchestrator.recordProviderAdmission(input);
    },
    stageDelivery,
  };
  const composed = createSymposiumProductionReviewComposition({
    host: {
      gateway: { workspace: 'fixture' },
      sourceImport: {
        requireSeal: () => source,
        initialExport: (_sessionId: string, operationId: string) => {
          order.push('export');
          return {
            bundle,
            receipt: {
              version: 1,
              mode: 'initial',
              sourceSealId: source.receipt.operationId,
              operationId,
              parentGenerationId: source.receipt.volumeGeneration,
              parentVolumeName: source.receipt.volumeName,
              parentSealDigest: digest,
              seal: {
                sessionId: context.sessionId,
                custodyDigest: 'd'.repeat(64),
                repositoryPath: '.',
                git: {
                  version: 1,
                  commit,
                  tree: commit,
                  entries: 1,
                  bytes: 1,
                  manifestDigest: hash,
                  committedTreeDigest: hash,
                },
              },
              selection: {
                sourceRef: 'refs/heads/source',
                sourceOid: commit,
                baseRef: 'refs/heads/main',
                baseOid: commit,
                defaultBranch: 'main',
                originUrl: 'https://example.test/repo',
              },
              bundleSha256: hash,
              bytes: bundle.length,
              helper: {
                id: hash,
                name: 'fixture',
                image: 'fixture',
                codeDigest: hash,
                terminalExitCode: 0,
                removed: true,
              },
            },
          };
        },
      },
      sealSessionArtifacts: vi.fn(),
      requireCompletedArtifactSeal: vi.fn(),
      inspectCompletedArtifact: vi.fn(),
      exportCompletedReviewContext: vi.fn(),
      exportSuccessorArtifactBundle: vi.fn(),
      copySuccessorArtifact: copy,
      admitSuccessorArtifact: admit,
      inspectStoppedSuccessorOperation: vi.fn(),
      assertArtifactAdmissionCurrent: (
        sessionId: string,
        reference: Parameters<EventStore['assertSymposiumArtifactAdmissionCurrent']>[1],
      ) => {
        events.assertSymposiumArtifactAdmissionCurrent(sessionId, reference);
      },
      artifactLeaseHost: {},
      attemptRegistry: { observations: {}, get: vi.fn() },
      currentProfiles: () => ({ resume: vi.fn(), validateModelSelection: vi.fn() }),
    },
    events,
    reviews,
    grants: { verifySeat: vi.fn() },
    actionAuthority: { authorize: vi.fn() },
    artifactResultsPath: path,
    runtime: () => runtime,
    retainedRuntime: () => null,
  } as never);
  try {
    const coordinator = new SymposiumReviewCoordinator(reviews, composed.reviewHost);
    coordinator.startApplicationRun(context, {
      workflowId: 'workflow',
      acceptanceCriteria: ['criterion.txt has the expected bytes'],
      limits: {
        version: 1,
        mode: 'application',
        maxHostTurns: 4,
        maxReviewCycles: 1,
        deadlineAt: Date.now() + 60_000,
        noProgressLimit: 1,
      },
      expectedArtifactRevision: commit,
      expectedArtifactHash: hash,
    });
    const selected = await coordinator.reserveWithTransition(
      context,
      'workflow',
      'initial',
      'attempt-1',
    );
    expect(selected).toMatchObject({ kind: 'reserved_not_dispatched', attemptId: 'attempt-1' });
    expect(order).toEqual([
      'export',
      'copy',
      'admit',
      'provider:coder',
      'provider:reviewer',
      'delivery',
    ]);
    const state = reviews.get('workflow')!;
    expect(state).toMatchObject({
      hostTurns: 1,
      applicationPreparations: [{ kind: 'initial', status: 'bound', attemptId: 'attempt-1' }],
      applicationAttempts: [{ kind: 'initial', attemptId: 'attempt-1', dispatched: false }],
    });
    const persisted = events.getSymposiumArtifactAdmission(
      context.sessionId,
      state.applicationPreparations[0].transitionId,
    )!;
    expect(persisted.receipt).not.toBeNull();
    expect(persisted.reference.bindingDigest).toBe(artifactAdmissionDigest(persisted.binding));
    const bound = state.applicationAttempts[0];
    const delivery = events.getSymposiumDelivery(bound.binding.deliveryId)!;
    expect(delivery).toMatchObject({
      status: 'awaiting_intervention',
      configRevision: 2,
      recipients: [{ seatId: 'coder', membershipGeneration: 2 }],
    });
    expect(events.getSymposiumApplicationDeliveryControl(delivery.deliveryId)).toMatchObject({
      workflowId: 'workflow',
      attemptId: 'attempt-1',
      policyReservationId: bound.policyReservationId,
    });
    const permit = createHash('sha256')
      .update('symposium-application-delivery-permit/v1\0')
      .update(bound.binding.claimToken)
      .update('\0')
      .update(bound.binding.deliveryId)
      .update('\0')
      .update('0')
      .digest('hex');
    events.armSymposiumApplicationDelivery({
      deliveryId: delivery.deliveryId,
      expectedEpoch: 0,
      permit,
    });
    orchestrator.intervene({
      deliveryId: delivery.deliveryId,
      action: 'approve',
      idempotencyKey: 'approved-initial',
      applicationPermit: permit,
    });
    const delivered = await orchestrator.deliver(delivery.deliveryId, {
      applicationPermit: permit,
    });
    expect(delivered.recipients[0].error).toBeNull();
    expect(delivered.status).toBe('delivered');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.getSessionEvents(context.sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message_start',
          symposiumProvenance: expect.objectContaining({ version: 3, membershipGeneration: 2 }),
        }),
      ]),
    );
    expect(acceptedExecution?.provenance).toMatchObject({ version: 3 });
    const provenance = acceptedExecution!.provenance;
    if (!('artifact' in provenance)) throw new Error('Expected artifact provenance');
    expect(() =>
      events.appendSymposium(
        context.sessionId,
        'message_start',
        { messageId: 'forged-seat' },
        {
          ...provenance,
          seatLabel: 'forged',
        },
      ),
    ).toThrow('does not match');
    expect(() =>
      events.appendSymposium(
        context.sessionId,
        'message_start',
        { messageId: 'forged-artifact' },
        {
          ...provenance,
          artifact: { ...provenance.artifact, bindingDigest: 'f'.repeat(64) },
        },
      ),
    ).toThrow('artifact');
    const forgedClaim = orchestrator.stageDelivery({
      sessionId: context.sessionId,
      sourceSeatId: null,
      recipientSeatIds: ['coder'],
      originalContent: 'Forged snapshot must fail',
      idempotencyKey: 'forged-seat-claim',
    });
    orchestrator.intervene({
      deliveryId: forgedClaim.deliveryId,
      action: 'approve',
      idempotencyKey: 'approve-forged-seat-claim',
    });
    const originalClaim = events.claimSymposiumRecipientExecution.bind(events);
    vi.spyOn(events, 'claimSymposiumRecipientExecution').mockImplementationOnce((input) =>
      originalClaim({
        ...input,
        provenance: { ...input.provenance, seatLabel: 'forged' } as typeof input.provenance,
      }),
    );
    const rejected = await orchestrator.deliver(forgedClaim.deliveryId);
    expect(rejected.recipients[0].error).toBe(
      'Symposium claim provenance does not match the admitted seat',
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      coordinator.recoverBoundTransition(context, 'workflow', 'initial', 'attempt-1'),
    ).toMatchObject({
      kind: 'reserved_not_dispatched',
      attemptId: 'attempt-1',
    });
    expect(copy).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(stageDelivery).toHaveBeenCalledTimes(1);
    const reopened = new SymposiumReviewStore(path);
    try {
      expect(reopened.get('workflow')).toMatchObject({
        hostTurns: 1,
        applicationPreparations: [{ status: 'bound' }],
      });
    } finally {
      reopened.close();
    }
  } finally {
    composed.close();
    reviews.close();
    events.close();
  }
});

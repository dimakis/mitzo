/** Credential-free criterion seam through real durable stores and production composition.
 * Physical host callbacks are deterministic fixture receipts: this test does not prove
 * a Podman check or a live native result. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import { SymposiumReviewCoordinator } from '../symposium-review-coordinator.js';
import { createOwnedReviewArtifactResults } from '../symposium-owned-review-artifacts.js';
import { createSymposiumProductionReviewComposition } from '../symposium-production-review-composition.js';
import { canonicalReviewJson } from '../symposium-review-records.js';

const sha = (value: string) => value.repeat(64);
const context = { owner: 'owner', sessionId: 'session' };
const git = { commit: 'e'.repeat(40), committedTreeDigest: sha('2') };
const selection = (seatId: string, role: 'coder' | 'reviewer') => ({
  seatId,
  role,
  selectionId: `${seatId}-selection`,
  policyRevision: 'policy-1',
  profileId: seatId,
  profileRevision: 1,
  accountId: `${seatId}-account`,
  model: 'offline',
});
const seat = (id: string, role: 'coder' | 'reviewer') => ({
  id,
  name: id,
  role,
  model: 'offline',
  systemPrompt: 'fixture',
  color: '#123456',
  accountBinding: {
    accountId: `${id}-account`,
    accountLabel: id,
    provider: 'openai-codex' as const,
    model: 'offline',
    profileRevision: '1',
  },
  profileBinding: { profileId: id, profileRevision: '1' },
  contextGrant: {
    grantId: `context-${id}`,
    revision: 1,
    classification: 'work' as const,
    sourceRefs: [],
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

it('binds corrected criterion evidence to the retained sealed result and refuses stale or changed receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'symposium-criterion-composition-'));
  const path = join(root, 'state.db');
  const events = new EventStore(path);
  const reviews = new SymposiumReviewStore(path);
  const coder = seat('coder', 'coder');
  const reviewer = seat('reviewer', 'reviewer');
  let composed: ReturnType<typeof createSymposiumProductionReviewComposition> | null = null;
  try {
    events.upsertSession({ sessionId: 'session', accountBinding: coder.accountBinding });
    events.setSymposiumConfig('session', {
      version: 2,
      revision: 1,
      state: 'active',
      anchorSeatId: 'coder',
      activeSeatCap: 2,
      seats: [coder, reviewer],
      turnRules: { mode: 'directed', maxTurns: 4 },
      interceptMode: 'manual',
    });
    for (const id of ['coder', 'reviewer']) {
      events.transitionSymposiumMembership({
        sessionId: 'session',
        seatId: id,
        action: 'admit',
        expectedGeneration: 0,
        configRevision: 1,
        actor: 'owner',
        reason: 'fixture',
        idempotencyKey: `admit-${id}`,
        occurredAt: 1,
      });
      events.markSymposiumMembershipReconciled('session', id, 1, 'confirmed');
    }
    const sealSelection = (generation: string, configRevision: number, key: string) => ({
      sessionId: 'session',
      expectedConfigRevision: configRevision,
      idempotencyKey: key,
      custody: { workspaceId: 'fixture', gatewayLaunchDigest: sha('a') },
      artifact: {
        driver: 'podman' as const,
        volumeName: generation,
        volumeGeneration: generation,
        leaseRevision: 'lease',
        leaseTokenHash: sha('b'),
      },
    });
    const parent = events.beginSymposiumArtifactSeal(sealSelection('source', 1, 'source-seal'));
    const binding = {
      version: 1 as const,
      kind: 'initial' as const,
      transitionId: 'initial-transition',
      operationId: 'copy',
      sessionId: 'session',
      workspaceId: 'fixture',
      custodyDigest: sha('a'),
      parentGenerationId: 'source',
      sourceSealId: parent.fenceId,
      parentSealDigest: sha('c'),
      childGenerationId: 'writer-generation',
      childVolumeName: 'writer-generation',
      copyReceiptDigest: sha('d'),
      expectedPointerRevision: 0,
      activatedPointerRevision: 1,
      workflowId: 'workflow',
      initialAttemptId: 'initial-attempt',
      policyReservationId: 'reservation',
      seatId: 'coder',
      actor: 'owner',
      expectedConfigRevision: 1,
      resultingConfigRevision: 2,
      predecessorMembershipGeneration: 1,
      successorMembershipGeneration: 2,
      accountBinding: coder.accountBinding,
      profileBinding: coder.profileBinding,
      contextGrant: { grantId: coder.contextGrant.grantId, revision: 1 },
      authorityGrant: { grantId: coder.authorityGrant.grantId, revision: 1 },
    };
    const admission = events.beginSymposiumArtifactAdmission(
      binding,
      () => true,
      () => true,
    );
    events.confirmSymposiumArtifactAdmission(
      binding,
      {
        version: 1,
        transitionId: binding.transitionId,
        bindingDigest: admission.reference.bindingDigest,
        sessionId: 'session',
        parentGenerationId: 'source',
        childGenerationId: 'writer-generation',
        childVolumeName: 'writer-generation',
        expectedPointerRevision: 0,
        pointerRevision: 1,
        copyReceiptDigest: binding.copyReceiptDigest,
      },
      () => true,
      () => true,
    );
    const intent = events.beginSymposiumArtifactSeal(
      sealSelection('writer-generation', 2, 'writer-seal'),
    );
    const seal = {
      kind: 'completed_artifact_seal',
      version: 1,
      fenceId: intent.fenceId,
      sessionId: 'session',
      custodyDigest: sha('a'),
      intentDigest: sha('b'),
      retentionDigest: sha('c'),
      revocationDigest: sha('d'),
      repositoryPath: '.',
      git: {
        version: 1,
        ...git,
        tree: 'f'.repeat(40),
        entries: 1,
        bytes: 2,
        manifestDigest: sha('1'),
      },
      verifier: { id: sha('3'), image: 'fixture', codeDigest: sha('4') },
      completedAt: Date.now(),
    } as const;
    const completion = {
      attempt: {
        workflowId: 'workflow',
        attemptId: 'initial-attempt',
        kind: 'initial',
        actorSeatId: 'coder',
        artifactRevision: 'a'.repeat(40),
        artifactHash: sha('5'),
        binding: { claimToken: 'claim', deliveryId: 'delivery', configRevision: 2 },
      },
      execution: {
        deliveryId: 'delivery',
        seatId: 'coder',
        claimToken: 'claim',
        status: 'delivered',
        providerThreadId: 'thread',
        providerTurnId: 'turn',
        completedAt: seal.completedAt - 10,
      },
      observation: {
        status: 'completed',
        terminalAt: seal.completedAt - 10,
        terminalConflict: false,
        identity: {
          claimToken: 'claim',
          sessionId: 'session',
          seatId: 'coder',
          providerThreadId: 'thread',
          providerTurnId: 'turn',
        },
      },
    };
    const resultOwner = createOwnedReviewArtifactResults(path, {
      sealCompleted: async () => ({
        seal,
        claimToken: 'claim',
        operationId: canonicalReviewJson({ thread: 'thread', turn: 'turn' }),
      }),
      sealByFence: async () => seal,
      sealIntent: (fenceId) => events.getSymposiumArtifactSealByFence(fenceId),
      volumeGeneration: () => 'writer-generation',
    });
    await resultOwner.refresh(context, completion as never);
    const result = resultOwner.currentResult(context)!;
    resultOwner.close();
    reviews.create({
      workflowId: 'workflow',
      owner: 'owner',
      sessionId: 'session',
      implementation: result,
      implementer: selection('coder', 'coder'),
      reviewer: selection('reviewer', 'reviewer'),
      acceptanceCriteria: ['The approved marker exists'],
      limits: {
        version: 1,
        mode: 'application',
        maxHostTurns: 4,
        maxReviewCycles: 2,
        deadlineAt: Date.now() + 60_000,
        noProgressLimit: 1,
      },
    });
    const reviewAttempt = {
      workflowId: 'workflow',
      attemptId: 'review-attempt',
      policyReservationId: 'review-reservation',
      kind: 'review' as const,
      actorSeatId: 'reviewer',
      artifactRevision: git.commit,
      artifactHash: git.committedTreeDigest,
      binding: {
        claimToken: 'review-claim',
        contentHash: sha('6'),
        deliveryId: 'review-delivery',
        membershipGeneration: 1,
        configRevision: 2,
        accountId: 'reviewer-account',
        model: 'offline',
        profileId: 'reviewer',
        profileRevision: '1',
        accountProfileRevision: '1',
        authorityGrant: { grantId: reviewer.authorityGrant.grantId, revision: 1 },
        contextGrant: { grantId: reviewer.contextGrant.grantId, revision: 1 },
      },
    };
    expect(reviews.reserveApplicationAttempt(reviewAttempt)).toMatchObject({ kind: 'admitted' });
    reviews.consumeApplicationDispatch(reviewAttempt);
    reviews.bindApplicationOperation('workflow', 'review-attempt', 'review-operation');
    reviews.settleApplicationExecution(
      'workflow',
      'review-attempt',
      'review-operation',
      'completed',
    );
    reviews.recordReview({
      workflowId: 'workflow',
      reviewId: 'review-1',
      reviewerSeatId: 'reviewer',
      kind: 'full',
      artifactRevision: git.commit,
      artifactHash: git.committedTreeDigest,
      findings: [],
      resolvedFingerprints: [],
      usage: { attemptId: 'review-attempt', tokens: null, costUsd: null },
    });
    expect(reviews.finalize('workflow')).toEqual({
      kind: 'decision_required',
      code: 'missing_evidence',
    });
    const observed = sha('f');
    let returnedArtifactHash = git.committedTreeDigest;
    const check = vi.fn(async (_input: { fenceId: string; operationId: string; path: string }) => ({
      executionId: randomUUID(),
      sealFenceId: intent.fenceId,
      sealDigest: createHash('sha256').update(canonicalReviewJson(seal)).digest('hex'),
      artifactRevision: git.commit,
      artifactHash: returnedArtifactHash,
      observedSha256: observed,
      completedAt: seal.completedAt + check.mock.calls.length,
    }));
    const definition = (expectedSha256: string) => ({
      id: 'marker',
      criterion: 'The approved marker exists',
      version: 1 as const,
      kind: 'file-sha256' as const,
      path: 'marker.txt',
      expectedSha256,
    });
    const host = (expectedSha256: string) => ({
      gateway: { workspace: 'fixture' },
      sourceImport: {
        requireSeal: () => ({
          receipt: { sessionId: 'session', git },
          exported: { receipt: { selection: { defaultBranch: 'main' } } },
        }),
        initialExport: vi.fn(),
      },
      sealSessionArtifacts: vi.fn(),
      requireCompletedArtifactSeal: async () => seal,
      inspectCompletedArtifact: vi.fn(),
      exportCompletedReviewContext: vi.fn(),
      releaseCompletedReviewStream: vi.fn(),
      releaseReadyReviewStream: vi.fn(),
      exportSuccessorArtifactBundle: vi.fn(),
      copySuccessorArtifact: vi.fn(),
      admitSuccessorArtifact: vi.fn(),
      inspectStoppedSuccessorOperation: vi.fn(),
      assertArtifactAdmissionCurrent: vi.fn(),
      artifactLeaseHost: {},
      attemptRegistry: { observations: {}, get: vi.fn() },
      currentProfiles: vi.fn(),
      criterionChecks: [definition(expectedSha256)],
      checkCompletedArtifactFile: check,
    });
    const compose = (expectedSha256: string) =>
      createSymposiumProductionReviewComposition({
        host: host(expectedSha256),
        events,
        reviews,
        grants: { verifySeat: vi.fn() },
        actionAuthority: { authorize: vi.fn() },
        artifactResultsPath: path,
        runtime: () => null,
        retainedRuntime: () => null,
      } as never);
    composed = compose(sha('d'));
    const failedId = (await composed.reviewHost.runCriterionCheck!(context, 'workflow', 'marker'))
      .evidenceId;
    expect(composed.reviewHost.evidence(context, failedId)).toMatchObject({
      verdict: 'failed',
      resultId: result.resultId,
    });
    const failedCoordinator = new SymposiumReviewCoordinator(reviews, composed.reviewHost);
    expect(failedCoordinator.recordHostEvidence(context, 'workflow', failedId)).toMatchObject({
      evidence: [expect.objectContaining({ item: expect.objectContaining({ verdict: 'failed' }) })],
    });
    expect(failedCoordinator.exportRecord(context, 'workflow')).toEqual({
      kind: 'decision_required',
      code: 'missing_evidence',
    });
    composed.close();
    composed = compose(sha('f'));
    expect(composed.reviewHost.evidence(context, failedId)).toBeNull();
    expect(
      new SymposiumReviewCoordinator(reviews, composed.reviewHost).recordHostEvidence(
        context,
        'workflow',
        failedId,
      ),
    ).toEqual({ kind: 'decision_required', code: 'host_evidence_required' });
    await expect(
      composed.reviewHost.runCriterionCheck!(context, 'workflow', 'unknown'),
    ).rejects.toThrow(/definition|criterion/i);
    returnedArtifactHash = sha('0');
    await expect(
      composed.reviewHost.runCriterionCheck!(context, 'workflow', 'marker'),
    ).rejects.toThrow(/binding/i);
    expect(reviews.finalize('workflow')).toEqual({
      kind: 'decision_required',
      code: 'missing_evidence',
    });
    returnedArtifactHash = git.committedTreeDigest;
    const verifiedId = (await composed.reviewHost.runCriterionCheck!(context, 'workflow', 'marker'))
      .evidenceId;
    expect(verifiedId).not.toBe(failedId);
    expect(composed.reviewHost.evidence(context, verifiedId)).toMatchObject({
      verdict: 'verified',
      resultId: result.resultId,
    });
    expect(
      (await composed.reviewHost.runCriterionCheck!(context, 'workflow', 'marker')).evidenceId,
    ).toBe(verifiedId);
    expect(check).toHaveBeenCalledTimes(3);
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ fenceId: intent.fenceId, path: 'marker.txt' }),
      expect.anything(),
    );
    const coordinator = new SymposiumReviewCoordinator(reviews, composed.reviewHost);
    expect(coordinator.recordHostEvidence(context, 'workflow', verifiedId)).toMatchObject({
      evidence: [
        expect.anything(),
        expect.objectContaining({ item: expect.objectContaining({ verdict: 'verified' }) }),
      ],
    });
    const exported = coordinator.exportRecord(context, 'workflow');
    expect(exported).toMatchObject({
      kind: 'verified',
      artifactRevision: git.commit,
      artifactHash: git.committedTreeDigest,
      record: { snapshot: { workflowId: 'workflow' } },
    });
    expect(reviews.get('workflow')?.evidence.map((entry) => entry.item.verdict)).toEqual([
      'failed',
      'verified',
    ]);
    const reopened = new SymposiumReviewStore(path);
    try {
      expect(reopened.get('workflow')?.evidence.map((entry) => entry.item.evidenceId)).toEqual([
        failedId,
        verifiedId,
      ]);
      expect(reopened.finalize('workflow')).toMatchObject({ kind: 'verified' });
    } finally {
      reopened.close();
    }
  } finally {
    composed?.close();
    reviews.close();
    events.close();
    rmSync(root, { recursive: true, force: true });
  }
});

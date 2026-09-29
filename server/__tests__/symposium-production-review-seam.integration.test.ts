/** Credential-free production composition seam. Real durable EventStore and ReviewStore
 * select the imported source and charge an initial run; missing physical successor proof
 * must stop before any native delivery. This is not a completed live application run. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SymposiumConfig } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import { SymposiumReviewCoordinator } from '../symposium-review-coordinator.js';
import { createSymposiumProductionReviewComposition } from '../symposium-production-review-composition.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('carries a sealed source through real stores into a charged initial run, then refuses unproved physical admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-review-seam-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const events = new EventStore(path);
  const reviews = new SymposiumReviewStore(path);
  const source = {
    receipt: {
      sessionId: 'session',
      operationId: 'source-seal',
      volumeGeneration: 'source-generation',
      volumeName: 'source-volume',
      git: { commit: 'a'.repeat(40), committedTreeDigest: 'b'.repeat(64) },
    },
    digest: 'c'.repeat(64),
    exported: { receipt: { selection: { defaultBranch: 'main' } } },
  };
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
  events.upsertSession({ sessionId: 'session', accountBinding: config.seats[0].accountBinding });
  events.setSymposiumConfig('session', config);
  for (const seatId of ['coder', 'reviewer']) {
    events.transitionSymposiumMembership({
      sessionId: 'session',
      seatId,
      action: 'admit',
      expectedGeneration: 0,
      configRevision: 1,
      actor: 'fixture',
      reason: 'Fixture admission',
      idempotencyKey: `admit-${seatId}`,
      occurredAt: Date.now(),
    });
    events.markSymposiumMembershipReconciled('session', seatId, 1, 'confirmed');
  }
  const stageDelivery = vi.fn();
  const copy = vi.fn();
  const initialExport = vi.fn(() => {
    throw new Error('fixture physical export unavailable');
  });
  const compositionDeps = {
    host: {
      gateway: { workspace: 'fixture' },
      sourceImport: { requireSeal: () => source, initialExport },
      sealSessionArtifacts: vi.fn(),
      requireCompletedArtifactSeal: vi.fn(),
      inspectCompletedArtifact: vi.fn(),
      exportCompletedReviewContext: vi.fn(),
      releaseCompletedReviewStream: vi.fn(),
      exportSuccessorArtifactBundle: vi.fn(),
      copySuccessorArtifact: copy,
      admitSuccessorArtifact: vi.fn(),
      inspectStoppedSuccessorOperation: vi.fn(),
      assertArtifactAdmissionCurrent: vi.fn(),
      artifactLeaseHost: {},
      attemptRegistry: { observations: {}, get: vi.fn() },
      currentProfiles: () => ({ resume: vi.fn(), validateModelSelection: vi.fn() }),
    },
    events,
    reviews,
    grants: { verifySeat: vi.fn() },
    actionAuthority: { authorize: vi.fn() },
    artifactResultsPath: path,
    runtime: () => ({ stageDelivery }),
    retainedRuntime: () => null,
  };
  const composed = createSymposiumProductionReviewComposition(compositionDeps as never);
  try {
    const context = { owner: 'user', sessionId: 'session' };
    const coordinator = new SymposiumReviewCoordinator(reviews, composed.reviewHost);
    const state = coordinator.startApplicationRun(context, {
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
      expectedArtifactRevision: source.receipt.git.commit,
      expectedArtifactHash: source.receipt.git.committedTreeDigest,
    });
    expect(state).toMatchObject({
      status: 'awaiting_initial',
      implementation: null,
      hostTurns: 0,
      initialArtifact: {
        revision: source.receipt.git.commit,
        hash: source.receipt.git.committedTreeDigest,
      },
      implementer: { seatId: 'coder' },
      reviewer: { seatId: 'reviewer' },
    });
    const reopened = new SymposiumReviewStore(path);
    try {
      expect(reopened.get('workflow')).toMatchObject({ status: 'awaiting_initial', hostTurns: 0 });
    } finally {
      reopened.close();
    }
    // A source seal alone cannot mint a charged native attempt. The exact initial
    // transition must first prove/copy/admit a physical successor artifact.
    await expect(
      coordinator.reserveWithTransition(context, 'workflow', 'initial', 'attempt-1'),
    ).rejects.toThrow('fixture physical export unavailable');
    expect(reviews.get('workflow')).toMatchObject({
      hostTurns: 1,
      applicationPreparations: [{ kind: 'initial', status: 'preparing', attemptId: 'attempt-1' }],
    });
    expect(initialExport).toHaveBeenCalledOnce();
    expect(stageDelivery).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    const restartedEvents = new EventStore(path);
    const restartedReviews = new SymposiumReviewStore(path);
    const restarted = createSymposiumProductionReviewComposition({
      ...compositionDeps,
      events: restartedEvents,
      reviews: restartedReviews,
    } as never);
    try {
      const recovered = new SymposiumReviewCoordinator(restartedReviews, restarted.reviewHost);
      await expect(
        recovered.reserveWithTransition(context, 'workflow', 'initial', 'attempt-1'),
      ).rejects.toThrow('fixture physical export unavailable');
      expect(restartedReviews.get('workflow')).toMatchObject({
        hostTurns: 1,
        applicationPreparations: [{ kind: 'initial', status: 'preparing', attemptId: 'attempt-1' }],
        applicationAttempts: [],
      });
      expect(copy).not.toHaveBeenCalled();
      expect(stageDelivery).not.toHaveBeenCalled();
    } finally {
      restarted.close();
      restartedReviews.close();
      restartedEvents.close();
    }
    const freshAttempt = await coordinator.reserveWithTransition(
      context,
      'workflow',
      'initial',
      'attempt-2',
    );
    expect(freshAttempt).toMatchObject({ kind: 'decision_required' });
    expect(reviews.get('workflow')).toMatchObject({ hostTurns: 1, applicationAttempts: [] });
    expect(initialExport).toHaveBeenCalledTimes(2);
    expect(stageDelivery).not.toHaveBeenCalled();
    const afterFailure = new SymposiumReviewStore(path);
    try {
      expect(afterFailure.get('workflow')).toMatchObject({
        hostTurns: 1,
        applicationPreparations: [{ kind: 'initial', status: 'preparing', attemptId: 'attempt-1' }],
        applicationAttempts: [],
      });
    } finally {
      afterFailure.close();
    }
    // Repeated request for the same exact attempt retains the original charge.
    await expect(
      coordinator.reserveWithTransition(context, 'workflow', 'initial', 'attempt-1'),
    ).rejects.toThrow('fixture physical export unavailable');
    expect(reviews.get('workflow')).toMatchObject({
      hostTurns: 1,
      applicationPreparations: [{ kind: 'initial', status: 'preparing', attemptId: 'attempt-1' }],
      applicationAttempts: [],
    });
    expect(initialExport).toHaveBeenCalledTimes(3);
    expect(stageDelivery).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  } finally {
    composed.close();
    reviews.close();
    events.close();
  }
});

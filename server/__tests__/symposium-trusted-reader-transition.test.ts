import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { AccountBindingSchema, type SeatConfig, type SymposiumConfig } from '@mitzo/protocol';
import { AccountProfiles } from '../account-profiles.js';
import { EventStore } from '../event-store.js';
import { SqliteArtifactLeaseHost } from '../symposium-artifact-host.js';
import { SymposiumOrchestrator } from '../symposium-orchestrator.js';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import { createSealedReaderReviewTransition } from '../symposium-trusted-reader-transition.js';
import { canonicalReviewJson, reviewRecordHash } from '../symposium-review-records.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const commit = 'a'.repeat(40);
const treeDigest = 'b'.repeat(64);
const profile = new AccountProfiles([
  {
    id: 'work',
    label: 'Work',
    provider: 'openai',
    credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
    sandboxProvider: 'openai-work',
    sandboxProviderId: 'object',
    models: [{ id: 'gpt-test', label: 'Test' }],
  },
]);
const reviewer: SeatConfig = {
  id: 'reviewer',
  name: 'Reviewer',
  role: 'reviewer',
  model: 'gpt-test',
  systemPrompt: 'Review only.',
  color: '#223344',
  accountBinding: AccountBindingSchema.parse(profile.resolve('work', 'gpt-test')),
  profileBinding: { profileId: 'reviewer', profileRevision: '1' },
  contextGrant: { grantId: 'context', revision: 1, classification: 'work', sourceRefs: [] },
  authorityGrant: {
    grantId: 'authority',
    revision: 1,
    filesystem: 'read',
    tools: 'read',
    network: 'restricted',
  },
  isolationRequest: { trustDomainId: 'shared', revision: 1, placement: 'reuse-compatible' },
};
const config: SymposiumConfig = {
  version: 2,
  revision: 4,
  state: 'active',
  anchorSeatId: 'reviewer',
  activeSeatCap: 3,
  seats: [reviewer],
  turnRules: { mode: 'directed', maxTurns: 10 },
  interceptMode: 'manual',
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-reader-transition-'));
  roots.push(root);
  const events = new EventStore(join(root, 'events.db'));
  const reviewPath = join(root, 'reviews.db');
  const reviews = new SymposiumReviewStore(reviewPath);
  events.upsertSession({ sessionId: 'symposium', accountBinding: reviewer.accountBinding });
  events.setSymposiumConfig('symposium', config);
  events.transitionSymposiumMembership({
    sessionId: 'symposium',
    seatId: 'reviewer',
    action: 'admit',
    expectedGeneration: 0,
    configRevision: 4,
    actor: 'owner',
    reason: 'initial',
    idempotencyKey: 'initial',
    occurredAt: 1,
  });
  events.markSymposiumMembershipReconciled('symposium', 'reviewer', 1, 'confirmed');
  const selection = {
    sessionId: 'symposium',
    expectedConfigRevision: 4,
    idempotencyKey: 'seal-1',
    custody: { workspaceId: 'workspace', gatewayLaunchDigest: 'c'.repeat(64) },
    artifact: {
      driver: 'podman' as const,
      volumeName: 'volume',
      volumeGeneration: 'generation-1',
      leaseRevision: 'lease-1',
      leaseTokenHash: 'd'.repeat(64),
    },
  };
  const seal = events.beginSymposiumArtifactSeal(selection);
  reviews.create({
    workflowId: 'workflow',
    owner: 'user',
    sessionId: 'symposium',
    implementation: {
      version: 1,
      resultId: 'result',
      attemptId: 'initial',
      inputRevision: 'source',
      inputHash: treeDigest,
      artifactRevision: commit,
      artifactHash: treeDigest,
      summary: 'done',
      evidenceRefs: ['commit'],
      completedAt: 1,
    },
    implementer: {
      seatId: 'coder',
      role: 'coder',
      selectionId: 'coder',
      policyRevision: 'config-4',
      profileId: 'coder',
      profileRevision: 1,
      accountId: 'coder',
      model: 'gpt-test',
    },
    reviewer: {
      seatId: 'reviewer',
      role: 'reviewer',
      selectionId: 'reviewer',
      policyRevision: 'config-4',
      profileId: 'reviewer',
      profileRevision: 1,
      accountId: reviewer.accountBinding!.accountId,
      model: 'gpt-test',
    },
    acceptanceCriteria: ['works'],
    limits: {
      version: 1,
      mode: 'application',
      maxHostTurns: 4,
      maxReviewCycles: 2,
      deadlineAt: Date.now() + 60000,
      noProgressLimit: 2,
    },
  });
  const labels = {
    'openshell.ai/sandbox-attachable': 'true',
    'openshell.ai/sandbox-attachable-workspace': 'workspace',
    'mitzo.symposium.purpose': 'artifacts',
    'mitzo.symposium.session': 'symposium',
    'mitzo.symposium.workspace': 'workspace',
    'mitzo.symposium.generation': 'generation-1',
  };
  const leasePath = join(root, 'leases.db');
  const leaseHost = new SqliteArtifactLeaseHost(
    leasePath,
    { verifyGateway: async () => {}, verifyMount: async () => {} },
    async () => ({ Name: 'volume', Driver: 'local', Labels: labels, Options: {} }),
  );
  const db = new Database(leasePath);
  db.prepare('INSERT INTO symposium_artifact_pending_retention VALUES(?,?,?,?)').run(
    'podman',
    'volume',
    JSON.stringify(seal),
    JSON.stringify({
      kind: 'pending_artifact_retention',
      status: 'pending_unsealed',
      fenceId: seal.fenceId,
      intent: seal,
      writerSandboxName: 'writer',
      writerSandboxId: 'writer-id',
      retainedAt: 1,
    }),
  );
  db.close();
  const runtime = new SymposiumOrchestrator({
    store: events,
    executors: {},
    idFactory: () => 'delivery-1',
  });
  const context = { owner: 'user', sessionId: 'symposium' };
  let loseStageResponse = false;
  let reviewContext = JSON.stringify({
    version: 2,
    sourceOid: commit,
    baseOid: 'c'.repeat(40),
    baseBranch: 'main',
    committedTreeDigest: treeDigest,
    manifestDigest: 'e'.repeat(64),
    trackedFileCount: 0,
    changedPathCount: 1,
    omittedPathCount: 0,
    files: [
      {
        path: 'marker.txt',
        status: 'present',
        representation: 'content',
        complete: true,
        content: 'tested',
        diff: null,
        contentTruncated: false,
        diffTruncated: false,
      },
    ],
  });
  let contextRevision = commit;
  const completedSeal = {
    kind: 'completed_artifact_seal' as const,
    version: 1 as const,
    fenceId: seal.fenceId,
    sessionId: 'symposium',
    custodyDigest: selection.custody.gatewayLaunchDigest,
    intentDigest: sha(JSON.stringify(seal)),
    retentionDigest: 'e'.repeat(64),
    revocationDigest: 'f'.repeat(64),
    repositoryPath: '.',
    git: {
      version: 1 as const,
      commit,
      tree: commit,
      entries: 0,
      bytes: 0,
      manifestDigest: 'e'.repeat(64),
      committedTreeDigest: treeDigest,
    },
    verifier: { id: 'fake', image: 'fake', codeDigest: 'f'.repeat(64) },
    completedAt: 1,
  };
  const owner = createSealedReaderReviewTransition({
    events,
    reviews,
    leaseHost,
    sourceFence: () => seal.fenceId,
    requireCompletedSeal: async () => completedSeal,
    baseBranch: () => 'main',
    exportReviewContext: async ({ fenceId, operationId, baseBranch }) => {
      if (fenceId !== seal.fenceId || baseBranch !== 'main')
        throw new Error('Context selector changed');
      return {
        context: reviewContext,
        receipt: {
          jobId: '11111111-1111-4111-8111-111111111111',
          operationId,
          sealFenceId: seal.fenceId,
          sealDigest: reviewRecordHash(canonicalReviewJson(completedSeal)),
          artifactRevision: contextRevision,
          artifactHash: treeDigest,
          baseOid: 'c'.repeat(40),
          sourceOid: commit,
          contextSha256: sha(reviewContext),
          completedAt: 1,
        },
      };
    },
    currentArtifact: () => ({ revision: commit, hash: treeDigest }),
    verifyReviewer: () => true,
    runtime: () => ({
      recordProviderAdmission: runtime.recordProviderAdmission.bind(runtime),
      stageDelivery(input) {
        const staged = runtime.stageDelivery(input);
        if (loseStageResponse) {
          loseStageResponse = false;
          throw new Error('lost stage response');
        }
        return staged;
      },
    }),
  });
  return {
    events,
    reviews,
    reviewPath,
    leaseHost,
    runtime,
    owner,
    context,
    setLoseStageResponse: () => {
      loseStageResponse = true;
    },
    setReviewContext: (value: string) => {
      reviewContext = value;
    },
    setContextRevision: (value: string) => {
      contextRevision = value;
    },
  };
}

it('charges first review before reader admission and recovers an exact staged delivery after lost response', async () => {
  const f = fixture();
  try {
    expect(f.events.getLatestSymposiumAdmission('symposium', 'reviewer', 4)).toBeUndefined();
    const prep = await f.owner.transition.prepare({
      context: f.context,
      workflowId: 'workflow',
      attemptId: 'review-1',
      kind: 'review',
      selection: f.reviews.get('workflow')!.reviewer,
      artifactRevision: commit,
      artifactHash: treeDigest,
      policy: f.reviews.get('workflow')!.limits as any,
    });
    expect(f.reviews.reserveApplicationPreparation(prep)).toMatchObject({ kind: 'prepared' });
    expect(f.reviews.get('workflow')).toMatchObject({ hostTurns: 1, reviewCycles: 1 });
    expect(f.events.getActiveSymposiumConfig('symposium').revision).toBe(4);
    f.setLoseStageResponse();
    await expect(f.owner.transition.apply(f.context, prep)).rejects.toThrow(/lost stage response/);
    expect(f.events.getSymposiumDelivery('delivery-1')!.originalContent).toContain(
      '"content":"tested"',
    );
    expect(f.events.getActiveSymposiumConfig('symposium').revision).toBe(5);
    expect(f.events.getLatestSymposiumAdmission('symposium', 'reviewer', 5)).toMatchObject({
      decision: 'admitted',
      membershipGeneration: 2,
    });
    const readerBinding = f.events.getSymposiumSealedReaderAdmission(
      'symposium',
      prep.transitionId,
    )!.binding;
    expect(() => f.owner.assertReaderAdmissionCurrent(readerBinding)).toThrow(
      /charged preparation/,
    );
    const completed = await f.owner.transition.apply(f.context, prep);
    expect(completed.attempt.binding).toMatchObject({
      deliveryId: 'delivery-1',
      configRevision: 5,
      membershipGeneration: 2,
    });
    expect(
      f.reviews.completeApplicationPreparation(completed.attempt, completed.proof),
    ).toMatchObject({ kind: 'admitted' });
    expect(f.reviews.applicationAttemptForClaim(completed.attempt.binding.claimToken)).toEqual(
      completed.attempt,
    );
    expect(f.owner.assertReaderAdmissionCurrent(readerBinding)).toBe(true);
    expect(f.reviews.get('workflow')).toMatchObject({ hostTurns: 1, reviewCycles: 1 });
    expect(
      f.runtime.stageDelivery({
        sessionId: 'symposium',
        sourceSeatId: null,
        recipientSeatIds: ['reviewer'],
        originalContent: f.events.getSymposiumDelivery('delivery-1')!.originalContent,
        idempotencyKey: 'review-workflow-review-1',
      }).deliveryId,
    ).toBe('delivery-1');
  } finally {
    f.leaseHost.close();
    f.reviews.close();
    f.events.close();
  }
});

it('rejects mismatched or oversized sealed context before reader admission', async () => {
  const f = fixture();
  try {
    const prep = await f.owner.transition.prepare({
      context: f.context,
      workflowId: 'workflow',
      attemptId: 'review-1',
      kind: 'review',
      selection: f.reviews.get('workflow')!.reviewer,
      artifactRevision: commit,
      artifactHash: treeDigest,
      policy: f.reviews.get('workflow')!.limits as any,
    });
    f.reviews.reserveApplicationPreparation(prep);
    f.setContextRevision('f'.repeat(40));
    await expect(f.owner.transition.apply(f.context, prep)).rejects.toThrow(
      'Exact bounded sealed review context required',
    );
    expect(f.events.getActiveSymposiumConfig('symposium').revision).toBe(4);
    expect(f.events.getLatestSymposiumAdmission('symposium', 'reviewer', 5)).toBeUndefined();
    f.setContextRevision(commit);
    f.setReviewContext('x'.repeat(48 * 1024 + 1));
    await expect(f.owner.transition.apply(f.context, prep)).rejects.toThrow(
      'Exact bounded sealed review context required',
    );
    expect(f.events.getActiveSymposiumConfig('symposium').revision).toBe(4);
  } finally {
    f.leaseHost.close();
    f.reviews.close();
    f.events.close();
  }
});

it('refuses partial review evidence before any reader admission', async () => {
  const f = fixture();
  try {
    const prep = await f.owner.transition.prepare({
      context: f.context,
      workflowId: 'workflow',
      attemptId: 'review-1',
      kind: 'review',
      selection: f.reviews.get('workflow')!.reviewer,
      artifactRevision: commit,
      artifactHash: treeDigest,
      policy: f.reviews.get('workflow')!.limits as any,
    });
    f.reviews.reserveApplicationPreparation(prep);
    const complete = {
      version: 2,
      sourceOid: commit,
      baseOid: 'c'.repeat(40),
      baseBranch: 'main',
      committedTreeDigest: treeDigest,
      manifestDigest: 'e'.repeat(64),
      trackedFileCount: 0,
      changedPathCount: 1,
      omittedPathCount: 0,
      files: [
        {
          path: 'marker.txt',
          status: 'present',
          representation: 'content',
          complete: true,
          content: 'tested',
          diff: null,
          contentTruncated: false,
          diffTruncated: false,
        },
      ],
    };
    for (const partial of [
      { ...complete, changedPathCount: 2, omittedPathCount: 1 },
      { ...complete, files: [{ ...complete.files[0], complete: false, contentTruncated: true }] },
      { ...complete, files: [{ ...complete.files[0], complete: false, diffTruncated: true }] },
    ]) {
      f.setReviewContext(JSON.stringify(partial));
      await expect(f.owner.transition.apply(f.context, prep)).rejects.toThrow(
        'Complete sealed review context required',
      );
      expect(f.events.getActiveSymposiumConfig('symposium').revision).toBe(4);
      expect(f.events.getLatestSymposiumAdmission('symposium', 'reviewer', 5)).toBeUndefined();
    }
  } finally {
    f.leaseHost.close();
    f.reviews.close();
    f.events.close();
  }
});

it('admits a complete 25 KiB changed-file representation', async () => {
  const f = fixture();
  try {
    const prep = await f.owner.transition.prepare({
      context: f.context,
      workflowId: 'workflow',
      attemptId: 'review-1',
      kind: 'review',
      selection: f.reviews.get('workflow')!.reviewer,
      artifactRevision: commit,
      artifactHash: treeDigest,
      policy: f.reviews.get('workflow')!.limits as any,
    });
    f.reviews.reserveApplicationPreparation(prep);
    const content = 'M'.repeat(25 * 1024);
    f.setReviewContext(
      JSON.stringify({
        version: 2,
        sourceOid: commit,
        baseOid: 'c'.repeat(40),
        baseBranch: 'main',
        committedTreeDigest: treeDigest,
        manifestDigest: 'e'.repeat(64),
        trackedFileCount: 0,
        changedPathCount: 1,
        omittedPathCount: 0,
        files: [
          {
            path: 'medium.txt',
            status: 'present',
            representation: 'content',
            complete: true,
            content,
            diff: null,
            contentTruncated: false,
            diffTruncated: false,
          },
        ],
      }),
    );
    const admitted = await f.owner.transition.apply(f.context, prep);
    expect(admitted.attempt.binding).toMatchObject({ deliveryId: 'delivery-1' });
    expect(f.events.getLatestSymposiumAdmission('symposium', 'reviewer', 5)).toMatchObject({
      decision: 'admitted',
    });
    expect(f.events.getSymposiumDelivery('delivery-1')?.originalContent).toContain(content);
  } finally {
    f.leaseHost.close();
    f.reviews.close();
    f.events.close();
  }
});

it('binds a delta review to one charged reader transition after a lost stage response', async () => {
  const f = fixture();
  try {
    // The workflow lifecycle is covered elsewhere; place this fixture at the delta boundary.
    const db = new Database(f.reviewPath);
    const row = db
      .prepare('SELECT state FROM symposium_review_workflows WHERE workflow_id=?')
      .get('workflow') as { state: string };
    const state = JSON.parse(row.state);
    state.status = 'awaiting_delta_review';
    db.prepare('UPDATE symposium_review_workflows SET state=? WHERE workflow_id=?').run(
      JSON.stringify(state),
      'workflow',
    );
    db.close();
    const prep = await f.owner.transition.prepare({
      context: f.context,
      workflowId: 'workflow',
      attemptId: 'delta-1',
      kind: 'delta',
      selection: f.reviews.get('workflow')!.reviewer,
      artifactRevision: commit,
      artifactHash: treeDigest,
      policy: f.reviews.get('workflow')!.limits as any,
    });
    expect(f.reviews.reserveApplicationPreparation(prep)).toMatchObject({ kind: 'prepared' });
    f.setLoseStageResponse();
    await expect(f.owner.transition.apply(f.context, prep)).rejects.toThrow(/lost stage response/);
    expect(f.reviews.reserveApplicationPreparation(prep)).toMatchObject({
      kind: 'already_prepared',
    });
    const completed = await f.owner.transition.apply(f.context, prep);
    expect(completed.attempt.kind).toBe('delta');
    expect(
      f.reviews.completeApplicationPreparation(completed.attempt, completed.proof),
    ).toMatchObject({ kind: 'admitted' });
    expect(f.events.getActiveSymposiumConfig('symposium').revision).toBe(5);
    expect(f.events.getLatestSymposiumMembership('symposium', 'reviewer')).toMatchObject({
      generation: 2,
      action: 'sealed_reader',
    });
    expect(f.events.getLatestSymposiumAdmission('symposium', 'reviewer', 5)).toMatchObject({
      decision: 'admitted',
    });
    expect(f.reviews.get('workflow')).toMatchObject({ hostTurns: 1, reviewCycles: 0 });
  } finally {
    f.leaseHost.close();
    f.reviews.close();
    f.events.close();
  }
});

import { expect, it, vi } from 'vitest';
import { createSealedFixReviewTransition } from '../symposium-trusted-fix-transition.js';
import { createHash } from 'node:crypto';
import { artifactAdmissionDigest } from '@mitzo/protocol/event-store';
import { canonicalReviewJson, reviewRecordHash } from '../symposium-review-records.js';

const digest = 'a'.repeat(64);
const commit = 'b'.repeat(40);
const context = { owner: 'user', sessionId: 'session' };

it('prepares the exact sealed finding scope without exporting or copying', async () => {
  const exportSuccessor = vi.fn();
  const copy = vi.fn();
  const intent = {
    fenceId: 'fence',
    selection: {
      sessionId: 'session',
      artifact: { volumeGeneration: 'generation', volumeName: 'volume' },
    },
  };
  const seal = {
    fenceId: 'fence',
    sessionId: 'session',
    intentDigest: createHash('sha256').update(JSON.stringify(intent)).digest('hex'),
    git: { commit, committedTreeDigest: digest },
  };
  const transition = createSealedFixReviewTransition({
    events: {
      getActiveSymposiumConfig: () => ({
        version: 2,
        state: 'active',
        revision: 4,
        seats: [
          {
            id: 'coder',
            role: 'coder',
            accountBinding: { accountId: 'account', model: 'luna-fixture', profileRevision: '1' },
            profileBinding: { profileId: 'profile', profileRevision: '1' },
            authorityGrant: { grantId: 'grant', revision: 1, filesystem: 'write', tools: 'write' },
            contextGrant: { grantId: 'context', revision: 1 },
          },
        ],
      }),
      getLatestSymposiumMembership: () => ({
        state: 'active',
        reconciliation: 'confirmed',
        generation: 3,
      }),
      getSymposiumArtifactSealByFence: () => intent,
    },
    reviews: {},
    grants: { verifySeat: vi.fn() },
    workspace: 'workspace',
    currentArtifact: () => ({ revision: commit, hash: digest }),
    sourceFence: () => 'fence',
    requireCompletedSeal: async () => seal,
    baseBranch: () => 'main',
    inspect: vi.fn(),
    exportSuccessor,
    copy,
    activate: vi.fn(),
    admit: vi.fn(),
    currentPointer: vi.fn(),
    runtime: vi.fn(),
  } as never);
  const prepared = await transition.prepare({
    context,
    workflowId: 'workflow',
    attemptId: 'attempt',
    kind: 'fix',
    selection: {
      seatId: 'coder',
      role: 'coder',
      selectionId: 'coder',
      policyRevision: '1',
      accountId: 'account',
      model: 'luna-fixture',
      profileId: 'profile',
      profileRevision: 1,
    },
    artifactRevision: commit,
    artifactHash: digest,
    policy: {} as never,
  });
  expect(prepared).toMatchObject({
    kind: 'fix',
    artifactRevision: commit,
    seal: { fenceId: 'fence', artifactGenerationId: 'generation', volumeName: 'volume' },
    from: { configRevision: 4, membershipGeneration: 3 },
    to: { configRevision: 5, membershipGeneration: 4 },
  });
  expect(exportSuccessor).not.toHaveBeenCalled();
  expect(copy).not.toHaveBeenCalled();
});

it('requires one exact charged owner intent and admits the copied fix child before delivery', async () => {
  const order: string[] = [];
  let revision = 4;
  const finding = 'c'.repeat(64);
  const intent = {
    fenceId: 'fence',
    selection: {
      sessionId: 'session',
      artifact: { volumeGeneration: 'generation', volumeName: 'volume' },
    },
  };
  const seal = {
    kind: 'completed_artifact_seal',
    version: 1,
    fenceId: 'fence',
    sessionId: 'session',
    custodyDigest: digest,
    intentDigest: createHash('sha256').update(JSON.stringify(intent)).digest('hex'),
    retentionDigest: digest,
    revocationDigest: digest,
    repositoryPath: '.',
    git: {
      version: 1,
      commit,
      tree: commit,
      entries: 1,
      bytes: 1,
      manifestDigest: digest,
      committedTreeDigest: digest,
    },
    verifier: { id: digest, image: 'image', codeDigest: digest },
    completedAt: 10,
  };
  let retained: unknown = null;
  const state = {
    owner: 'user',
    sessionId: 'session',
    status: 'awaiting_fix',
    decisionCode: null,
    acceptanceCriteria: ['works'],
    findings: [{ status: 'open', fingerprint: finding, summary: 'repair' }],
    applicationFixIntents: [
      {
        actor: 'user',
        artifactRevision: commit,
        artifactHash: digest,
        findingFingerprints: [finding],
      },
    ],
  };
  const runtime = {
    recordProviderAdmission: vi.fn(() => {
      order.push('provider');
      return {
        decision: 'admitted',
        configRevision: 5,
        membershipGeneration: 4,
      };
    }),
    stageDelivery: vi.fn((input: { originalContent: string }) => {
      order.push('delivery');
      return {
        deliveryId: 'delivery',
        sessionId: 'session',
        status: 'awaiting_intervention',
        originalContent: input.originalContent,
        configRevision: 5,
        recipients: [
          {
            seatId: 'coder',
            membershipGeneration: 4,
            accountProfileRevision: '1',
            seatProfileRevision: '1',
            authorityGrantId: 'grant',
            authorityGrantRevision: 1,
            contextGrantId: 'context',
            contextGrantRevision: 1,
          },
        ],
      };
    }),
  };
  const transition = createSealedFixReviewTransition({
    events: {
      getActiveSymposiumConfig: () => ({
        version: 2,
        state: 'active',
        revision,
        seats: [
          {
            id: 'coder',
            role: 'coder',
            accountBinding: { accountId: 'account', model: 'luna-fixture', profileRevision: '1' },
            profileBinding: { profileId: 'profile', profileRevision: '1' },
            authorityGrant: { grantId: 'grant', revision: 1, filesystem: 'write', tools: 'write' },
            contextGrant: { grantId: 'context', revision: 1 },
          },
        ],
      }),
      getLatestSymposiumMembership: () => ({
        state: 'active',
        reconciliation: 'confirmed',
        generation: 3,
      }),
      getSymposiumArtifactSealByFence: () => intent,
      assertSymposiumArtifactAdmissionCurrent: vi.fn(() => {
        order.push('confirmed');
        revision = 5;
      }),
    },
    reviews: { get: () => state, getApplicationPreparation: () => retained },
    grants: { verifySeat: vi.fn() },
    workspace: 'workspace',
    currentArtifact: () => ({ revision: commit, hash: digest }),
    sourceFence: () => 'fence',
    requireCompletedSeal: async () => seal,
    baseBranch: () => 'main',
    currentPointer: () => ({
      version: 1,
      transitionId: 'old',
      artifactGenerationId: 'generation',
      pointerRevision: 1,
      bindingDigest: digest,
    }),
    inspect: vi.fn(async () => {
      order.push('inspect');
      return {
        sourceBranch: 'feature',
        sourceOid: commit,
      };
    }),
    exportSuccessor: vi.fn(async (input: { operationId: string }) => {
      order.push('export');
      return {
        bundle: Buffer.from('bundle'),
        receipt: {
          version: 1,
          mode: 'successor',
          jobId: 'job',
          operationId: input.operationId,
          parentGenerationId: 'generation',
          parentVolumeName: 'volume',
          parentSealDigest: reviewRecordHash(canonicalReviewJson(seal)),
          seal,
          selection: {},
          bundleSha256: digest,
          bytes: 6,
          helper: {},
        },
      };
    }),
    copy: vi.fn(async () => {
      order.push('copy');
      return {
        generationId: 'child',
        volumeName: 'child-volume',
      };
    }),
    activate: vi.fn(async () => {
      throw new Error('Activation must be part of admission');
    }),
    admit: vi.fn(async (_request: unknown, binding: unknown) => {
      order.push('admit');
      return {
        reference: {
          version: 1,
          transitionId: 'new',
          artifactGenerationId: 'child',
          pointerRevision: 2,
          bindingDigest: artifactAdmissionDigest(binding),
        },
        receipt: {},
      };
    }),
    runtime: () => runtime,
  } as never);
  const prep = await transition.prepare({
    context,
    workflowId: 'workflow',
    attemptId: 'attempt',
    kind: 'fix',
    selection: {
      seatId: 'coder',
      role: 'coder',
      selectionId: 'coder',
      policyRevision: '1',
      accountId: 'account',
      model: 'luna-fixture',
      profileId: 'profile',
      profileRevision: 1,
    },
    artifactRevision: commit,
    artifactHash: digest,
    policy: {} as never,
  });
  retained = { ...prep, status: 'preparing', requestHash: digest };
  state.applicationFixIntents.push({ ...state.applicationFixIntents[0] });
  await expect(transition.apply(context, prep)).rejects.toThrow(
    'owner-authorized fix finding scope',
  );
  expect(order).toEqual([]);
  state.applicationFixIntents.pop();
  const result = await transition.apply(context, prep);
  expect(result.attempt).toMatchObject({
    kind: 'fix',
    actorSeatId: 'coder',
    binding: { deliveryId: 'delivery', configRevision: 5, membershipGeneration: 4 },
  });
  expect(order).toEqual([
    'inspect',
    'export',
    'copy',
    'admit',
    'confirmed',
    'provider',
    'delivery',
  ]);
});

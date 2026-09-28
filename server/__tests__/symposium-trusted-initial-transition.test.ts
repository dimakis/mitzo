import { expect, it, vi } from 'vitest';
import { createSealedInitialReviewTransition } from '../symposium-trusted-initial-transition.js';
import { artifactAdmissionDigest } from '@mitzo/protocol/event-store';

const hash = 'a'.repeat(64);
const oid = 'b'.repeat(40);
const context = { owner: 'user', sessionId: 'session' };
const seat = {
  id: 'coder',
  role: 'coder',
  accountBinding: {
    accountId: 'account',
    accountLabel: 'Account',
    provider: 'openai' as const,
    model: 'luna-fixture',
    profileRevision: '1',
  },
  profileBinding: { profileId: 'profile', profileRevision: '1' },
  authorityGrant: { grantId: 'authority', revision: 1, filesystem: 'write', tools: 'write' },
  contextGrant: { grantId: 'context', revision: 1 },
};
const source = {
  receipt: {
    sessionId: 'session',
    operationId: 'source-seal',
    volumeGeneration: 'source-generation',
    volumeName: 'source-volume',
    git: { commit: oid, committedTreeDigest: hash },
  },
  digest: hash,
};

it('prepares a source child without copying or minting native admission', async () => {
  const copy = vi.fn();
  const transition = createSealedInitialReviewTransition({
    events: {
      getActiveSymposiumConfig: () => ({ version: 2, state: 'active', revision: 1, seats: [seat] }),
      getLatestSymposiumMembership: () => ({
        generation: 1,
        state: 'active',
        reconciliation: 'confirmed',
      }),
    },
    reviews: {},
    grants: { verifySeat: vi.fn() },
    workspace: 'workspace',
    source: { requireSeal: () => source, initialExport: vi.fn() },
    copy,
    activate: vi.fn(),
    admit: vi.fn(),
    runtime: vi.fn(),
  } as never);
  const prep = await transition.prepare({
    context,
    workflowId: 'workflow',
    attemptId: 'attempt',
    kind: 'initial',
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
    artifactRevision: oid,
    artifactHash: hash,
    policy: {} as never,
  });
  expect(prep).toMatchObject({
    kind: 'initial',
    sourceSealId: 'source-seal',
    seal: { artifactGenerationId: 'source-generation', sealDigest: hash },
    from: { configRevision: 1, membershipGeneration: 1 },
    to: { configRevision: 2, membershipGeneration: 2 },
  });
  expect(copy).not.toHaveBeenCalled();
});

it('rejects application of an uncharged initial preparation before physical copy', async () => {
  const copy = vi.fn();
  const transition = createSealedInitialReviewTransition({
    events: {
      getActiveSymposiumConfig: () => ({ version: 2, state: 'active', revision: 1, seats: [seat] }),
      getLatestSymposiumMembership: () => ({
        generation: 1,
        state: 'active',
        reconciliation: 'confirmed',
      }),
    },
    reviews: { get: () => null, getApplicationPreparation: () => null },
    grants: { verifySeat: vi.fn() },
    workspace: 'workspace',
    source: { requireSeal: () => source, initialExport: vi.fn() },
    copy,
    activate: vi.fn(),
    admit: vi.fn(),
    runtime: vi.fn(),
  } as never);
  const prep = await transition.prepare({
    context,
    workflowId: 'workflow',
    attemptId: 'attempt',
    kind: 'initial',
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
    artifactRevision: oid,
    artifactHash: hash,
    policy: {} as never,
  });
  await expect(transition.apply(context, prep)).rejects.toThrow('charged initial preparation');
  expect(copy).not.toHaveBeenCalled();
});

it('copies and confirms the child before admitting the provider and staging delivery', async () => {
  const order: string[] = [];
  let retained: unknown = null;
  const exported = {
    receipt: {
      version: 1,
      mode: 'initial',
      sourceSealId: 'source-seal',
      operationId: 'operation',
      parentGenerationId: 'source-generation',
      parentVolumeName: 'source-volume',
      parentSealDigest: hash,
      seal: {
        sessionId: 'session',
        custodyDigest: hash,
        repositoryPath: '.',
        git: {
          version: 1,
          commit: oid,
          tree: oid,
          entries: 1,
          bytes: 1,
          manifestDigest: hash,
          committedTreeDigest: hash,
        },
      },
      selection: {
        sourceRef: 'refs/heads/source',
        sourceOid: oid,
        baseRef: 'refs/heads/main',
        baseOid: oid,
        defaultBranch: 'main',
        originUrl: 'https://example.test/repo',
      },
      bundleSha256: hash,
      bytes: 1,
      helper: {
        id: hash,
        name: 'source-helper',
        image: 'image',
        codeDigest: hash,
        terminalExitCode: 0,
        removed: true,
      },
    },
    bundle: Buffer.from('bundle'),
  };
  const runtime = {
    recordProviderAdmission: vi.fn(() => {
      order.push('provider');
      return { decision: 'admitted', configRevision: 2, membershipGeneration: 2 };
    }),
    stageDelivery: vi.fn((input: { originalContent: string }) => {
      order.push('delivery');
      return {
        deliveryId: 'delivery',
        sessionId: 'session',
        status: 'awaiting_intervention',
        originalContent: input.originalContent,
        configRevision: 2,
        recipients: [
          {
            seatId: 'coder',
            membershipGeneration: 2,
            accountProfileRevision: '1',
            seatProfileRevision: '1',
            authorityGrantId: 'authority',
            authorityGrantRevision: 1,
            contextGrantId: 'context',
            contextGrantRevision: 1,
          },
        ],
      };
    }),
  };
  const transition = createSealedInitialReviewTransition({
    events: {
      getActiveSymposiumConfig: () => ({ version: 2, state: 'active', revision: 1, seats: [seat] }),
      getLatestSymposiumMembership: () => ({
        generation: 1,
        state: 'active',
        reconciliation: 'confirmed',
      }),
      assertSymposiumArtifactAdmissionCurrent: vi.fn(() => {
        order.push('confirmed');
      }),
    },
    reviews: {
      get: () => ({
        owner: 'user',
        sessionId: 'session',
        status: 'awaiting_initial',
        implementation: null,
        decisionCode: null,
        initialArtifact: { revision: oid, hash },
        acceptanceCriteria: ['works'],
      }),
      getApplicationPreparation: () => retained,
    },
    grants: { verifySeat: vi.fn() },
    workspace: 'workspace',
    source: {
      requireSeal: () => source,
      initialExport: (_sessionId: string, operationId: string) => ({
        ...exported,
        receipt: { ...exported.receipt, operationId },
      }),
    },
    copy: vi.fn(async () => {
      order.push('copy');
      return { generationId: 'child', volumeName: 'child-volume' };
    }),
    activate: vi.fn(async () => {
      order.push('activate');
      return { generationId: 'child', revision: 1 };
    }),
    admit: vi.fn(async (_request: unknown, binding: unknown) => {
      order.push('admit');
      return {
        reference: {
          version: 1,
          transitionId: 'transition',
          artifactGenerationId: 'child',
          pointerRevision: 1,
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
    kind: 'initial',
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
    artifactRevision: oid,
    artifactHash: hash,
    policy: {} as never,
  });
  retained = { ...prep, status: 'preparing', requestHash: hash };
  const result = await transition.apply(context, prep);
  expect(result.attempt).toMatchObject({
    kind: 'initial',
    actorSeatId: 'coder',
    binding: { deliveryId: 'delivery', configRevision: 2, membershipGeneration: 2 },
  });
  expect(order).toEqual(['copy', 'activate', 'admit', 'confirmed', 'provider', 'delivery']);
});

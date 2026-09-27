import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountBindingSchema, type SeatConfig, type SymposiumConfig } from '@mitzo/protocol';
import { AccountProfiles } from '../account-profiles.js';
import { EventStore } from '../event-store.js';
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

const roots: string[] = [];
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function open(path: string) {
  const store = new EventStore(path);
  stores.push(store);
  return store;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-artifact-seal-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const first = open(path);
  first.upsertSession({ sessionId: 'symposium', accountBinding: seat.accountBinding });
  first.setSymposiumConfig('symposium', config);
  return { path, first, second: open(path) };
}
const selection = {
  sessionId: 'symposium',
  expectedConfigRevision: 4,
  idempotencyKey: 'seal-1',
  custody: { workspaceId: 'workspace', gatewayLaunchDigest: 'a'.repeat(64) },
  artifact: {
    driver: 'podman' as const,
    volumeName: 'volume',
    volumeGeneration: 'generation-1',
    leaseRevision: 'lease-1',
    leaseTokenHash: 'b'.repeat(64),
  },
};
it('persists only pending intent across connections/restart and rejects identity substitution', () => {
  const { first, second, path } = fixture();
  const input = structuredClone(selection);
  const intent = first.beginSymposiumArtifactSeal(input);
  input.custody.workspaceId = 'changed';
  intent.selection.custody.workspaceId = 'changed-return';
  const persisted = second.getSymposiumArtifactSealIntent('symposium');
  expect(persisted).toMatchObject({
    kind: 'artifact_seal_intent',
    status: 'pending_unsealed',
    selection,
  });
  expect(persisted).not.toHaveProperty('gitRevision');
  expect(persisted).not.toHaveProperty('quiescence');
  expect(open(path).beginSymposiumArtifactSeal(selection)).toEqual(persisted);
  expect(() =>
    second.beginSymposiumArtifactSeal({
      ...selection,
      custody: { ...selection.custody, workspaceId: 'other' },
    }),
  ).toThrow(/identity changed/);
  expect(() =>
    second.beginSymposiumArtifactSeal({
      ...selection,
      artifact: { ...selection.artifact, leaseRevision: 'lease-2' },
    }),
  ).toThrow(/identity changed/);
  expect(() =>
    first.beginSymposiumArtifactSeal({ ...selection, unexpected: true } as typeof selection),
  ).toThrow();
});
it('serializes lifecycle-before-seal and seal-before-new-work across independent stores', () => {
  const { first, second } = fixture();
  expect(second.claimSymposiumSeatLifecycle('symposium', 'reviewer', 'creating')).toBe(true);
  expect(() => first.beginSymposiumArtifactSeal(selection)).toThrow(/wait for active/);
  expect(first.getSymposiumArtifactSealIntent('symposium')).toBeNull();
  second.releaseSymposiumSeatLifecycle('symposium', 'reviewer', 'creating');
  first.beginSymposiumArtifactSeal(selection);
  expect(() => second.setSymposiumConfig('symposium', { ...config, revision: 5 })).toThrow(
    /fenced/,
  );
  for (const action of ['admit', 'restore'] as const)
    expect(() =>
      second.transitionSymposiumMembership({
        sessionId: 'symposium',
        seatId: 'reviewer',
        action,
        expectedGeneration: 0,
        configRevision: 4,
        actor: 'director',
        reason: 'test',
        idempotencyKey: action,
        occurredAt: 1,
      }),
    ).toThrow(/fenced/);
  const reservation = {
    sessionId: 'symposium',
    seatId: 'reviewer',
    generation: 1,
    runtimeId: 'runtime',
    workspace: 'workspace',
    providerName: 'provider',
    providerId: 'provider-id',
    providerType: 'openai',
    model: 'test',
  };
  expect(() => second.reserveSymposiumSeatSandbox(reservation)).toThrow(/fenced/);
  expect(() => second.markSymposiumSeatSandboxCreationStarted(reservation)).toThrow(/fenced/);
  // Cleanup may acquire its normal custody fence, but cannot clear the session seal.
  expect(second.claimSymposiumSeatLifecycle('symposium', 'reviewer', 'cleanup')).toBe(true);
  second.releaseSymposiumSeatLifecycle('symposium', 'reviewer', 'cleanup');
  expect(() => second.assertSymposiumArtifactWorkAllowed('symposium')).toThrow(/fenced/);
  second.assertSymposiumArtifactWorkAllowed('other-session');
});
it('admits only a confirmed exact successor and preserves parent seal history', () => {
  const { first, second } = fixture();
  first.transitionSymposiumMembership({
    sessionId: 'symposium',
    seatId: seat.id,
    action: 'admit',
    expectedGeneration: 0,
    configRevision: 4,
    actor: 'owner',
    reason: 'initial',
    idempotencyKey: 'initial',
    occurredAt: 1,
  });
  first.markSymposiumMembershipReconciled('symposium', seat.id, 1, 'confirmed');
  const sandbox = {
    sessionId: 'symposium',
    seatId: seat.id,
    generation: 1,
    runtimeId: 'parent-runtime',
    workspace: 'workspace',
    providerName: 'provider',
    providerId: 'provider-id',
    providerType: 'openai',
    model: seat.model,
  };
  first.reserveSymposiumSeatSandbox(sandbox);
  first.confirmAbsentSymposiumSeatSandboxStopped(sandbox);
  const parent = first.beginSymposiumArtifactSeal(selection);
  const binding = {
    version: 1 as const,
    transitionId: 'transition',
    operationId: 'copy',
    sessionId: 'symposium',
    workspaceId: 'workspace',
    custodyDigest: 'a'.repeat(64),
    parentGenerationId: 'generation-1',
    parentFenceId: parent.fenceId,
    parentSealDigest: 'c'.repeat(64),
    childGenerationId: 'generation-2',
    childVolumeName: 'child-volume',
    copyReceiptDigest: 'd'.repeat(64),
    expectedPointerRevision: 0,
    activatedPointerRevision: 1,
    workflowId: 'workflow',
    fixAttemptId: 'fix',
    policyReservationId: 'reservation',
    seatId: seat.id,
    actor: 'owner',
    expectedConfigRevision: 4,
    resultingConfigRevision: 5,
    predecessorMembershipGeneration: 1,
    successorMembershipGeneration: 2,
    accountBinding: seat.accountBinding,
    profileBinding: seat.profileBinding,
    contextGrant: { grantId: seat.contextGrant.grantId, revision: 1 },
    authorityGrant: { grantId: seat.authorityGrant.grantId, revision: 1 },
    findingFingerprints: ['e'.repeat(64)],
  };
  const intent = first.beginSymposiumArtifactAdmission(binding, () => true);
  expect(() => second.assertSymposiumArtifactWorkAllowed('symposium', intent.reference)).toThrow();
  const receipt = {
    version: 1 as const,
    transitionId: binding.transitionId,
    bindingDigest: intent.reference.bindingDigest,
    sessionId: binding.sessionId,
    parentGenerationId: binding.parentGenerationId,
    childGenerationId: binding.childGenerationId,
    childVolumeName: binding.childVolumeName,
    expectedPointerRevision: 0,
    pointerRevision: 1,
    copyReceiptDigest: binding.copyReceiptDigest,
  };
  expect(() =>
    second.confirmSymposiumArtifactAdmission(
      binding,
      { ...receipt, pointerRevision: 2 },
      () => true,
    ),
  ).toThrow();
  second.confirmSymposiumArtifactAdmission(binding, receipt, () => true);
  expect(first.getLatestSymposiumMembership('symposium', seat.id)).toMatchObject({
    action: 'artifact_successor',
    generation: 2,
    configRevision: 5,
  });
  first.assertSymposiumArtifactWorkAllowed('symposium', intent.reference);
  expect(() => first.assertSymposiumArtifactWorkAllowed('symposium')).toThrow();
  expect(first.getSymposiumArtifactReference('symposium', seat.id, 1)).toBeNull();
  expect(first.getSymposiumArtifactReference('symposium', seat.id, 2)).toEqual(intent.reference);
  first.beginSymposiumArtifactSeal({
    ...selection,
    expectedConfigRevision: 5,
    idempotencyKey: 'child-seal',
    artifact: {
      ...selection.artifact,
      volumeName: 'child-volume',
      volumeGeneration: 'generation-2',
    },
  });
  expect(first.getSymposiumArtifactSealIntent('symposium', 'generation-1')).toEqual(parent);
  expect(() => first.getSymposiumArtifactSealIntent('symposium')).toThrow(/ambiguous/i);
  expect(() => first.assertSymposiumArtifactWorkAllowed('symposium', intent.reference)).toThrow();
});

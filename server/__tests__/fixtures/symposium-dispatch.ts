import { vi } from 'vitest';
import { AccountProfiles } from '../../account-profiles.js';
import type { SymposiumSeatExecution } from '../../symposium-orchestrator.js';
import { AccountBindingSchema, type SymposiumConfig } from '@mitzo/protocol';
import type { SymposiumDispatchFacts } from '../../symposium-dispatch-boundary.js';

export function symposiumDispatchFixture() {
  const profiles = new AccountProfiles([
    {
      id: 'personal',
      label: 'Personal',
      provider: 'openai',
      credentialRef: { provider: 'keychain', service: 'mitzo', account: 'personal' },
      models: [{ id: 'offline-model', label: 'Offline' }],
    },
  ]);
  const binding = AccountBindingSchema.parse(profiles.resolve('personal', 'offline-model'));
  const seat = {
    id: 'contributor',
    name: 'Contributor',
    role: 'coder',
    model: binding.model,
    accountBinding: binding,
    systemPrompt: 'Contribute only to the selected artifact.',
    color: '#335577',
    profileBinding: { profileId: 'inline', profileRevision: '1' },
    contextGrant: {
      grantId: 'context',
      revision: 1,
      classification: 'mixed' as const,
      sourceRefs: [],
    },
    authorityGrant: {
      grantId: 'authority',
      revision: 1,
      filesystem: 'write' as const,
      tools: 'write' as const,
      network: 'restricted' as const,
    },
    isolationRequest: {
      trustDomainId: 'ordinary-session',
      revision: 1,
      placement: 'reuse-compatible' as const,
    },
  };
  const controller = new AbortController();
  const input: SymposiumSeatExecution = {
    sessionId: 'parent',
    deliveryId: 'delivery',
    seat,
    content: 'Selected artifact excerpt.',
    idempotencyKey: 'recipient-key',
    claimToken: 'claim',
    signal: controller.signal,
    provenance: {
      version: 2,
      seatId: seat.id,
      seatLabel: seat.name,
      seatRole: seat.role,
      configRevision: 2,
      accountProfileRevision: binding.profileRevision,
      seatProfileRevision: '1',
      contextGrantRevision: 1,
      authorityGrantRevision: 1,
      isolationDomainId: 'ordinary-session',
      isolationDomainRevision: 1,
      membershipGeneration: 1,
      capturedAt: 1,
      accountBinding: binding,
      reasoningEffort: null,
      profileBinding: seat.profileBinding,
      contextGrant: { grantId: 'context', revision: 1 },
      authorityGrant: { grantId: 'authority', revision: 1 },
    },
  };
  const config: SymposiumConfig = {
    version: 2,
    revision: 2,
    state: 'active',
    anchorSeatId: seat.id,
    activeSeatCap: 3,
    seats: [seat],
    turnRules: { mode: 'directed', maxTurns: 8 },
    interceptMode: 'manual',
  };
  const facts: SymposiumDispatchFacts = {
    assertSymposiumArtifactWorkAllowed: vi.fn(),
    getActiveSymposiumConfig: () => config,
    getLatestSymposiumMembership: () => ({
      sessionId: 'parent',
      seatId: seat.id,
      generation: 1,
      state: 'active',
      action: 'admit',
      configRevision: 2,
      bindingKey: 'binding',
      actor: 'user',
      reason: 'Selected contributor',
      idempotencyKey: 'member',
      occurredAt: 1,
      reconciliation: 'confirmed',
      replacesSeatId: null,
      replacedBySeatId: null,
    }),
    getLatestSymposiumAdmission: () => ({
      admissionId: 'admission',
      sessionId: 'parent',
      seatId: seat.id,
      membershipGeneration: 1,
      decision: 'admitted',
      reason: null,
      idempotencyKey: 'admit',
      configRevision: 2,
      provider: binding.provider,
      accountId: binding.accountId,
      model: binding.model,
      accountProfileRevision: binding.profileRevision,
      isolationDomainId: 'ordinary-session',
      isolationDomainRevision: 1,
      decidedAt: 1,
    }),
    getSymposiumDelivery: () => ({
      sessionId: 'parent',
      status: 'delivering',
      deliveredContent: input.content,
      recipients: [
        {
          seatId: seat.id,
          status: 'executing',
          idempotencyKey: input.idempotencyKey,
          membershipGeneration: 1,
        },
      ],
    }),
  };
  const hostGrants = { verifySeat: vi.fn() };
  const deps = {
    facts,
    currentProfiles: () => profiles,
    hostGrants,
    assertArtifactCurrent: vi.fn(),
    recordAccepted: vi.fn(() => true),
    recoverCancelled: vi.fn(async () => {
      throw new Error('unknown exact attempt');
    }),
  };
  return { input, controller, config, profiles, deps };
}

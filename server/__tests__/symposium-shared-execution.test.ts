import { describe, expect, it, vi } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
import type { SymposiumSeatExecution } from '../symposium-orchestrator.js';
import { AccountBindingSchema, type SymposiumConfig } from '@mitzo/protocol';
import type { SymposiumDispatchFacts } from '../symposium-seat-runtime.js';
import {
  admitSymposiumSharedDispatch,
  SymposiumSharedSeatExecutor,
  type OrdinarySymposiumTurn,
} from '../symposium-shared-execution.js';

function fixture() {
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

describe('ordinary account execution through existing Symposium owners', () => {
  it('admits an ordinary account without requiring a native sandbox provider or saved recipe', () => {
    const f = fixture();
    expect(admitSymposiumSharedDispatch(f.deps, f.input)).toEqual(f.input.seat.accountBinding);
    expect(f.deps.hostGrants.verifySeat).toHaveBeenCalledWith({
      sessionId: 'parent',
      seat: f.input.seat,
      membershipGeneration: 1,
    });
  });

  it.each([
    'reviewer',
    'read-grant',
    'no-tools',
    'wrong-provenance',
    'stale-admission',
    'stopped',
    'dedicated-isolation',
  ])('rejects %s before ordinary dispatch', (caseName) => {
    const f = fixture();
    if (caseName === 'reviewer') f.input.seat.role = 'reviewer';
    if (caseName === 'read-grant')
      Object.assign(f.input.seat.authorityGrant!, { filesystem: 'read' });
    if (caseName === 'no-tools') Object.assign(f.input.seat.authorityGrant!, { tools: 'none' });
    if (caseName === 'wrong-provenance') f.input.provenance.configRevision = 3;
    if (caseName === 'stale-admission') f.deps.facts.getLatestSymposiumAdmission = () => null;
    if (caseName === 'stopped') f.controller.abort();
    if (caseName === 'dedicated-isolation')
      Object.assign(f.input.seat.isolationRequest!, { placement: 'dedicated' });
    expect(() => admitSymposiumSharedDispatch(f.deps, f.input)).toThrow();
  });

  it('resumes only the existing contributor thread and stamps provider acceptance through the claim owner', async () => {
    const f = fixture();
    f.input.providerThreadId = 'ordinary-child';
    const turn: OrdinarySymposiumTurn = {
      run: vi.fn(async (input, callbacks) => {
        callbacks.beforeDispatch();
        callbacks.accepted('ordinary-child', 'turn-2');
        return { providerThreadId: 'ordinary-child', content: 'Contribution.' };
      }),
      cancelAndDrain: vi.fn(async () => {}),
    };
    const openOrdinary = vi.fn(async () => turn);
    const executor = new SymposiumSharedSeatExecutor({ ...f.deps, openOrdinary });
    await expect(executor.execute(f.input)).resolves.toEqual({
      providerThreadId: 'ordinary-child',
      content: 'Contribution.',
    });
    expect(openOrdinary).toHaveBeenCalledWith({
      execution: f.input,
      binding: f.input.seat.accountBinding,
    });
    expect(f.deps.recordAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        claimToken: 'claim',
        providerThreadId: 'ordinary-child',
        providerTurnId: 'turn-2',
      }),
    );
  });

  it('rechecks authority at the provider boundary after async startup', async () => {
    const f = fixture();
    const run = vi.fn(async (_input, callbacks) => {
      f.config.revision++;
      callbacks.beforeDispatch();
      return { providerThreadId: 'child', content: 'invalid' };
    });
    const executor = new SymposiumSharedSeatExecutor({
      ...f.deps,
      openOrdinary: async () => ({ run, cancelAndDrain: async () => {} }),
    });
    await expect(executor.execute(f.input)).rejects.toThrow(/configuration changed/);
  });

  it('cannot complete a different thread or without an acceptance receipt', async () => {
    const f = fixture();
    f.input.providerThreadId = 'child';
    const executor = new SymposiumSharedSeatExecutor({
      ...f.deps,
      openOrdinary: async () => ({
        run: async (_input, callbacks) => {
          callbacks.beforeDispatch();
          callbacks.accepted('other-child', 'turn');
          return { providerThreadId: 'other-child', content: 'invalid' };
        },
        cancelAndDrain: async () => {},
      }),
    });
    await expect(executor.execute(f.input)).rejects.toThrow(/thread/);
    const missing = new SymposiumSharedSeatExecutor({
      ...f.deps,
      openOrdinary: async () => ({
        run: async (_input, callbacks) => {
          callbacks.beforeDispatch();
          return { providerThreadId: 'child', content: 'invalid' };
        },
        cancelAndDrain: async () => {},
      }),
    });
    await expect(missing.execute(f.input)).rejects.toThrow(/acceptance/);
  });

  it('Stop waits for startup and exact drain, preserving uncertainty on failed cleanup', async () => {
    const f = fixture();
    let resolveOpen!: (turn: OrdinarySymposiumTurn) => void;
    let resolveDrain!: () => void;
    const open = new Promise<OrdinarySymposiumTurn>((resolve) => {
      resolveOpen = resolve;
    });
    const drained = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    const run = vi.fn(async () => ({ providerThreadId: 'child', content: 'late' }));
    const cancelAndDrain = vi.fn(() => drained);
    const executor = new SymposiumSharedSeatExecutor({ ...f.deps, openOrdinary: () => open });
    const executing = executor.execute(f.input);
    const rejected = expect(executing).rejects.toThrow();
    const cancelled = executor.cancel({ claimToken: 'claim', idempotencyKey: 'recipient-key' });
    let stopped = false;
    void cancelled.then(() => {
      stopped = true;
    });
    resolveOpen({ run, cancelAndDrain });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveDrain();
    await cancelled;
    await rejected;
    expect(run).not.toHaveBeenCalled();
    expect(cancelAndDrain).toHaveBeenCalledTimes(1);
    await expect(
      executor.cancel({ claimToken: 'unknown', idempotencyKey: 'recipient-key' }),
    ).rejects.toThrow('unknown exact attempt');
  });

  it('rejects duplicate active claims and cancellation targeting another recipient', async () => {
    const f = fixture();
    const executor = new SymposiumSharedSeatExecutor({
      ...f.deps,
      openOrdinary: () => new Promise(() => {}),
    });
    void executor.execute(f.input).catch(() => {});
    await expect(executor.execute(f.input)).rejects.toThrow(/already/);
    await expect(
      executor.cancel({ claimToken: 'claim', idempotencyKey: 'another-recipient' }),
    ).rejects.toThrow(/identity/);
  });

  it('reobserves the same exact attempt after failed cleanup instead of caching uncertainty forever', async () => {
    const f = fixture();
    const cancelAndDrain = vi
      .fn()
      .mockRejectedValueOnce(new Error('terminal unconfirmed'))
      .mockResolvedValueOnce(undefined);
    const run = vi.fn(() => new Promise<never>(() => {}));
    const executor = new SymposiumSharedSeatExecutor({
      ...f.deps,
      openOrdinary: async () => ({ run, cancelAndDrain }),
    });
    void executor.execute(f.input).catch(() => {});
    await Promise.resolve();
    await expect(
      executor.cancel({ claimToken: 'claim', idempotencyKey: 'recipient-key' }),
    ).rejects.toThrow('terminal unconfirmed');
    await expect(
      executor.cancel({ claimToken: 'claim', idempotencyKey: 'recipient-key' }),
    ).resolves.toBeUndefined();
    expect(cancelAndDrain).toHaveBeenCalledTimes(2);
  });
});

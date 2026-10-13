import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRuntimeBindingV2Schema, type OrdinaryLocalCommandAdmission } from '@mitzo/protocol';
import type {
  OrdinaryLocalCodexAdmissionExpectation,
  OrdinaryLocalCodexAdmissionLease,
  OrdinaryLocalCodexAdmissionEffects,
} from '../ordinary-local-codex-admission.js';
import { EventStore } from '../event-store.js';
import { OrdinaryLocalCodexAdmissionCoordinator } from '../ordinary-local-codex-admission.js';
import { ordinaryLocalCodexBootstrapId } from '../ordinary-local-codex-admission.js';

// Entirely offline authority/store fixtures. No provider or credential access.
function fixture(realStore?: EventStore, enabled = true, hasAuthority = true) {
  const binding = {
    version: 2,
    account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'profile-1' },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'target-1' },
  };
  const context: { source: string; revision: string | null } = { source: 'none', revision: null };
  const selection = {
    version: 1,
    agent: { profileId: 'agent', revision: 1 },
    context,
    permission: { mode: 'agent', revision: 1 },
    model: 'fixture-model',
    thinking: 'low',
  };
  const request = {
    clientMsgId: 'command',
    capabilityRevision: 'cap-1',
    runtime: { account: binding.account, harness: 'codex', targetId: 'mac', mode: 'agent' },
    selection,
    payload: { text: 'offline' },
  };
  const trace: string[] = [];
  let state: OrdinaryLocalCommandAdmission['state'] = 'reserved';
  const store = {
    admitOrdinaryLocalCommand: vi.fn<EventStore['admitOrdinaryLocalCommand']>(
      (meta, runtime, input) => {
        trace.push('persist');
        return {
          duplicate: false,
          admission: {
            version: 1,
            binding: SessionRuntimeBindingV2Schema.parse(runtime),
            workspace: { workspaceId: meta.repositoryWorkspaceId!, cwd: meta.cwd! },
            selection: input.selection,
            requestFingerprint: input.requestFingerprint,
            state,
          },
        };
      },
    ),
    claimOrdinaryLocalCommandDispatch: vi.fn(() => {
      trace.push('claim');
      if (state !== 'reserved') return false;
      state = 'uncertain';
      return true;
    }),
    completeOrdinaryLocalCommand: vi.fn(() => {
      trace.push('complete');
      state = 'consumed';
    }),
  };
  const catalog = {
    resolve: vi.fn(() => ({ status: 'compatible', binding })),
    inventory: () => ({
      capabilityRevision: 'cap-1',
      accounts: [
        {
          account: binding.account,
          models: [{ id: 'fixture-model', reasoningEfforts: ['low'] }],
          modelDiscovery: { stale: false },
        },
      ],
    }),
  };
  const lease = { assertCurrent: vi.fn(async () => {}) };
  const authority = {
    withAdmission: vi.fn<
      (
        expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
        operation: (lease: OrdinaryLocalCodexAdmissionLease) => Promise<{ dispatched: boolean }>,
      ) => Promise<{ dispatched: boolean }>
    >(async (_expected, operation) => {
      trace.push('authorize');
      return operation(lease);
    }),
  };
  const effects = {
    prepareWorkspace: vi.fn<OrdinaryLocalCodexAdmissionEffects['prepareWorkspace']>(async () => {
      trace.push('prepare');
    }),
    dispatch: vi.fn<OrdinaryLocalCodexAdmissionEffects['dispatch']>(async () => {
      trace.push('dispatch');
    }),
  };
  const dependencies = {
    enabled,
    store: realStore ?? store,
    catalog,
    declaration: {
      targetId: 'mac',
      targetRevision: 'target-1',
      hostId: 'host',
      runtimeContractRevision: 'runtime-1',
      location: 'local',
      harness: 'codex',
    },
    authority: hasAuthority ? authority : undefined,
  };
  const coordinator = new OrdinaryLocalCodexAdmissionCoordinator(dependencies as never);
  const meta = {
    sessionId: 'session',
    repositoryWorkspaceId: 'workspace',
    cwd: '/offline/workspace',
    accountBinding: { ...binding.account, accountLabel: 'Personal', model: 'fixture-model' },
  };
  return {
    coordinator,
    request,
    meta,
    trace,
    store,
    authority,
    effects,
    catalog,
    lease,
    dependencies,
  };
}

function recipeMetadata() {
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const recipe = {
    version: 1,
    source: 'workspace',
    files: [],
    tokenBudget: 256,
    required: [],
    excluded: [],
  };
  const definition = {
    name: 'Agent',
    descriptor: 'Test',
    role: 'agent',
    instructions: 'Offline',
    expectedOutput: 'Evidence',
    acceptanceCriteria: ['Use evidence'],
    modelPolicyRole: 'agent',
    contextRecipe: recipe,
  };
  const profile = { profileId: 'agent', revision: 1, definition, contentHash: hash(definition) };
  const context = {
    type: 'boot_context',
    source: 'contexgin',
    sourceCount: 0,
    tokenCount: 1,
    tokenBudget: 256,
    sources: [],
    included: [],
    trimmed: [],
    fullMarkdown: 'Offline',
  };
  const snapshot = {
    source: 'workspace',
    compilerRevision: 'fixture',
    recipeHash: hash(recipe),
    payloadHash: hash(context),
    workspaceIdentity: 'b'.repeat(64),
    context,
    profileId: 'agent',
    revision: 1,
    profileHash: profile.contentHash,
  };
  return { profile, snapshot };
}

describe('guarded local Codex coordinator', () => {
  it.each(['disabled', 'missing-authority'])('fails closed when %s', async (kind) => {
    const f = fixture(undefined, kind !== 'disabled', kind !== 'missing-authority');
    await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow('unavailable');
    expect(f.trace).toEqual([]);
  });
  it.each([
    { agentId: 'agent', revision: 'agent-1' },
    { profileId: 'agent', revision: 0 },
    { profileId: 'agent', revision: '1' },
  ])('rejects noncanonical agent profile identity %s before authority', async (agent) => {
    const f = fixture();
    Object.assign(f.request.selection, { agent });
    await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow(
      'invalid_request',
    );
    expect(f.trace).toEqual([]);
  });
  it.each([
    { mode: 'auto' },
    { selectedModel: 'other' },
    { reasoningEffort: 'high' },
    {
      accountBinding: {
        accountId: 'personal',
        accountLabel: 'Personal',
        provider: 'openai-codex',
        profileRevision: 'profile-1',
        model: 'other',
      },
    },
    { agentProfile: { profileId: 'other', revision: 1 } },
    { agentContext: { source: 'workspace', recipeHash: 'other' } },
  ])('rejects metadata contradicting qualified command %s before authority', async (metadata) => {
    const f = fixture();
    Object.assign(f.meta, metadata);
    await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow('metadata');
    expect(f.trace).toEqual([]);
  });
  it('derives absent picker fields from qualified command settings', async () => {
    const f = fixture();
    await f.coordinator.admit(f.meta, f.request, f.effects);
    expect(f.store.admitOrdinaryLocalCommand.mock.calls[0][0]).toMatchObject({
      mode: 'agent',
      selectedModel: 'fixture-model',
      reasoningEffort: 'low',
    });
  });
  it('passes a supplied canonical profile snapshot to owning authority', async () => {
    const f = fixture();
    const definition = {
      name: 'Agent',
      descriptor: 'Test',
      role: 'agent',
      instructions: 'Offline',
      expectedOutput: 'Evidence',
      acceptanceCriteria: ['Use evidence'],
      modelPolicyRole: 'agent',
    };
    const profile = {
      profileId: 'agent',
      revision: 1,
      definition,
      contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
    };
    Object.assign(f.meta, { agentProfile: profile });
    await f.coordinator.admit(f.meta, f.request, f.effects);
    expect(f.authority.withAdmission.mock.calls[0][0].agentProfile).toEqual(profile);
  });
  it('passes exact supplied recipe and profile snapshots to authority and persistence', async () => {
    const f = fixture();
    const { profile, snapshot } = recipeMetadata();
    Object.assign(f.meta, { agentProfile: profile, agentContext: snapshot });
    f.request.selection.context = { source: 'workspace', revision: snapshot.recipeHash };
    await f.coordinator.admit(f.meta, f.request, f.effects);
    expect(f.authority.withAdmission.mock.calls[0][0]).toMatchObject({
      agentProfile: profile,
      agentContext: snapshot,
    });
    expect(f.store.admitOrdinaryLocalCommand.mock.calls[0][0]).toMatchObject({
      agentProfile: profile,
      agentContext: snapshot,
    });
  });
  it.each(['recipeHash', 'profileHash', 'profileId', 'revision'])(
    'rejects supplied snapshot %s drift before authority',
    async (field) => {
      const f = fixture();
      const { profile, snapshot } = recipeMetadata();
      f.request.selection.context = { source: 'workspace', revision: snapshot.recipeHash };
      Object.assign(snapshot, {
        [field]: field === 'revision' ? 2 : field === 'profileId' ? 'other' : 'a'.repeat(64),
      });
      Object.assign(f.meta, { agentProfile: profile, agentContext: snapshot });
      await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow('metadata');
      expect(f.trace).toEqual([]);
    },
  );
  it('rejects changed compiled snapshots on an exact SQLite receipt retry', async () => {
    const store = new EventStore(':memory:');
    try {
      const f = fixture(store);
      const { profile, snapshot } = recipeMetadata();
      Object.assign(f.meta, { agentProfile: profile, agentContext: snapshot });
      f.request.selection.context = { source: 'workspace', revision: snapshot.recipeHash };
      await f.coordinator.admit(f.meta, f.request, f.effects);
      const changed = structuredClone(snapshot);
      changed.context.fullMarkdown = 'Changed compiled context';
      changed.payloadHash = createHash('sha256')
        .update(JSON.stringify(changed.context))
        .digest('hex');
      Object.assign(f.meta, { agentContext: changed });
      await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow(
        'identity_conflict',
      );
      expect(f.effects.dispatch).toHaveBeenCalledTimes(1);
      expect(store.getSession('session')?.agentContext?.context.fullMarkdown).toBe('Offline');
    } finally {
      store.close();
    }
  });
  it('rejects changed profile content under the same pin and SQLite receipt', async () => {
    const store = new EventStore(':memory:');
    try {
      const f = fixture(store);
      const { profile } = recipeMetadata();
      const { contextRecipe, ...definition } = profile.definition;
      expect(contextRecipe.source).toBe('workspace');
      const original = {
        ...profile,
        definition,
        contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
      };
      Object.assign(f.meta, { agentProfile: original });
      await f.coordinator.admit(f.meta, f.request, f.effects);
      const changedDefinition = { ...definition, instructions: 'Changed profile instructions' };
      Object.assign(f.meta, {
        agentProfile: {
          ...original,
          definition: changedDefinition,
          contentHash: createHash('sha256').update(JSON.stringify(changedDefinition)).digest('hex'),
        },
      });
      await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow(
        'identity_conflict',
      );
      expect(f.effects.dispatch).toHaveBeenCalledTimes(1);
      expect(store.getSession('session')?.agentProfile?.contentHash).toBe(original.contentHash);
    } finally {
      store.close();
    }
  });
  it('persists exact intent inside owning authority before resource effects', async () => {
    const f = fixture();
    await f.coordinator.admit(f.meta, f.request, f.effects);
    expect(f.trace).toEqual(['authorize', 'persist', 'claim', 'prepare', 'dispatch', 'complete']);
    expect(f.authority.withAdmission.mock.calls[0][0]).toMatchObject({
      hostId: 'host',
      runtimeContractRevision: 'runtime-1',
      workspace: { workspaceId: 'workspace', cwd: '/offline/workspace' },
      selection: f.request.selection,
    });
    expect(f.authority.withAdmission.mock.calls[0][0].selection.agent).toEqual({
      profileId: 'agent',
      revision: 1,
    });
  });
  it.each(['capability', 'model', 'thinking', 'packs', 'extra'])(
    'rejects %s mismatch without mutation/effects',
    async (kind) => {
      const f = fixture();
      if (kind === 'capability') f.request.capabilityRevision = 'old';
      if (kind === 'model') f.request.selection.model = 'other';
      if (kind === 'thinking') f.request.selection.thinking = 'other';
      if (kind === 'packs') {
        f.request.selection.context.source = 'packs';
        f.request.selection.context.revision = 'recipe-1';
      }
      if (kind === 'extra') Object.assign(f.request, { verified: true });
      await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow();
      expect(f.trace).toEqual([]);
    },
  );
  it.each(['workspace', 'contexgin'])(
    'passes canonical %s recipe identity to its owning authority',
    async (source) => {
      const f = fixture();
      f.request.selection.context = { source, revision: 'recipe-1' };
      await f.coordinator.admit(f.meta, f.request, f.effects);
      expect(f.authority.withAdmission.mock.calls[0][0].selection.context).toEqual({
        source,
        revision: 'recipe-1',
      });
    },
  );
  it.each([
    { source: 'none', revision: 'recipe-1' },
    { source: 'workspace', revision: null },
    { source: 'contexgin', revision: null },
    { source: 'inline', revision: 'recipe-1' },
  ])('rejects inconsistent or invented recipe identity %s', async (context) => {
    const f = fixture();
    f.request.selection.context = context;
    await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow(
      'invalid_request',
    );
    expect(f.trace).toEqual([]);
  });
  it('retains the native packs refusal for a well-formed recipe', async () => {
    const f = fixture();
    f.request.selection.context = { source: 'packs', revision: 'recipe-1' };
    await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow(
      'trusted native continuation barrier',
    );
    expect(f.trace).toEqual([]);
  });
  it('fails closed on revoked owning authority without resource effects', async () => {
    const f = fixture();
    f.authority.withAdmission.mockRejectedValue(new Error('revoked'));
    await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow('unavailable');
    expect(f.trace).toEqual([]);
  });
  it('does not replay an uncertain provider failure on exact retry', async () => {
    const f = fixture();
    f.effects.dispatch.mockRejectedValue(new Error('transport lost'));
    await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow('uncertain');
    await f.coordinator.admit(f.meta, f.request, f.effects);
    expect(f.effects.dispatch).toHaveBeenCalledTimes(1);
    expect(f.store.completeOrdinaryLocalCommand).not.toHaveBeenCalled();
  });
  it('does not accept a skipped authority callback', async () => {
    const f = fixture();
    f.authority.withAdmission.mockResolvedValue({ dispatched: true });
    await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow('unavailable');
    expect(f.trace).toEqual([]);
  });
  it.each(['host-route', 'target-revision', 'provider'])(
    'rejects %s configuration drift before authority',
    async (kind) => {
      const f = fixture();
      const resolution = f.catalog.resolve();
      if (kind === 'host-route') resolution.binding.execution.location = 'openshell';
      if (kind === 'target-revision') resolution.binding.execution.targetRevision = 'new-target';
      if (kind === 'provider') resolution.binding.account.provider = 'openai';
      await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow('mismatch');
      expect(f.trace).toEqual([]);
    },
  );
  it('rechecks expiration before provider dispatch and retains uncertainty', async () => {
    const f = fixture();
    f.lease.assertCurrent
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('expired'));
    await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow('uncertain');
    expect(f.effects.prepareWorkspace).toHaveBeenCalledTimes(1);
    expect(f.effects.dispatch).not.toHaveBeenCalled();
    expect(f.store.completeOrdinaryLocalCommand).not.toHaveBeenCalled();
  });
  it('leaves workspace preparation failure uncertain', async () => {
    const f = fixture();
    f.effects.prepareWorkspace.mockRejectedValue(new Error('failed'));
    await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow('uncertain');
    await f.coordinator.admit(f.meta, f.request, f.effects);
    expect(f.effects.prepareWorkspace).toHaveBeenCalledTimes(1);
    expect(f.effects.dispatch).not.toHaveBeenCalled();
  });
  it('retains SQLite command snapshots for retry and rejects changed selections', async () => {
    const store = new EventStore(':memory:');
    try {
      const f = fixture(store);
      await f.coordinator.admit(f.meta, f.request, f.effects);
      expect(store.getOrdinaryLocalCommandAdmission('command')?.state).toBe('consumed');
      await f.coordinator.admit(f.meta, f.request, f.effects);
      expect(f.effects.dispatch).toHaveBeenCalledTimes(1);
      const future = structuredClone(f.request);
      future.clientMsgId = 'new-command';
      await expect(f.coordinator.admit(f.meta, future, f.effects)).rejects.toThrow(
        'identity_conflict',
      );
      expect(store.getOrdinaryLocalCommandAdmission('new-command')).toBeUndefined();
      f.request.selection.permission.revision = 2;
      await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow();
      expect(store.getOrdinaryLocalCommandAdmission('command')?.selection.permission.revision).toBe(
        1,
      );
    } finally {
      store.close();
    }
  });
  it('does not replay a consumed command after cold reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-codex-coordinator-'));
    const path = join(dir, 'events.db');
    let store = new EventStore(path);
    try {
      const first = fixture(store);
      const { profile, snapshot } = recipeMetadata();
      Object.assign(first.meta, { agentProfile: profile, agentContext: snapshot });
      first.request.selection.context = { source: 'workspace', revision: snapshot.recipeHash };
      await first.coordinator.admit(first.meta, first.request, first.effects);
      store.close();
      store = new EventStore(path);
      const resumed = fixture(store);
      const saved = store.getSession('session')!;
      Object.assign(resumed.meta, {
        agentProfile: saved.agentProfile,
        agentContext: saved.agentContext,
      });
      resumed.request.selection.context = {
        source: 'workspace',
        revision: saved.agentContext!.recipeHash,
      };
      expect(
        await resumed.coordinator.admit(resumed.meta, resumed.request, resumed.effects),
      ).toEqual({ dispatched: false });
      expect(resumed.effects.prepareWorkspace).not.toHaveBeenCalled();
      expect(resumed.effects.dispatch).not.toHaveBeenCalled();
      expect(resumed.lease.assertCurrent).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('persists the qualified binding despite resolver mutation during lease await', async () => {
    const f = fixture();
    f.lease.assertCurrent.mockImplementationOnce(async () => {
      f.catalog.resolve().binding.execution.targetRevision = 'mutated-target';
    });
    await f.coordinator.admit(f.meta, f.request, f.effects);
    expect(f.store.admitOrdinaryLocalCommand.mock.calls[0][1]).toMatchObject({
      execution: { targetRevision: 'target-1' },
    });
    expect(f.effects.dispatch.mock.calls[0][0].binding.execution.targetRevision).toBe('target-1');
  });
  it('captures constructor declaration and gate independently of caller mutation', async () => {
    const f = fixture();
    f.dependencies.declaration.hostId = 'mutated-host';
    f.dependencies.enabled = false;
    await f.coordinator.admit(f.meta, f.request, f.effects);
    expect(f.authority.withAdmission.mock.calls[0][0].hostId).toBe('host');
  });
  it('clones workspace intent before asynchronous authority admission', async () => {
    const f = fixture();
    const pending = f.coordinator.admit(f.meta, f.request, f.effects);
    f.meta.cwd = '/changed';
    f.request.payload.text = 'changed';
    await pending;
    expect(f.store.admitOrdinaryLocalCommand.mock.calls[0][0]).toMatchObject({
      cwd: '/offline/workspace',
    });
    expect(f.store.admitOrdinaryLocalCommand.mock.calls[0][2]).toMatchObject({
      payload: { text: 'offline' },
    });
  });
  it('claims only once for concurrent exact admission', async () => {
    const f = fixture();
    await Promise.all([
      f.coordinator.admit(f.meta, f.request, f.effects),
      f.coordinator.admit(f.meta, f.request, f.effects),
    ]);
    expect(f.effects.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('owned runtime bootstrap ordering', () => {
  function bootstrapped() {
    const f = fixture();
    const bootstrap = vi.fn(
      async (
        _expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
        claim: () => boolean,
        operation: (lease: OrdinaryLocalCodexAdmissionLease) => Promise<{ dispatched: boolean }>,
      ) => {
        f.trace.push('configuration');
        if (!claim()) return undefined;
        f.trace.push('bootstrap');
        return operation(f.lease);
      },
    );
    const coordinator = new OrdinaryLocalCodexAdmissionCoordinator({
      ...f.dependencies,
      authority: undefined,
      bootstrapAuthority: { withBootstrap: bootstrap },
    } as never);
    return { ...f, coordinator, bootstrap };
  }

  it('persists uncertainty before owned login/runtime bootstrap and qualifies before workspace', async () => {
    const f = bootstrapped();
    f.lease.assertCurrent.mockImplementation(async () => {
      f.trace.push('verify');
    });
    await expect(f.coordinator.admit(f.meta, f.request, f.effects)).resolves.toEqual({
      dispatched: true,
    });
    expect(f.trace).toEqual([
      'configuration',
      'persist',
      'claim',
      'bootstrap',
      'verify',
      'verify',
      'prepare',
      'verify',
      'dispatch',
      'complete',
    ]);
    const persisted = f.store.admitOrdinaryLocalCommand.mock.calls[0][2];
    expect(f.bootstrap.mock.calls[0][0].bootstrapId).toBe(
      ordinaryLocalCodexBootstrapId(f.meta.sessionId, persisted.requestFingerprint),
    );
    expect(f.bootstrap.mock.calls[0][0].bootstrapId).toMatch(/^[a-f0-9]{64}$/);
    f.trace.length = 0;
    await f.coordinator.admit(f.meta, f.request, f.effects);
    expect(f.bootstrap.mock.calls[1][0].bootstrapId).toBe(f.bootstrap.mock.calls[0][0].bootstrapId);
  });

  it('does not bootstrap again for a consumed or uncertain command', async () => {
    const f = bootstrapped();
    await f.coordinator.admit(f.meta, f.request, f.effects);
    f.trace.length = 0;
    await expect(f.coordinator.admit(f.meta, f.request, f.effects)).resolves.toEqual({
      dispatched: false,
    });
    expect(f.trace).toEqual(['configuration', 'persist', 'claim']);
    expect(f.effects.prepareWorkspace).toHaveBeenCalledTimes(1);
  });

  it('retains uncertainty if runtime qualification fails after bootstrap claim', async () => {
    const f = bootstrapped();
    f.lease.assertCurrent.mockRejectedValue(new Error('revoked'));
    await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow(
      'dispatch_uncertain',
    );
    expect(f.effects.prepareWorkspace).not.toHaveBeenCalled();
    expect(f.effects.dispatch).not.toHaveBeenCalled();
    expect(f.store.completeOrdinaryLocalCommand).not.toHaveBeenCalled();
    await expect(f.coordinator.admit(f.meta, f.request, f.effects)).resolves.toEqual({
      dispatched: false,
    });
  });

  it('rejects a bootstrap owner invoking effects without claiming or invoking twice', async () => {
    const f = bootstrapped();
    f.bootstrap.mockImplementationOnce(async (_expected, _claim, operation) => operation(f.lease));
    await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow(
      'authority_unavailable',
    );
    expect(f.effects.prepareWorkspace).not.toHaveBeenCalled();
    f.bootstrap.mockImplementationOnce(async (_expected, claim, operation) => {
      claim();
      await operation(f.lease);
      return operation(f.lease);
    });
    await expect(f.coordinator.admit(f.meta, f.request, f.effects)).rejects.toThrow(
      'authority_reentry',
    );
    expect(f.effects.dispatch).toHaveBeenCalledTimes(1);
  });
});

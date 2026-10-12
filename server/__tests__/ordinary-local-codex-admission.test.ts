import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { OrdinaryLocalCodexAdmissionCoordinator } from '../ordinary-local-codex-admission.js';

// Entirely offline authority/store fixtures. No provider or credential access.
function fixture(realStore?: EventStore, enabled = true, hasAuthority = true) {
  const binding = {
    version: 2,
    account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'profile-1' },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'target-1' },
  };
  const selection = {
    version: 1,
    agent: { profileId: 'agent', revision: 1 },
    context: { source: 'none', revision: null },
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
  let state = 'reserved';
  const store = {
    admitOrdinaryLocalCommand: vi.fn(() => {
      trace.push('persist');
      return { duplicate: false, admission: { binding, selection, state } };
    }),
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
    withAdmission: vi.fn(async (_expected, operation) => {
      trace.push('authorize');
      return operation(lease);
    }),
  };
  const effects = {
    prepareWorkspace: vi.fn(async () => {
      trace.push('prepare');
    }),
    dispatch: vi.fn(async () => {
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
      await first.coordinator.admit(first.meta, first.request, first.effects);
      store.close();
      store = new EventStore(path);
      const resumed = fixture(store);
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
    expect(f.store.admitOrdinaryLocalCommand.mock.calls[0][1].execution.targetRevision).toBe(
      'target-1',
    );
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

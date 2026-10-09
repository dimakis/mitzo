import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  runSymposiumRoutingDiagnostic,
  DiscoveryNotDispatchedError,
  createSymposiumModelDiscoveryRecovery,
  createDiscoveryOwnedReadyEvidence,
  assertDiscoveryOwnedReadyEvidence,
  assertDiscoveryPhysicalCleanupEvidence,
  type DiscoveryOwnedReadyEvidence,
  type DiscoveryPhysicalCleanupEvidence,
  type DiscoveryNotDispatchedEvidence,
  assertDiscoveryNotDispatchedEvidence,
  runSymposiumModelDiscovery,
  discoveryClaimLabel,
  type DiscoveryReceipt,
  type DiscoveryOperations,
} from '../symposium-model-discovery.js';
function fixture() {
  let receipt: DiscoveryReceipt | undefined;
  let exists = false;
  const events: string[] = [];
  const config = {
    cliSha256: 'a'.repeat(64),
    workloadImage: `sha256:${'b'.repeat(64)}`,
    policySha256: 'c'.repeat(64),
    podmanUrl: 'unix:///private/mock.sock',
    gateway: 'owned',
    workspace: 'work',
    provider: { name: 'personal', id: 'provider-1' },
    routingDiagnostic: {
      format: 'owned-supervisor-console-v1' as const,
      logLevel: 'off,openshell.routing_http=debug' as const,
      supervisorImage: `sha256:${'d'.repeat(64)}`,
    },
  };
  const ops: DiscoveryOperations = {
    withExclusiveAttempt: async (operation) => operation(),
    verifyCustody: async () => {},
    readReceipt: async () => receipt,
    persistReceipt: async (value) => {
      receipt = { ...value };
    },
    clearReceipt: async () => {
      receipt = undefined;
    },
    list: async () =>
      exists
        ? [
            {
              id: 'sandbox-1',
              name: receipt!.name,
              workspace: 'work',
              phase: 'Ready',
              labels: {
                'mitzo.discovery': 'models',
                'mitzo.discovery.claim': discoveryClaimLabel(receipt!.claim),
              },
            },
          ]
        : [],
    create: vi.fn(async () => {
      events.push('create');
      exists = true;
    }),
    attachedProviders: async () => [{ name: 'personal', type: 'codex' }],
    providerInventory: async () => [
      { name: 'personal', id: 'provider-1', type: 'codex', workspace: 'work' },
    ],
    openClient: async () => ({
      initialize: async () => {
        events.push('initialize');
      },
      request: async (method) => {
        events.push(method);
        if (method !== 'account/read') throw Error('inference or catalog forbidden');
        return { account: { type: 'chatgpt', email: 'PRIVATE-account' } };
      },
      close: () => {
        events.push('close');
      },
    }),
    observeRouting: vi.fn(async (value) => {
      expect(value.id).toBe('sandbox-1');
      events.push('observe');
      return {
        source: 'owned-supervisor-console-v1',
        availability: 'captured',
        observations: [
          {
            kind: 'account_check',
            method: 'GET',
            requestOrdinal: 1,
            outcome: 'response',
            statusCode: 403,
            recordedAt: '2026-10-09T00:00:00.000Z',
          },
        ],
      };
    }),
    cancel: async () => {
      events.push('cancel');
    },
    delete: async () => {
      events.push('delete');
      exists = false;
    },
    physicalAbsent: async () => true,
    wait: async () => {},
  };
  return { config, ops, events, receipt: () => receipt };
}
it('uses only initialize/account-read, captures before cleanup and never returns account/catalog', async () => {
  const f = fixture();
  const result = await runSymposiumRoutingDiagnostic(f.config, f.ops);
  expect(result.status).toBe('complete');
  expect(result).toMatchObject({
    inference: false,
    catalogPublication: false,
    networkObservation: { observations: [{ statusCode: 403 }] },
  });
  expect(f.events).toEqual([
    'create',
    'initialize',
    'account/read',
    'observe',
    'close',
    'cancel',
    'delete',
  ]);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|models|lunaModels|modelCount/);
  expect(f.receipt()).toBeUndefined();
});
it('captures account-read failure then completes exact cleanup without another RPC', async () => {
  const f = fixture();
  f.ops.openClient = async () => ({
    initialize: async () => {},
    request: async (method) => {
      f.events.push(method);
      throw Error('PRIVATE-token body');
    },
    close: () => {},
  });
  const result = await runSymposiumRoutingDiagnostic(f.config, f.ops);
  expect(result.status).toBe('failed');
  expect(result.networkObservation?.observations[0].statusCode).toBe(403);
  expect(f.events.filter((x) => x === 'account/read')).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(f.receipt()).toBeUndefined();
});
it.each(['missing-config', 'missing-observer', 'normal-refresh'] as const)(
  'refuses diagnostic allocation for %s',
  async (kind) => {
    const f = fixture();
    const config = { ...f.config };
    if (kind === 'missing-config') delete (config as Partial<typeof config>).routingDiagnostic;
    if (kind === 'missing-observer') delete f.ops.observeRouting;
    const result = await (kind === 'normal-refresh'
      ? runSymposiumModelDiscovery(config, f.ops)
      : runSymposiumRoutingDiagnostic(config, f.ops));
    expect(result.status).not.toBe('complete');
    expect(f.ops.create).not.toHaveBeenCalled();
  },
);
it('does not capture after current ownership drifts and keeps uncertain cleanup journal', async () => {
  const f = fixture();
  let drift = false;
  f.ops.openClient = async () => ({
    initialize: async () => {},
    request: async () => {
      drift = true;
      return { account: { type: 'chatgpt' } };
    },
    close: () => {},
  });
  f.ops.verifyCustody = async () => {
    if (drift) throw Error('owner changed');
  };
  const result = await runSymposiumRoutingDiagnostic(f.config, f.ops);
  expect(result.status).toBe('reconciliation_required');
  expect(f.ops.observeRouting).not.toHaveBeenCalled();
  expect(f.receipt()).toBeDefined();
});
it('rejects raw capture extras and still cleans without exposing them', async () => {
  const f = fixture();
  f.ops.observeRouting = async () => ({
    source: 'owned-supervisor-console-v1',
    availability: 'unavailable',
    observations: [],
    body: 'PRIVATE-token',
  });
  const result = await runSymposiumRoutingDiagnostic(f.config, f.ops);
  expect(result.status).toBe('failed');
  expect(result.networkObservation).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(f.receipt()).toBeUndefined();
});
it('retains finite capture when cleanup is uncertain and never publishes availability', async () => {
  const f = fixture();
  f.ops.physicalAbsent = async () => false;
  const result = await runSymposiumRoutingDiagnostic(f.config, f.ops);
  expect(result.status).toBe('reconciliation_required');
  expect(result.networkObservation?.observations[0].statusCode).toBe(403);
  expect(result.catalogPublication).toBe(false);
  expect(f.receipt()).toBeDefined();
});
it('retains exact positive cleanup capability before journal clear for late acknowledgement loss', async () => {
  const f = fixture();
  let recovery: ReturnType<typeof createSymposiumModelDiscoveryRecovery> | undefined;
  const persist = f.ops.persistReceipt;
  f.ops.persistReceipt = async (receipt, exclusive) => {
    await persist(receipt, exclusive);
    if (receipt.id && !recovery)
      recovery = createSymposiumModelDiscoveryRecovery(f.config, structuredClone(receipt));
  };
  const result = await runSymposiumRoutingDiagnostic(f.config, f.ops, {
    onPhysicalCleanup: (receipt) => recovery!.confirmPhysicalCleanup(receipt),
  });
  expect(result.status).toBe('complete');
  expect(f.receipt()).toBeUndefined();
  const creates = vi.mocked(f.ops.create).mock.calls.length;
  expect(await recovery!(f.ops)).toEqual({ status: 'reconciled', inference: false });
  expect(vi.mocked(f.ops.create).mock.calls).toHaveLength(creates);
  expect(f.events.filter((x) => x === 'account/read')).toHaveLength(1);
});
it('rejects forged cleanup identity and never treats missing journal as positive cleanup', async () => {
  const f = fixture();
  const receipt = {
    name: `md-${'a'.repeat(16)}`,
    id: 'sandbox-1',
    claim: 'b'.repeat(64),
    configHash: createHash('sha256').update(JSON.stringify(f.config)).digest('hex'),
  };
  const recovery = createSymposiumModelDiscoveryRecovery(f.config, receipt);
  expect(() => recovery.confirmPhysicalCleanup({ ...receipt, id: 'replacement' })).toThrow(
    'identity',
  );
  expect(await recovery(f.ops)).toMatchObject({ status: 'reconciliation_required' });
  expect(f.ops.create).not.toHaveBeenCalled();
});
it('retains genuine Ready evidence before revoked durable-ID persistence', async () => {
  const f = fixture();
  const ready = vi.fn();
  let revoked = false;
  const persist = f.ops.persistReceipt;
  f.ops.persistReceipt = async (receipt, exclusive) => {
    if (receipt.id) {
      revoked = true;
      throw Error('revoked before persist');
    }
    await persist(receipt, exclusive);
  };
  f.ops.verifyCustody = async () => {
    if (revoked) throw Error('revoked');
  };
  const result = await runSymposiumRoutingDiagnostic(f.config, f.ops, { onOwnedReady: ready });
  expect(result.status).toBe('reconciliation_required');
  expect(ready).toHaveBeenCalledOnce();
  expect(ready.mock.calls[0][0].id).toBe('sandbox-1');
  expect(ready.mock.calls[0][1].receipt.id).toBe('sandbox-1');
  expect(f.receipt()?.id).toBeUndefined();
  expect(f.events).not.toContain('account/read');
});
it('vends opaque matching physical cleanup evidence only from the real cleanup branch', async () => {
  const f = fixture();
  let ready: DiscoveryOwnedReadyEvidence | undefined;
  let cleanup: DiscoveryPhysicalCleanupEvidence | undefined;
  let recovery: ReturnType<typeof createSymposiumModelDiscoveryRecovery> | undefined;
  const result = await runSymposiumRoutingDiagnostic(f.config, f.ops, {
    onOwnedReady: (receipt, evidence) => {
      ready = evidence;
      recovery = createSymposiumModelDiscoveryRecovery(f.config, receipt, evidence);
    },
    onPhysicalCleanup: (receipt, evidence) => {
      cleanup = evidence;
      recovery!.confirmPhysicalCleanup(receipt, evidence);
    },
  });
  expect(result.status).toBe('complete');
  expect(recovery!.physicalCleanupEvidence()).toBe(cleanup);
  expect(() => assertDiscoveryOwnedReadyEvidence(ready!)).not.toThrow();
  expect(() => assertDiscoveryPhysicalCleanupEvidence(ready!, cleanup!)).not.toThrow();
  expect(() =>
    assertDiscoveryPhysicalCleanupEvidence(ready!, { receipt: cleanup!.receipt }),
  ).toThrow('evidence');
  expect(() => assertDiscoveryOwnedReadyEvidence({ receipt: ready!.receipt })).toThrow('evidence');
  const other = { ...ready!.receipt, claim: 'f'.repeat(64) };
  const otherReady = createDiscoveryOwnedReadyEvidence(f.config, other, {
    id: other.id,
    name: other.name,
    workspace: 'work',
    phase: 'Ready',
    labels: {
      'mitzo.discovery': 'models',
      'mitzo.discovery.claim': discoveryClaimLabel(other.claim),
    },
  });
  expect(() => assertDiscoveryPhysicalCleanupEvidence(otherReady, cleanup!)).toThrow('evidence');
});
it('vends invocation-bound nondispatch evidence only after exact intent cleanup and lock acknowledgement', async () => {
  const f = fixture();
  const origin = {};
  const captured: DiscoveryNotDispatchedEvidence[] = [];
  let checks = 0;
  f.ops.verifyCustody = async () => {
    if (++checks === 2) throw Error('revoked before create');
  };
  f.ops.withExclusiveAttempt = async (fn) => {
    const value = await fn();
    f.events.push('lock-released');
    return value;
  };
  const result = await runSymposiumRoutingDiagnostic(f.config, f.ops, {
    notDispatchedOrigin: origin,
    onNotDispatched: (evidence) => {
      f.events.push('nondispatch');
      captured.push(evidence);
    },
  });
  expect(result.status).toBe('failed');
  expect(f.receipt()).toBeUndefined();
  expect(f.ops.create).not.toHaveBeenCalled();
  expect(captured).toHaveLength(1);
  expect(f.events.slice(-2)).toEqual(['lock-released', 'nondispatch']);
  expect(() => assertDiscoveryNotDispatchedEvidence(f.config, captured[0], origin)).not.toThrow();
  expect(() => assertDiscoveryNotDispatchedEvidence(f.config, captured[0], {})).toThrow('evidence');
  expect(() => assertDiscoveryNotDispatchedEvidence(f.config, { ...captured[0] }, origin)).toThrow(
    'evidence',
  );
  expect(() =>
    assertDiscoveryNotDispatchedEvidence(
      { ...f.config, policySha256: 'f'.repeat(64) },
      captured[0],
      origin,
    ),
  ).toThrow('evidence');
});
it.each(['clear-fails', 'release-fails', 'possibly-dispatched', 'resumed'] as const)(
  'never vends nondispatch evidence for %s',
  async (kind) => {
    const f = fixture();
    const hook = vi.fn();
    if (kind === 'clear-fails' || kind === 'release-fails') {
      let checks = 0;
      f.ops.verifyCustody = async () => {
        if (++checks === 2) throw Error('preflight');
      };
      if (kind === 'clear-fails')
        f.ops.clearUndispatchedReceipt = async () => {
          throw Error('retained intent');
        };
      else
        f.ops.withExclusiveAttempt = async (fn) => {
          await fn();
          throw Error('release failed');
        };
    }
    if (kind === 'possibly-dispatched')
      f.ops.create = vi.fn(async () => {
        throw Error('unproven dispatch');
      });
    if (kind === 'resumed')
      f.ops.readReceipt = async () => ({
        name: `md-${'a'.repeat(16)}`,
        claim: 'b'.repeat(64),
        configHash: createHash('sha256').update(JSON.stringify(f.config)).digest('hex'),
        id: 'sandbox-1',
      });
    await runSymposiumRoutingDiagnostic(f.config, f.ops, {
      notDispatchedOrigin: {},
      onNotDispatched: hook,
    });
    expect(hook).not.toHaveBeenCalled();
  },
);
it('refuses reused invocation origins even for a second genuine clean nondispatch result', async () => {
  const origin = {};
  const evidence: DiscoveryNotDispatchedEvidence[] = [];
  for (let i = 0; i < 2; i++) {
    const f = fixture();
    delete f.ops.observeRouting;
    expect(
      (
        await runSymposiumRoutingDiagnostic(f.config, f.ops, {
          notDispatchedOrigin: origin,
          onNotDispatched: (value) => evidence.push(value),
        })
      ).status,
    ).toBe('failed');
  }
  expect(evidence).toHaveLength(1);
});
it('does not trust a misplaced nondispatch error after a native allocation', async () => {
  const f = fixture();
  const hook = vi.fn();
  f.ops.openClient = async () => ({
    initialize: async () => {},
    request: async () => {
      throw new DiscoveryNotDispatchedError('misplaced host classification');
    },
    close: () => {},
  });
  const result = await runSymposiumRoutingDiagnostic(f.config, f.ops, {
    notDispatchedOrigin: {},
    onNotDispatched: hook,
  });
  expect(result.status).toBe('failed');
  expect(f.events).toContain('delete');
  expect(hook).not.toHaveBeenCalled();
});

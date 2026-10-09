import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  runSymposiumRoutingDiagnostic,
  createSymposiumModelDiscoveryRecovery,
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

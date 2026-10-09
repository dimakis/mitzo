import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  createSymposiumModelDiscoveryRecovery,
  createDiscoveryOwnedReadyEvidence,
  discoveryClaimLabel,
  recoverSymposiumModelDiscovery,
} from '../symposium-model-discovery.js';
import type { DiscoveryOperations } from '../symposium-model-discovery.js';
import { guardDiscoveryOperations } from '../symposium-discovery-custody.js';
const config = {
  cliSha256: 'a'.repeat(64),
  workloadImage: `sha256:${'b'.repeat(64)}`,
  policySha256: 'c'.repeat(64),
  podmanUrl: 'unix:///mock.sock',
  gateway: 'gateway',
  workspace: 'workspace',
  provider: { name: 'provider', id: 'provider-id' },
};
function fixture(id: string | undefined = 'sandbox-id') {
  const receipt = {
    name: `md-${'a'.repeat(16)}`,
    claim: 'b'.repeat(64),
    configHash: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    ...(id ? { id } : {}),
  };
  const ops = {
    withExclusiveAttempt: async (fn: () => Promise<unknown>) => fn(),
    verifyCustody: vi.fn(async () => {}),
    readReceipt: vi.fn(async () => receipt),
    list: vi.fn(async () => []),
    physicalAbsent: vi.fn(async () => true),
    clearReceipt: vi.fn(async () => {}),
    create: vi.fn(),
    openClient: vi.fn(),
    wait: vi.fn(),
  } as unknown as DiscoveryOperations;
  return { receipt, ops };
}
it('cleans only an exact retained journal and never opens a client or creates', async () => {
  const { receipt, ops } = fixture();
  expect((await recoverSymposiumModelDiscovery(config, ops, receipt)).status).toBe('reconciled');
  expect(ops.clearReceipt).toHaveBeenCalledWith(receipt);
  expect(ops.create).not.toHaveBeenCalled();
  expect(ops.openClient).not.toHaveBeenCalled();
});
it.each(['missing', 'changed', 'unknown-id'])('keeps %s recovery fenced', async (kind) => {
  const { receipt, ops } = fixture();
  if (kind === 'missing') ops.readReceipt = async () => undefined;
  if (kind === 'changed') ops.readReceipt = async () => ({ ...receipt, claim: 'c'.repeat(64) });
  if (kind === 'unknown-id') {
    delete receipt.id;
  }
  expect((await recoverSymposiumModelDiscovery(config, ops, receipt)).status).toBe(
    'reconciliation_required',
  );
  expect(ops.clearReceipt).not.toHaveBeenCalled();
  expect(ops.create).not.toHaveBeenCalled();
  expect(ops.openClient).not.toHaveBeenCalled();
});
it('keeps the journal when physical absence is not proved', async () => {
  const { receipt, ops } = fixture();
  ops.physicalAbsent = async () => false;
  expect((await recoverSymposiumModelDiscovery(config, ops, receipt)).status).toBe(
    'reconciliation_required',
  );
  expect(ops.clearReceipt).not.toHaveBeenCalled();
});
it('rejects changed custody before cleanup', async () => {
  const { receipt, ops } = fixture();
  ops.verifyCustody = async () => {
    throw new Error('Changed custody');
  };
  expect((await recoverSymposiumModelDiscovery(config, ops, receipt)).status).toBe(
    'reconciliation_required',
  );
  expect(ops.list).not.toHaveBeenCalled();
  expect(ops.clearReceipt).not.toHaveBeenCalled();
});

it.each(['post-clear-guard', 'lock-release'] as const)(
  'retains exact physical cleanup proof after %s fails',
  async (phase) => {
    const { receipt, ops } = fixture();
    let journal: unknown = receipt;
    let fail = true;
    let authorized = true;
    ops.readReceipt = async () => journal;
    ops.clearReceipt = vi.fn(async () => {
      journal = undefined;
      if (phase === 'post-clear-guard' && fail) authorized = false;
    });
    ops.withExclusiveAttempt = async (fn) => {
      const result = await fn();
      if (phase === 'lock-release' && fail) throw new Error('Lock release failed');
      return result;
    };
    const guarded = guardDiscoveryOperations(ops, () => {
      if (!authorized) throw new Error('Custody postcheck failed');
    });
    const recover = createSymposiumModelDiscoveryRecovery(config, receipt);
    expect((await recover(guarded)).status).toBe('reconciliation_required');
    expect(journal).toBeUndefined();
    fail = false;
    authorized = true;
    // A new process/capability cannot adopt the old closure's cleanup proof.
    expect((await createSymposiumModelDiscoveryRecovery(config, receipt)(guarded)).status).toBe(
      'reconciliation_required',
    );
    expect((await recover(guarded)).status).toBe('reconciled');
    expect(ops.clearReceipt).toHaveBeenCalledTimes(1);
    expect(ops.create).not.toHaveBeenCalled();
    expect(ops.openClient).not.toHaveBeenCalled();
  },
);

it('retained cleanup proof does not bypass changed journal, custody or an occupied lock', async () => {
  const { receipt, ops } = fixture();
  let journal: unknown = receipt;
  ops.readReceipt = async () => journal;
  ops.clearReceipt = async () => {
    journal = undefined;
    throw new Error('Postclear failure');
  };
  const recover = createSymposiumModelDiscoveryRecovery(config, receipt);
  expect((await recover(ops)).status).toBe('reconciliation_required');
  journal = { ...receipt, configHash: 'f'.repeat(64) };
  expect((await recover(ops)).status).toBe('reconciliation_required');
  journal = undefined;
  ops.verifyCustody = async () => {
    throw new Error('Changed custody');
  };
  expect((await recover(ops)).status).toBe('reconciliation_required');
  ops.verifyCustody = async () => {};
  ops.withExclusiveAttempt = async () => {
    throw new Error('Still locked');
  };
  expect((await recover(ops)).status).toBe('reconciliation_required');
});
it.each(['exact', 'forged', 'wrong-id', 'wrong-claim'] as const)(
  'recovers pending journal only with positive same-process Ready evidence: %s',
  async (kind) => {
    const f = fixture();
    const pending = { ...f.receipt };
    delete pending.id;
    let journal: unknown = pending;
    f.ops.readReceipt = async () => journal;
    const row = {
      id: f.receipt.id!,
      name: f.receipt.name,
      workspace: config.workspace,
      phase: 'Ready',
      labels: {
        'mitzo.discovery': 'models',
        'mitzo.discovery.claim': discoveryClaimLabel(f.receipt.claim),
      },
    };
    const proof = createDiscoveryOwnedReadyEvidence(config, f.receipt, row);
    const recovery = createSymposiumModelDiscoveryRecovery(
      config,
      f.receipt,
      kind === 'forged' ? { receipt: f.receipt } : proof,
    );
    let exists = true;
    f.ops.list = async () =>
      exists
        ? [
            {
              ...row,
              ...(kind === 'wrong-id' ? { id: 'replacement' } : {}),
              ...(kind === 'wrong-claim'
                ? { labels: { ...row.labels, 'mitzo.discovery.claim': 'different' } }
                : {}),
            },
          ]
        : [];
    f.ops.persistReceipt = vi.fn(async (value) => {
      journal = value;
    });
    f.ops.cancel = vi.fn(async () => {});
    f.ops.delete = vi.fn(async () => {
      exists = false;
    });
    f.ops.clearReceipt = vi.fn(async () => {
      journal = undefined;
    });
    const result = await recovery(f.ops);
    expect(result.status).toBe(kind === 'exact' ? 'reconciled' : 'reconciliation_required');
    expect(f.ops.create).not.toHaveBeenCalled();
    expect(f.ops.openClient).not.toHaveBeenCalled();
    if (kind === 'exact') {
      expect(f.ops.persistReceipt).toHaveBeenCalledWith(f.receipt, false);
      expect(f.ops.delete).toHaveBeenCalledWith(f.receipt);
    } else {
      expect(f.ops.persistReceipt).not.toHaveBeenCalled();
      expect(f.ops.delete).not.toHaveBeenCalled();
    }
  },
);

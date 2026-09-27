import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { recoverSymposiumModelDiscovery } from '../symposium-model-discovery.js';
import type { DiscoveryOperations } from '../symposium-model-discovery.js';
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

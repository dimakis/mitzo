import { expect, it, vi } from 'vitest';
import { fenceDiscoveryCreation } from '../symposium-discovery-creation.js';
import type { DiscoveryOperations } from '../symposium-model-discovery.js';
const receipt = () => ({ name: 'md-aaaaaaaaaaaaaaaa', claim: 'claim', configHash: 'hash' });
it('retains the workspace creation fence until exact Ready identity is durably journaled', async () => {
  const events: string[] = [];
  const r = receipt();
  const ops = {
    create: async (_receipt: unknown, _config: unknown, dispatch?: () => void) => {
      dispatch?.();
      events.push('create');
    },
    list: async () => [
      {
        id: 'id',
        name: r.name,
        workspace: 'work',
        phase: 'Ready',
        labels: { 'mitzo.discovery': 'models', 'mitzo.discovery.claim': r.claim },
      },
    ],
    persistReceipt: async () => {
      events.push('persist');
    },
    wait: vi.fn(),
  } as unknown as DiscoveryOperations;
  const fenced = fenceDiscoveryCreation(
    ops,
    'work',
    async (_verify, operation) => {
      events.push('lock');
      const result = await operation(() => {});
      events.push('unlock');
      return result;
    },
    () => {},
  );
  await fenced.operations.create(r, {} as never);
  expect(events).toEqual(['lock', 'create', 'persist', 'unlock']);
  expect(r).toHaveProperty('id', 'id');
  expect(fenced.creationUncertain()).toBe(false);
});
it('keeps ambiguous creation quarantined even when helper cleanup later reports absence', async () => {
  const ops = {
    create: async (_receipt: unknown, _config: unknown, dispatch?: () => void) => {
      dispatch?.();
      throw new Error('unknown');
    },
  } as unknown as DiscoveryOperations;
  const fenced = fenceDiscoveryCreation(
    ops,
    'work',
    async (_verify, operation) => operation(() => {}),
    () => {},
  );
  await expect(fenced.operations.create(receipt(), {} as never)).rejects.toThrow();
  expect(fenced.creationUncertain()).toBe(true);
});
it('rejects a substituted physical identity before releasing the creation fence', async () => {
  const ops = {
    create: async (_receipt: unknown, _config: unknown, dispatch?: () => void) => {
      dispatch?.();
    },
    list: async () => [
      { id: 'other', name: receipt().name, workspace: 'other', phase: 'Ready', labels: {} },
    ],
  } as unknown as DiscoveryOperations;
  const fenced = fenceDiscoveryCreation(
    ops,
    'work',
    async (_verify, operation) => operation(() => {}),
    () => {},
  );
  await expect(fenced.operations.create(receipt(), {} as never)).rejects.toThrow('identity');
  expect(fenced.creationUncertain()).toBe(true);
});

it('does not quarantine read-only preflight failure before external dispatch', async () => {
  const ops = {
    create: async () => {
      throw new Error('preflight');
    },
  } as unknown as DiscoveryOperations;
  const fenced = fenceDiscoveryCreation(
    ops,
    'work',
    async (_verify, operation) => operation(() => {}),
    () => {},
  );
  await expect(fenced.operations.create(receipt(), {} as never)).rejects.toThrow();
  expect(fenced.creationUncertain()).toBe(false);
});

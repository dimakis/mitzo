import { afterEach, expect, it } from 'vitest';
import { realpathSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStagingRegistry } from '../symposium-staging-registry.js';
import { writeCustodianRetirementReceipt } from '../symposium-custodian-retirement.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture(capacity = 2) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'staging-register-')));
  chmodSync(root, 0o700);
  roots.push(root);
  const registry = openStagingRegistry(root, capacity);
  const input = {
    ownerChat: 'chat-1',
    purpose: 'continuity-check',
    retentionReason: 'mount-diagnosis',
    reviewAfter: Date.now() + 60_000,
    planDirectory: join(root, 'plan'),
    sourceCommit: 'a'.repeat(40),
    buildSha256: 'b'.repeat(64),
    configSha256: 'c'.repeat(64),
  };
  return { root, registry, input };
}
it('reserves before bootstrap and retains interrupted creation across registry reopening', () => {
  const { root, registry, input } = fixture(1);
  const owner = registry.reserve(input);
  expect(registry.list()).toMatchObject([
    { ...input, launchId: owner.launchId, state: 'launch_uncertain' },
  ]);
  registry.close();
  const reopened = openStagingRegistry(root, 1);
  expect(() => reopened.reserve({ ...input, planDirectory: join(root, 'next') })).toThrow(
    'capacity',
  );
  expect(() => reopened.reserve(input)).toThrow();
  expect(reopened.list()[0].state).toBe('launch_uncertain');
  reopened.close();
});
it('refuses silent capacity changes, stale retention, and duplicate concurrent launch identities', () => {
  const { root, registry, input } = fixture(1);
  expect(() => openStagingRegistry(root, 2)).toThrow('capacity policy');
  const second = openStagingRegistry(root, 1);
  registry.reserve(input);
  expect(() => second.reserve({ ...input, planDirectory: join(root, 'second') })).toThrow(
    'capacity',
  );
  second.close();
  registry.close();
  const f = fixture(2);
  const owner = f.registry.reserve({ ...f.input, reviewAfter: Date.now() + 10 });
  expect(() =>
    f.registry.reserve({ ...f.input, planDirectory: join(f.root, 'new') }, Date.now() + 20),
  ).toThrow('stale');
  owner.uncertain();
  expect(f.registry.list()[0].state).toBe('retirement_uncertain');
  f.registry.close();
});
it('records original instance, fences replacement identities, and frees capacity only after its retirement receipt', () => {
  const { root, registry, input } = fixture(1);
  const owner = registry.reserve(input);
  owner.controller({ instanceId: 'instance-1', epoch: 1 });
  owner.controller({ instanceId: 'instance-1', epoch: 2 });
  expect(() => owner.controller({ instanceId: 'successor', epoch: 3 })).toThrow('identity');
  const stateParent = join(root, 'state');
  mkdirSync(stateParent, { mode: 0o700 });
  const gatewayStateDirectory = join(stateParent, 'gateway');
  mkdirSync(gatewayStateDirectory, { mode: 0o700 });
  owner.retiring();
  expect(() => owner.retired(stateParent)).toThrow('receipt');
  writeCustodianRetirementReceipt({
    stateParent,
    gatewayStateDirectory,
    instanceId: 'instance-1',
    controllerGeneration: 2,
  });
  owner.retired(stateParent);
  expect(registry.list()[0]).toMatchObject({
    state: 'retired',
    instanceId: 'instance-1',
    controllerGeneration: 2,
    retirementStateParent: stateParent,
  });
  expect(() => owner.controller({ instanceId: 'instance-1', epoch: 3 })).toThrow();
  registry.reserve({ ...input, planDirectory: join(root, 'next') });
  registry.close();
});
it('cannot release a slot with another owner receipt or uncertain physical cleanup', () => {
  const { root, registry, input } = fixture(1);
  const owner = registry.reserve(input);
  owner.controller({ instanceId: 'instance-1', epoch: 1 });
  owner.retiring();
  const stateParent = join(root, 'state');
  mkdirSync(stateParent, { mode: 0o700 });
  const gatewayStateDirectory = join(stateParent, 'gateway');
  mkdirSync(gatewayStateDirectory, { mode: 0o700 });
  writeCustodianRetirementReceipt({
    stateParent,
    gatewayStateDirectory,
    instanceId: 'wrong',
    controllerGeneration: 1,
  });
  expect(() => owner.retired(stateParent)).toThrow('identity');
  owner.uncertain();
  expect(() => registry.reserve({ ...input, planDirectory: join(root, 'next') })).toThrow(
    'capacity',
  );
  registry.close();
});
it('rejects private-path aliases and unexpected metadata rather than retaining credentials', () => {
  const { root, registry, input } = fixture();
  expect(() => registry.reserve({ ...input, credential: 'must-not-store' } as never)).toThrow();
  expect(() => registry.reserve({ ...input, reviewAfter: Date.now() - 1 })).toThrow();
  const alias = join(root, 'alias');
  symlinkSync(root, alias);
  expect(() => openStagingRegistry(alias, 2)).toThrow();
  registry.close();
});

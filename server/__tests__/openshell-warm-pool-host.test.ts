import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startWarmPoolHost } from '../openshell-warm-pool-host.js';
import type { OpenShellRuntimeConfig } from '../openshell-runtime.js';
import { getOpenShellWarmPool } from '../openshell-warm-pool-binding.js';
let root = '',
  host: ReturnType<typeof startWarmPoolHost>;
afterEach(async () => {
  await host?.close();
  host = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = mkdtempSync(join(tmpdir(), 'pool-host-'));
  writeFileSync(join(root, 'policy'), 'policy');
  const config: OpenShellRuntimeConfig = {
    cli: '/no-real-cli',
    image: 'approved',
    policy: join(root, 'policy'),
    seed: join(root, 'mgmt'),
    workspace: 'default',
    gateway: 'isolated',
    gatewayInsecure: false,
    createDetached: true,
    sandboxIdLength: 13,
    workdir: '/sandbox/workspaces/mgmt',
    webSearch: 'disabled',
    serviceProviders: [],
    grantableServiceProviders: [],
  };
  return config;
}
it('starts inert without host enrollment, permits saving disabled settings, and owns one controller lock', async () => {
  const c = fixture();
  host = startWarmPoolHost(c, { root, enrolled: false, onError: () => {} });
  expect(getOpenShellWarmPool()?.snapshot().settings.enabled).toBe(false);
  expect(getOpenShellWarmPool()?.snapshot().available).toBe(false);
  await getOpenShellWarmPool()!.mutate({
    action: 'settings',
    revision: 0,
    requestId: 'disabled',
    settings: { ...getOpenShellWarmPool()!.snapshot().settings, capacity: 2 },
  });
  expect(() => startWarmPoolHost(c, { root, enrolled: false, onError: () => {} })).toThrow(
    /controller|owner/i,
  );
  await host!.close();
  host = undefined;
  expect(getOpenShellWarmPool()).toBeNull();
});
it('does not create a pool when OpenShell is absent', () => {
  expect(
    startWarmPoolHost(undefined, { root: '/unused', enrolled: true, onError: () => {} }),
  ).toBeUndefined();
});

it('serializes dead-owner takeover with a process-shared transaction before touching the lock file', () => {
  const c = fixture();
  const path = join(root, 'openshell-warm-pool.lock');
  const retained = JSON.stringify({ pid: 2147483647, nonce: 'dead-owner' });
  writeFileSync(path, retained);
  const contender = new Database(join(root, 'openshell-warm-pool-controller.db'));
  contender.exec('BEGIN IMMEDIATE');
  try {
    expect(() => {
      host = startWarmPoolHost(c, { root, enrolled: false, onError: () => {} });
    }).toThrow(/busy|locked|controller/i);
    expect(readFileSync(path, 'utf8')).toBe(retained);
  } finally {
    contender.exec('ROLLBACK');
    contender.close();
  }
});
it('retains a dead owner and publishes the replacement while exclusively fenced', async () => {
  const c = fixture();
  const retained = JSON.stringify({ pid: 2147483647, nonce: 'dead-owner' });
  writeFileSync(join(root, 'openshell-warm-pool.lock'), retained);
  host = startWarmPoolHost(c, { root, enrolled: false, onError: () => {} });
  const evidence = readdirSync(root).filter((x) =>
    x.startsWith('openshell-warm-pool.lock.retained-'),
  );
  expect(evidence).toHaveLength(1);
  expect(readFileSync(join(root, evidence[0]), 'utf8')).toBe(retained);
  expect(() => startWarmPoolHost(c, { root, enrolled: false, onError: () => {} })).toThrow(
    /controller|owner/i,
  );
});

it('keeps an unenrolled host inert when its policy is unavailable, without losing saved settings', async () => {
  const c = fixture();
  rmSync(c.policy);
  const errors: unknown[] = [];
  host = startWarmPoolHost(c, { root, enrolled: false, onError: (e) => errors.push(e) });
  expect(host).toBeDefined();
  expect(host!.pool.snapshot()).toMatchObject({ available: false, settings: { enabled: false } });
  expect(errors).toHaveLength(1);
  await host!.pool.mutate({
    action: 'settings',
    revision: 0,
    requestId: 'disabled-missing-policy',
    settings: { ...host!.pool.snapshot().settings, capacity: 2 },
  });
  await expect(
    host!.pool.mutate({
      action: 'prepare',
      revision: host!.pool.snapshot().revision,
      requestId: 'unavailable-prepare',
    }),
  ).rejects.toThrow(/unavailable|enabled/i);
  expect(host!.pool.snapshot().spares).toHaveLength(0);
  await host!.close();
  host = undefined;
  writeFileSync(c.policy, 'policy');
  host = startWarmPoolHost(c, { root, enrolled: false, onError: (e) => errors.push(e) });
  expect(host!.pool.snapshot().settings.capacity).toBe(2);
  expect(errors).toHaveLength(1);
});

it('releases its own controller lock when enrolled adapter initialization fails', () => {
  const c = fixture();
  rmSync(c.policy);
  expect(() => startWarmPoolHost(c, { root, enrolled: true, onError: () => {} })).toThrow();
  writeFileSync(c.policy, 'policy');
  host = startWarmPoolHost(c, { root, enrolled: true, onError: () => {} });
  expect(host!.pool.snapshot().available).toBe(true);
});

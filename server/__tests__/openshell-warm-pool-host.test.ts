import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

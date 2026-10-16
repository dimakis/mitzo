import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const processMock = vi.hoisted(() => ({
  calls: [] as Array<{ env: Record<string, string> }>,
  ordinary: false,
  poolId: 'pool-origin',
  name: 'mitzo-warm-fixture',
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: (
    _binary: string,
    args: string[],
    options: { env: Record<string, string> },
    callback: (error: null, output: string) => void,
  ) => {
    processMock.calls.push(options);
    callback(
      null,
      args.includes('provider')
        ? 'No providers attached to sandbox ' + processMock.name + '.'
        : JSON.stringify({
            id: 'physical',
            name: processMock.name,
            workspace: 'default',
            phase: 'Ready',
            labels: processMock.ordinary
              ? {
                  'mitzo.conversation': createHash('sha256')
                    .update('chat')
                    .digest('hex')
                    .slice(0, 63),
                  'mitzo.account_provider': 'work',
                }
              : { 'mitzo.warm_pool': processMock.poolId },
          }),
    );
  },
}));
import {
  createWarmPoolAdapter,
  warmPoolScope,
  warmPoolRuntimeAuthority,
} from '../openshell-warm-pool-runtime.js';
import { OpenShellRuntimeManager, type BoundOpenShellRuntimeConfig } from '../openshell-runtime.js';
let root = '';
afterEach(() => {
  vi.unstubAllEnvs();
  processMock.calls = [];
  processMock.ordinary = false;
  if (root) rmSync(root, { recursive: true, force: true });
});
it.each([false, true])(
  'pool and conversation subprocesses use the same isolated environment (explicit=%s)',
  async (explicit) => {
    root = mkdtempSync(join(tmpdir(), 'warm-env-'));
    vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', root);
    vi.stubEnv('XDG_CONFIG_HOME', '/ambient-other-gateway');
    vi.stubEnv('AMBIENT_TEST_SECRET', 'offline-test-secret');
    writeFileSync(join(root, 'policy'), 'policy');
    const config: BoundOpenShellRuntimeConfig = {
      cli: 'openshell',
      image: 'runtime:approved',
      policy: join(root, 'policy'),
      seed: root,
      workspace: 'default',
      gateway: 'isolated',
      gatewayInsecure: false,
      createDetached: true,
      sandboxIdLength: 13,
      workdir: '/sandbox/workspaces/mgmt',
      webSearch: 'disabled',
      serviceProviders: [],
      grantableServiceProviders: [],
      account: { kind: 'api', provider: 'work', model: 'offline' },
      ...(explicit
        ? {
            cliEnvironment: {
              HOME: '/private/host',
              XDG_CONFIG_HOME: '/private/config',
              PATH: '/usr/bin:/bin',
            },
          }
        : {}),
    };
    const adapter = createWarmPoolAdapter(config);
    await adapter.inspect(
      {
        id: processMock.poolId,
        name: processMock.name,
        physicalId: 'physical',
        scope: adapter.scope,
        runtimeAuthority: adapter.runtimeAuthority,
        state: 'ready',
        resources: { cpu: 2, memoryGiB: 4 },
        conversationId: null,
        provider: null,
        failure: null,
        createdAt: 1,
      },
      AbortSignal.timeout(5000),
    );
    const poolEnvironments = processMock.calls.map((x) => x.env);
    processMock.ordinary = true;
    await new OpenShellRuntimeManager({ ...config, sandboxNameOverride: processMock.name }).inspect(
      'chat',
      'physical',
      AbortSignal.timeout(5000),
    );
    const ordinary = processMock.calls.at(-1)!.env;
    expect(poolEnvironments.every((env) => JSON.stringify(env) === JSON.stringify(ordinary))).toBe(
      true,
    );
    expect(ordinary).not.toHaveProperty('AMBIENT_TEST_SECRET');
    expect(ordinary.XDG_CONFIG_HOME).toBe(explicit ? '/private/config' : undefined);
    if (explicit) expect(ordinary).toEqual(config.cliEnvironment);
    vi.stubEnv('XDG_CONFIG_HOME', '/ignored-ambient-change');
    expect(warmPoolScope(config)).toBe(adapter.scope);
    expect(warmPoolRuntimeAuthority(config)).toBe(adapter.runtimeAuthority);
    vi.stubEnv('HOME', '/different-ambient-home');
    expect(warmPoolScope(config) === adapter.scope).toBe(explicit);
    expect(warmPoolRuntimeAuthority(config) === adapter.runtimeAuthority).toBe(explicit);
  },
);

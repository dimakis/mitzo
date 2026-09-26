import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createDiscoveryHostOperations } from '../symposium-model-discovery-host.js';
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));
let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  vi.resetAllMocks();
});
function fixture() {
  root = mkdtempSync(join(tmpdir(), 'discovery-mock-'));
  const environment = {
    PATH: '/usr/bin:/bin',
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
  };
  Object.entries(environment)
    .filter(([key]) => key !== 'PATH')
    .forEach(([, path]) => mkdirSync(path, { mode: 0o700 }));
  const digest = createHash('sha256').update('fixture').digest('hex');
  for (const name of ['cli', 'policy', 'config-pin'])
    writeFileSync(join(root, name), 'fixture', { mode: 0o600 });
  const config = {
    cliSha256: digest,
    workloadImage: `sha256:${'a'.repeat(64)}`,
    policySha256: digest,
    podmanUrl: 'unix:///private/mock-podman.sock',
    gateway: 'owned',
    workspace: 'work',
    provider: { name: 'personal', id: 'provider-1' },
  };
  const options = {
    cli: join(root, 'cli'),
    podman: '/usr/bin/podman',
    policy: join(root, 'policy'),
    journal: join(root, 'journal.json'),
    namespace: 'default',
    environment,
    configPins: [{ path: join(root, 'config-pin'), sha256: digest, mode: 0o600 }],
    attestGateway: vi.fn(async () => {}),
  };
  return { config, options };
}
it('fails closed when pinned bytes change, without invoking management', async () => {
  const { config, options } = fixture();
  const ops = createDiscoveryHostOperations(config, options);
  writeFileSync(options.policy, 'changed');
  await expect(ops.verifyCustody(config)).rejects.toThrow('Discovery pin changed');
  expect(execFile).not.toHaveBeenCalled();
});
it('rejects inherited authentication environment and keeps journals exclusive/private', async () => {
  const { config, options } = fixture();
  expect(() =>
    createDiscoveryHostOperations(config, {
      ...options,
      environment: { ...options.environment, OPENAI_API_KEY: 'fixture' },
    }),
  ).toThrow('Private management environment');
  const ops = createDiscoveryHostOperations(config, options);
  await ops.verifyCustody(config);
  const receipt = {
    name: `md-${'a'.repeat(16)}`,
    claim: 'b'.repeat(64),
    configHash: 'c'.repeat(64),
  };
  await ops.persistReceipt(receipt, true);
  await expect(ops.persistReceipt(receipt, true)).rejects.toThrow();
  expect(await ops.readReceipt()).toEqual(receipt);
  expect(options.attestGateway).toHaveBeenCalledOnce();
});

it('uses only the explicit Podman endpoint and private environment for physical absence', async () => {
  const { config, options } = fixture();
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    (args[3] as (error: null, stdout: string) => void)(null, '[]');
  }) as typeof execFile);
  const ops = createDiscoveryHostOperations(config, options);
  expect(
    await ops.physicalAbsent({
      name: `md-${'a'.repeat(16)}`,
      claim: 'b'.repeat(64),
      configHash: 'c'.repeat(64),
      id: 'sandbox-1',
    }),
  ).toBe(true);
  expect(execFile).toHaveBeenCalledWith(
    options.podman,
    ['--url', config.podmanUrl, 'ps', '--all', '--format', 'json'],
    expect.objectContaining({ env: options.environment }),
    expect.any(Function),
  );
});
it('keeps physical cleanup incomplete for a supervisor identified by the exact sandbox ID', async () => {
  const { config, options } = fixture();
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    (args[3] as (error: null, stdout: string) => void)(
      null,
      JSON.stringify([{ Names: ['supervisor-sandbox-1'], Labels: {} }]),
    );
  }) as typeof execFile);
  const ops = createDiscoveryHostOperations(config, options);
  expect(
    await ops.physicalAbsent({
      name: `md-${'a'.repeat(16)}`,
      claim: 'b'.repeat(64),
      configHash: 'c'.repeat(64),
      id: 'sandbox-1',
    }),
  ).toBe(false);
});

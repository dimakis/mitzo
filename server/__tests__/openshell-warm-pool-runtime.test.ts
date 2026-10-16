import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createWarmPoolAdapter, warmPoolScope } from '../openshell-warm-pool-runtime.js';
import type { OpenShellRuntimeConfig } from '../openshell-runtime.js';
import type { WarmPoolRecord } from '../openshell-warm-pool.js';
let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = mkdtempSync(join(tmpdir(), 'pool-runtime-'));
  writeFileSync(join(root, 'policy'), 'policy');
  const config: OpenShellRuntimeConfig = {
    cli: 'openshell',
    image: 'runtime:approved',
    policy: join(root, 'policy'),
    seed: join(root, 'mgmt'),
    workspace: 'default',
    gateway: 'isolated',
    gatewayInsecure: false,
    createDetached: true,
    sandboxIdLength: 13,
    workdir: '/sandbox/workspaces/mgmt',
    webSearch: 'disabled',
    serviceProviders: ['github'],
    grantableServiceProviders: [],
  };
  const record: WarmPoolRecord = {
    id: crypto.randomUUID(),
    name: 'mitzo-warm-fixture',
    physicalId: null,
    state: 'preparing',
    scope: warmPoolScope(config),
    resources: { cpu: 2, memoryGiB: 4 },
    conversationId: null,
    provider: null,
    failure: null,
    createdAt: 1,
  };
  const attached: string[] = [];
  const run = vi.fn(async (args: readonly string[]) => {
    if (args.includes('attach')) {
      attached.push(args.at(-1)!);
      return '{}';
    }
    if (args.includes('provider'))
      return attached.length
        ? 'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n' +
            attached.map((x) => x + ' service 0 0').join('\n')
        : 'No providers attached to sandbox ' + record.name + '.';
    return JSON.stringify({
      id: 'physical-one',
      name: record.name,
      workspace: config.workspace,
      phase: 'Ready',
      labels: { 'mitzo.warm_pool': record.id },
    });
  });
  const cleanup = vi.fn(),
    seed = vi.fn(async () => ({ seed: config.seed, cleanup }));
  const adapter = createWarmPoolAdapter(config, run, seed);
  return { config, record, run, seed, cleanup, adapter };
}
it('prepares with CPU/memory but no account/provider, and verifies seed before create', async () => {
  const f = fixture();
  await f.adapter.prepare(f.record, AbortSignal.timeout(5000));
  const args = f.run.mock.calls[0][0];
  expect(args).toContain('--cpu');
  expect(args).toContain('--memory');
  expect(args).toContain('--no-auto-providers');
  expect(args).not.toContain('--provider');
  expect(args).not.toContain('--inference-provider');
  expect(args).not.toContain('--disk');
  expect(args.join(' ')).toContain('/sandbox/pool-knowledge');
  expect(f.seed).toHaveBeenCalledOnce();
  expect(f.cleanup).toHaveBeenCalledOnce();
});
it('selects fresh seed and confirms exact provider set only after a durable claim', async () => {
  const f = fixture();
  f.record.physicalId = 'physical-one';
  await expect(f.adapter.bind(f.record, 'work', AbortSignal.timeout(5000))).rejects.toThrow(
    /claim/i,
  );
  f.record.state = 'claiming';
  f.record.conversationId = 'chat';
  f.record.provider = 'work';
  await f.adapter.bind(f.record, 'work', AbortSignal.timeout(5000), undefined, ['github']);
  expect(f.seed).toHaveBeenCalledOnce();
  expect(f.run.mock.calls.some(([a]) => a.includes('upload'))).toBe(true);
  expect(f.run.mock.calls.filter(([a]) => a.includes('attach')).map(([a]) => a.at(-1))).toEqual([
    'work',
    'github',
  ]);
  expect(f.cleanup).toHaveBeenCalledOnce();
});
it('refuses neutral resources with account labels even if their pool label matches', async () => {
  const f = fixture();
  f.run.mockResolvedValue(
    JSON.stringify({
      id: 'physical-one',
      name: f.record.name,
      workspace: 'default',
      phase: 'Ready',
      labels: { 'mitzo.warm_pool': f.record.id, 'mitzo.account_provider': 'someone' },
    }),
  );
  await expect(f.adapter.inspect(f.record, AbortSignal.timeout(5000))).rejects.toThrow(/identity/i);
});
it('policy changes invalidate the compatibility identity', () => {
  const f = fixture();
  const before = warmPoolScope(f.config);
  writeFileSync(f.config.policy, 'changed');
  expect(warmPoolScope(f.config)).not.toBe(before);
});
it('waits for observed Ready after detached creation rather than treating Pending as ready', async () => {
  const f = fixture(),
    original = f.run.getMockImplementation()!;
  let reads = 0;
  f.run.mockImplementation(async (args: readonly string[]) => {
    const out = await original(args);
    if (args.includes('get') && reads++ === 0)
      return JSON.stringify({ ...JSON.parse(out), phase: 'Creating' });
    return out;
  });
  const result = await f.adapter.prepare(f.record, AbortSignal.timeout(5000));
  expect(result.phase).toBe('Ready');
  expect(reads).toBeGreaterThan(1);
});

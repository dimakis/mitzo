import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { tracer } from '../tracing.js';
import { canonicalJsonPayload } from '../../scripts/verify-openshell-production.mjs';
import {
  OpenShellWarmPool,
  type WarmSandbox,
  type WarmPoolAdapter,
} from '../openshell-warm-pool.js';
import { setOpenShellWarmPool } from '../openshell-warm-pool-binding.js';
import { warmPoolScope } from '../openshell-warm-pool-runtime.js';
import {
  OpenShellRuntimeManager,
  prepareOpenShellSeed,
  preparePublishedOpenShellSeed,
} from '../openshell-runtime.js';

const compiledContext = {
  type: 'boot_context',
  scope: 'sandbox',
  sourceCount: 1,
  tokenCount: 2,
  tokenBudget: 12000,
  sources: [],
  included: [],
  trimmed: [],
  fullMarkdown: 'Accepted context',
};

let root = '';
let warmPool: OpenShellWarmPool | undefined;
afterEach(() => {
  setOpenShellWarmPool(null);
  warmPool?.close();
  warmPool = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function publication(executable = false) {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'knowledge-create-upload-')));
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  const seed = join(root, 'release', 'mgmt');
  mkdirSync(join(seed, 'memory', 'manifest'), { recursive: true });
  const source = 'a'.repeat(40);
  const files: Record<string, { sha256: string; mode: string }> = {};
  for (const [path, content] of [
    ['memory/example.md', 'Accepted A'],
    ...['index.json', 'wikilinks.json', 'by_type.json', 'by_tag.json'].map((name) => [
      `memory/manifest/${name}`,
      JSON.stringify({ sourceCommit: source }),
    ]),
  ]) {
    writeFileSync(join(seed, path), content);
    const mode = executable && path === 'memory/example.md' ? 0o755 : 0o644;
    chmodSync(join(seed, path), mode);
    files[path] = { sha256: digest(content), mode: mode.toString(8).padStart(4, '0') };
  }
  const payload = {
    startingCommit: source,
    runtimeBaseCommit: source,
    runtimeDependencyProjectionSha256: 'b'.repeat(64),
    knowledgeSchemaVersion: 1,
    knowledgeCompilerSha256: 'c'.repeat(64),
    knowledgeRecipeSha256: 'd'.repeat(64),
    files,
  };
  const baseline = { ...payload, payloadSha256: digest(canonicalJsonPayload(payload)) };
  const runtime = {
    image: 'runtime:fixture',
    digest: `sha256:${'e'.repeat(64)}`,
    mgmtSourceCommit: source,
    dependencyProjectionSha256: payload.runtimeDependencyProjectionSha256,
    knowledgeSchemaVersion: 1,
    knowledgeCompilerCommit: 'f'.repeat(40),
    runtimeInputsSha256: '0'.repeat(64),
    knowledgeCompilerSha256: payload.knowledgeCompilerSha256,
    knowledgeRecipeSha256: payload.knowledgeRecipeSha256,
    targetPlatform: 'linux/amd64',
    targetMarkerEnvironmentB64: Buffer.from(
      JSON.stringify({
        implementation_name: 'cpython',
        implementation_version: '3.11.9',
        os_name: 'posix',
        platform_machine: 'x86_64',
        platform_release: 'fixture',
        platform_system: 'Linux',
        platform_version: 'fixture',
        platform_python_implementation: 'CPython',
        python_full_version: '3.11.9',
        python_version: '3.11',
        sys_platform: 'linux',
      }),
    ).toString('base64'),
  };
  const bytes = JSON.stringify(baseline);
  writeFileSync(join(seed, '..', 'baseline.json'), bytes);
  writeFileSync(
    join(seed, '..', 'publication.json'),
    JSON.stringify({
      schemaVersion: 1,
      sourceCommit: source,
      builderCommit: 'f'.repeat(40),
      payloadSha256: baseline.payloadSha256,
      baselineSha256: digest(bytes),
      runtimeImage: runtime.image,
      runtimeDigest: runtime.digest,
      runtimeBaseCommit: source,
      runtimeDependencyProjectionSha256: payload.runtimeDependencyProjectionSha256,
      knowledgeSchemaVersion: 1,
      knowledgeCompilerSha256: payload.knowledgeCompilerSha256,
      knowledgeRecipeSha256: payload.knowledgeRecipeSha256,
      validation: { pinnedBuilder: true, runtimeContract: true, manifestProvenance: true },
    }),
  );
  return {
    seed,
    seedStackManifest: { runtime },
    image: runtime.image,
    cli: '/fake/openshell',
    policy: '/fake/policy',
    serviceProviders: [],
    grantableServiceProviders: [],
    workspace: 'mitzo',
    gateway: 'local',
    gatewayInsecure: false,
    createDetached: true,
    sandboxIdLength: 13,
    workdir: '/sandbox/workspaces/mgmt',
    webSearch: 'disabled' as const,
    account: { kind: 'api' as const, provider: 'openai-work', model: 'fake-model' },
  };
}
function digest(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

function firstCommandFixture(
  mode: 'legacy-api' | 'native-api' | 'native-subscription' = 'legacy-api',
) {
  const source = publication();
  const selection = {
    seed: source.seed,
    sourceCommit: 'a'.repeat(40),
    baselineSha256: digest(readFileSync(join(source.seed, '..', 'baseline.json'), 'utf8')),
  };
  const reconcile = vi.fn().mockResolvedValue(selection);
  const account =
    mode === 'native-subscription'
      ? {
          kind: 'chatgpt-subscription-native' as const,
          provider: 'openai-work',
          providerType: 'codex' as const,
          providerId: 'provider-id',
          model: source.account.model,
        }
      : source.account;
  const config = {
    ...source,
    account,
    knowledgeStore: { id: 'notes', reconcile },
    ...(mode !== 'legacy-api'
      ? {
          cliContract: 'v0.1' as const,
          accountProviderBindings: [
            {
              name: account.provider,
              type: mode === 'native-subscription' ? 'codex' : 'openai',
              id: 'provider-id',
            },
          ],
          verifyAccountProviderUnion: () => undefined,
          onSandboxCreateSettled: vi.fn(),
        }
      : {}),
  };
  let physical: Record<string, unknown> | undefined;
  let uploaded: { sourceCommit: string; payloadSha256: string } | undefined;
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'provider' && args.includes('list'))
      return JSON.stringify({
        providers: [
          {
            name: account.provider,
            id: 'provider-id',
            type: mode === 'native-subscription' ? 'codex' : 'openai',
            workspace: config.workspace,
          },
        ],
        next_page_token: '',
      });
    if (args.includes('get')) {
      if (!physical) throw Error('sandbox not found');
      return JSON.stringify(physical);
    }
    if (args.includes('create')) {
      physical = {
        name: args[args.indexOf('--name') + 1],
        id: 'physical-id',
        workspace: 'mitzo',
        phase: 'Ready',
        labels: Object.fromEntries(
          args.flatMap((arg, i) => (args[i - 1] === '--label' ? [arg.split('=')] : [])),
        ),
      };
      return JSON.stringify(physical);
    }
    if (args.includes('provider') && args.includes('list'))
      return mode === 'legacy-api'
        ? `No providers attached to sandbox ${String(physical?.name)}.`
        : JSON.stringify({
            providers: [
              { name: account.provider, type: mode === 'native-subscription' ? 'codex' : 'openai' },
            ],
            next_page_token: '',
          });
    if (args.includes('upload') && args.at(-1) === '/sandbox/workspaces/knowledge') {
      const view = JSON.parse(
        readFileSync(join(args[args.indexOf('upload') + 2], 'knowledge-view.json'), 'utf8'),
      );
      uploaded = { sourceCommit: view.sourceCommit, payloadSha256: view.payloadSha256 };
    }
    return '{}';
  });
  const ssh = vi.fn(async (args: readonly string[]) => {
    const command = args.join(' ');
    if (command.includes('attest-knowledge-runtime.py'))
      return JSON.stringify(config.seedStackManifest.runtime);
    if (command.includes('knowledge-cache-probe'))
      return JSON.stringify({ valid: false, present: false });
    return JSON.stringify({ receipt: uploaded, context: compiledContext });
  });
  const manager = new OpenShellRuntimeManager(config, run, undefined, ssh);
  const ensure = (command = 'first') =>
    manager.ensure(
      'first-conversation',
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      command,
    );
  return { config, selection, reconcile, run, ssh, manager, ensure };
}

function nextPublication(config: ReturnType<typeof firstCommandFixture>['config']) {
  const directory = join(root, 'publication-b');
  cpSync(join(config.seed, '..'), directory, { recursive: true });
  const seed = join(directory, 'mgmt');
  const baseline = JSON.parse(readFileSync(join(directory, 'baseline.json'), 'utf8'));
  baseline.startingCommit = 'b'.repeat(40);
  for (const name of ['index.json', 'wikilinks.json', 'by_type.json', 'by_tag.json']) {
    const path = `memory/manifest/${name}`;
    const bytes = JSON.stringify({ sourceCommit: baseline.startingCommit });
    writeFileSync(join(seed, path), bytes);
    baseline.files[path].sha256 = digest(bytes);
  }
  const payload = { ...baseline };
  delete payload.payloadSha256;
  baseline.payloadSha256 = digest(canonicalJsonPayload(payload));
  const bytes = JSON.stringify(baseline);
  writeFileSync(join(directory, 'baseline.json'), bytes);
  const receiptPath = join(directory, 'publication.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  writeFileSync(
    receiptPath,
    JSON.stringify({
      ...receipt,
      sourceCommit: baseline.startingCommit,
      payloadSha256: baseline.payloadSha256,
      baselineSha256: digest(bytes),
    }),
  );
  return { seed, sourceCommit: baseline.startingCommit, baselineSha256: digest(bytes) };
}

async function warmFirstCommandFixture() {
  const f = firstCommandFixture();
  f.config.policy = join(root, 'policy');
  writeFileSync(f.config.policy, 'approved policy');
  let physical: WarmSandbox;
  const bind = vi.fn<WarmPoolAdapter['bind']>(async (_record, provider, signal, seed) => {
    const prepared = seed
      ? { seed, cleanup: () => undefined }
      : await preparePublishedOpenShellSeed(f.config, signal);
    try {
      expect(readFileSync(join(prepared.seed, 'memory/example.md'), 'utf8')).toBe('Accepted A');
      physical.providers = [provider];
    } finally {
      prepared.cleanup();
    }
  });
  warmPool = new OpenShellWarmPool(join(root, 'pool.db'), {
    available: true,
    reason: null,
    scope: warmPoolScope(f.config),
    prepare: async (record) =>
      (physical = {
        id: 'warm-physical',
        name: record.name,
        poolId: record.id,
        phase: 'Ready',
        providers: [],
      }),
    inspect: async () => physical,
    bind,
    remove: async () => undefined,
  });
  await warmPool.mutate({ action: 'prepare', revision: 0, requestId: 'test-prepare' });
  setOpenShellWarmPool(warmPool);
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args) => {
    if (args.includes('get')) {
      if (!args.includes(physical.name)) throw Error('sandbox not found');
      return JSON.stringify({
        ...physical,
        workspace: f.config.workspace,
        labels: { 'mitzo.warm_pool': physical.poolId },
      });
    }
    if (args[0] === 'sandbox' && args.includes('provider') && args.includes('list'))
      return (
        'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n' +
        physical.providers.map((p) => `${p} service 0 0`).join('\n')
      );
    return original(args);
  });
  return { ...f, bind };
}

it('shares only the fresh command-bound warm claim selection with its first turn', async () => {
  const f = await warmFirstCommandFixture();
  const runtime = await f.ensure();
  expect(f.reconcile).toHaveBeenCalledTimes(1);
  expect(f.bind).toHaveBeenCalledOnce();
  const frozenSeed = f.bind.mock.calls[0][3];
  expect(frozenSeed).toBeTruthy();
  expect(existsSync(frozenSeed!)).toBe(false);
  const next = nextPublication(f.config);
  f.reconcile.mockResolvedValue(next);
  const first = await f.manager.adoptKnowledge(
    'first-conversation',
    runtime,
    AbortSignal.timeout(5000),
    undefined,
    'first',
  );
  expect(first?.sourceCommit).toBe('a'.repeat(40));
  expect(f.reconcile).toHaveBeenCalledTimes(1);
  const second = await f.manager.adoptKnowledge(
    'first-conversation',
    runtime,
    AbortSignal.timeout(5000),
    undefined,
    'second',
  );
  expect(second?.sourceCommit).toBe(next.sourceCommit);
  expect(f.reconcile).toHaveBeenCalledTimes(2);
});

it.each(['command', 'store', 'cancelled'] as const)(
  'invalidates a fresh warm-claim selection after changed %s',
  async (changed) => {
    const f = await warmFirstCommandFixture();
    const runtime = await f.ensure();
    const next = nextPublication(f.config);
    f.reconcile.mockResolvedValue(next);
    if (changed === 'store') f.config.knowledgeStore = { id: 'other', reconcile: f.reconcile };
    if (changed === 'cancelled')
      await expect(
        f.manager.adoptKnowledge(
          'first-conversation',
          runtime,
          AbortSignal.abort(),
          undefined,
          'first',
        ),
      ).rejects.toThrow();
    const selected = await f.manager.adoptKnowledge(
      'first-conversation',
      runtime,
      AbortSignal.timeout(5000),
      undefined,
      changed === 'command' ? 'changed-command' : 'first',
    );
    expect(selected?.sourceCommit).toBe(next.sourceCommit);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
  },
);

it.each(['legacy-api', 'native-api', 'native-subscription'] as const)(
  'selects published knowledge once for the exact new %s command and freshly for its next command',
  async (mode) => {
    const observed = vi.spyOn(tracer, 'startSpan');
    const f = firstCommandFixture(mode);
    const runtime = await f.ensure();
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(runtime)).not.toContain(f.config.seed);
    const next = nextPublication(f.config);
    f.reconcile.mockResolvedValue(next);
    // The boundary wrapper may change the manager, but this is still the same exact command/sandbox.
    const manager = f.manager.forSandbox(runtime.sandboxName);
    const first = await manager.adoptKnowledge(
      'first-conversation',
      runtime,
      AbortSignal.timeout(5000),
      undefined,
      'first',
    );
    expect(first?.sourceCommit).toBe('a'.repeat(40));
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(observed.mock.calls.some(([name]) => name === 'knowledge.reuse_initial_selection')).toBe(
      true,
    );
    const second = await manager.adoptKnowledge(
      'first-conversation',
      runtime,
      AbortSignal.timeout(5000),
      undefined,
      'second',
    );
    expect(second?.sourceCommit).toBe(next.sourceCommit);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
  },
);

it.each([
  'command',
  'conversation',
  'physical',
  'workdir',
  'workspace',
  'account',
  'runtime',
  'store',
  'endpoint',
  'name',
  'unbound',
])('does not transfer a first-command selection after a changed %s', async (changed) => {
  const f = firstCommandFixture();
  const runtime = await f.ensure();
  const supplied = { ...runtime };
  if (changed === 'physical') supplied.sandboxId = 'another-physical-id';
  if (changed === 'workdir') supplied.workdir = '/sandbox/workspaces/other';
  if (changed === 'workspace') supplied.workspace = 'other';
  if (changed === 'account') f.config.account = { ...f.config.account, model: 'another-model' };
  if (changed === 'runtime') f.config.image = 'runtime:another';
  if (changed === 'store')
    f.config.knowledgeStore = { id: 'another-store', reconcile: f.reconcile };
  if (changed === 'endpoint') supplied.gatewayEndpoint = 'http://127.0.0.1:4999';
  if (changed === 'name') supplied.sandboxName = 'another-sandbox';
  const next = nextPublication(f.config);
  f.reconcile.mockResolvedValue(next);
  const attempt = f.manager.adoptKnowledge(
    changed === 'conversation' ? 'other-conversation' : 'first-conversation',
    supplied,
    AbortSignal.timeout(5000),
    undefined,
    changed === 'unbound' ? undefined : changed === 'command' ? 'other-command' : 'first',
  );
  if (['conversation', 'physical', 'runtime', 'name'].includes(changed))
    await expect(attempt).rejects.toThrow();
  else expect((await attempt)?.sourceCommit).toBe(next.sourceCommit);
  expect(f.reconcile).toHaveBeenCalledTimes(2);
});

it.each(['delivery', 'cancellation', 'host-integrity'])(
  'consumes first-command selection on failed %s and reconciles its retry',
  async (failure) => {
    const f = firstCommandFixture();
    const runtime = await f.ensure();
    const signal = new AbortController();
    if (failure === 'cancellation') signal.abort();
    if (failure === 'host-integrity')
      writeFileSync(join(f.config.seed, 'memory/example.md'), 'tampered');
    if (failure === 'delivery')
      f.ssh.mockImplementationOnce(async () => {
        throw Error('attestation unavailable');
      });
    await expect(
      f.manager.adoptKnowledge('first-conversation', runtime, signal.signal, undefined, 'first'),
    ).rejects.toThrow();
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    writeFileSync(join(f.config.seed, 'memory/example.md'), 'Accepted A');
    const retry = await f.manager.adoptKnowledge(
      'first-conversation',
      runtime,
      AbortSignal.timeout(5000),
      undefined,
      'first',
    );
    expect(retry?.sourceCommit).toBe('a'.repeat(40));
    expect(f.reconcile).toHaveBeenCalledTimes(2);
  },
);

it('captures selection metadata independently of mutable publisher responses', async () => {
  const f = firstCommandFixture();
  const runtime = await f.ensure();
  f.selection.sourceCommit = 'b'.repeat(40);
  const first = await f.manager.adoptKnowledge(
    'first-conversation',
    runtime,
    AbortSignal.timeout(5000),
    undefined,
    'first',
  );
  expect(first?.sourceCommit).toBe('a'.repeat(40));
  expect(f.reconcile).toHaveBeenCalledTimes(1);
});

it("does not register another creator's conflicting sandbox as a first-command selection", async () => {
  const f = firstCommandFixture();
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args) => {
    const result = await original(args);
    if (args.includes('create')) throw Error('already exists');
    return result;
  });
  const runtime = await f.ensure();
  await f.manager.adoptKnowledge(
    'first-conversation',
    runtime,
    AbortSignal.timeout(5000),
    undefined,
    'first',
  );
  expect(f.reconcile).toHaveBeenCalledTimes(2);
});

it('does not reuse a warmup publication without an initial command identity', async () => {
  const f = firstCommandFixture();
  const runtime = await f.manager.ensure('first-conversation', AbortSignal.timeout(5000));
  await f.manager.adoptKnowledge(
    'first-conversation',
    runtime,
    AbortSignal.timeout(5000),
    undefined,
    'first',
  );
  expect(f.reconcile).toHaveBeenCalledTimes(2);
});

it('never grants reuse for an existing sandbox or an unbound first command', async () => {
  const f = firstCommandFixture();
  await f.ensure();
  const runtime = await f.ensure('replacement-first');
  expect(runtime.created).toBeUndefined();
  await f.manager.adoptKnowledge(
    'first-conversation',
    runtime,
    AbortSignal.timeout(5000),
    undefined,
    'replacement-first',
  );
  expect(f.reconcile).toHaveBeenCalledTimes(2);
});

it('reconciles configured knowledge before snapshotting and rejects another bundle revision', async () => {
  const config = publication();
  const baselineSha256 = digest(readFileSync(join(config.seed, '..', 'baseline.json'), 'utf8'));
  const reconcile = vi
    .fn()
    .mockResolvedValue({ seed: config.seed, sourceCommit: 'a'.repeat(40), baselineSha256 });
  const selected = { ...config, seed: '/stale/seed', knowledgeStore: { id: 'notes', reconcile } };
  const prepared = await preparePublishedOpenShellSeed(selected, AbortSignal.timeout(5000));
  try {
    expect(reconcile).toHaveBeenCalledOnce();
    expect(prepared.seed).not.toBe(config.seed);
    expect(
      JSON.parse(readFileSync(join(prepared.seed, '..', 'baseline.json'), 'utf8')).startingCommit,
    ).toBe('a'.repeat(40));
  } finally {
    prepared.cleanup();
  }
  reconcile.mockResolvedValue({ seed: config.seed, sourceCommit: 'b'.repeat(40), baselineSha256 });
  await expect(preparePublishedOpenShellSeed(selected, AbortSignal.timeout(5000))).rejects.toThrow(
    'Selected bundle revision differs',
  );
});
it('rejects a self-consistent bundle changed after publisher policy verification', async () => {
  const config = publication();
  const baselinePath = join(config.seed, '..', 'baseline.json');
  const selectedDigest = digest(readFileSync(baselinePath, 'utf8'));
  const reconcile = vi.fn(async () => {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    writeFileSync(join(config.seed, 'memory/private.md'), 'Unselected private information');
    chmodSync(join(config.seed, 'memory/private.md'), 0o644);
    baseline.files['memory/private.md'] = {
      sha256: digest('Unselected private information'),
      mode: '0644',
    };
    const payload = { ...baseline };
    delete payload.payloadSha256;
    baseline.payloadSha256 = digest(canonicalJsonPayload(payload));
    const bytes = JSON.stringify(baseline);
    writeFileSync(baselinePath, bytes);
    const receiptPath = join(config.seed, '..', 'publication.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    writeFileSync(
      receiptPath,
      JSON.stringify({
        ...receipt,
        payloadSha256: baseline.payloadSha256,
        baselineSha256: digest(bytes),
      }),
    );
    return { seed: config.seed, sourceCommit: 'a'.repeat(40), baselineSha256: selectedDigest };
  });
  await expect(
    preparePublishedOpenShellSeed(
      { ...config, knowledgeStore: { id: 'notes', reconcile } },
      AbortSignal.timeout(5000),
    ),
  ).rejects.toThrow('Selected bundle baseline differs from verified publication');
  expect(readdirSync(join(root, 'private/knowledge-uploads'))).toEqual([]);
});
it('adopts a verified knowledge view in a retained sandbox without replacing task files', async () => {
  const sourceConfig = publication();
  const reconcile = vi.fn().mockResolvedValue({
    seed: sourceConfig.seed,
    sourceCommit: 'a'.repeat(40),
    baselineSha256: digest(readFileSync(join(sourceConfig.seed, '..', 'baseline.json'), 'utf8')),
  });
  const config = { ...sourceConfig, knowledgeStore: { id: 'notes', reconcile } };
  const conversation = 'retained-chat';
  const owner = digest(conversation).slice(0, 63);
  const name = `mitzo-${digest(conversation).slice(0, 13)}`;
  const run = vi.fn(async (_args: readonly string[]) =>
    JSON.stringify({
      name,
      id: 'physical-id',
      workspace: 'mitzo',
      phase: 'Ready',
      labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': 'openai-work' },
    }),
  );
  let present = false;
  let damaged = false;
  let mutateHostDuringProbe = false;
  const ssh = vi.fn(async (args: readonly string[]) =>
    args.join(' ').includes('attest-knowledge-runtime.py')
      ? JSON.stringify(config.seedStackManifest.runtime)
      : args.join(' ').includes('knowledge-cache-probe')
        ? JSON.stringify({ valid: present && !damaged, present })
        : JSON.stringify({
            context: compiledContext,
            receipt: {
              sourceCommit: 'a'.repeat(40),
              payloadSha256: JSON.parse(
                readFileSync(join(config.seed, '..', 'baseline.json'), 'utf8'),
              ).payloadSha256,
            },
          }),
  );
  const manager = new OpenShellRuntimeManager(config, run, undefined, ssh);

  const runtime = {
    sandboxName: name,
    sandboxId: 'physical-id',
    workdir: '/sandbox/workspaces/mgmt',
    appServerCommand: '/sandbox/run-mitzo-app-server' as const,
    cli: 'openshell',
    gateway: 'local',
    workspace: 'mitzo',
    gatewayInsecure: false,
  };
  const first = await manager.adoptKnowledge(conversation, runtime, AbortSignal.timeout(5000));
  expect(first?.sourceCommit).toBe('a'.repeat(40));
  expect(first?.adoption).toHaveProperty(
    'runtimeContractImageDigest',
    config.seedStackManifest.runtime.digest,
  );
  expect(first?.adoption).not.toHaveProperty('runtimeImageDigest');
  expect(first?.knowledgeRoot).toMatch(
    /^\/sandbox\/workspaces\/knowledge\/knowledge-[a-f0-9]{64}\/mgmt$/,
  );
  expect(first?.context).toEqual(compiledContext);
  expect(
    ssh.mock.calls.filter(([args]) => args.join(' ').includes('knowledge-delivery')),
  ).toHaveLength(1);
  expect(
    ssh.mock.calls.find(([args]) => args.join(' ').includes('knowledge-delivery'))![0].at(-1),
  ).toContain('/sandbox/compile-mgmt-context.mjs');
  expect(ssh).toHaveBeenCalledTimes(3);
  const uploads = run.mock.calls.filter(([args]) => args.includes('upload'));
  expect(uploads).toHaveLength(1);
  expect(uploads[0][0].at(-1)).toBe('/sandbox/workspaces/knowledge');
  present = true;
  const uploadsRoot = join(root, 'private/knowledge-uploads');
  rmSync(uploadsRoot, { recursive: true, force: true });
  await manager.adoptKnowledge(conversation, runtime, AbortSignal.timeout(5000));
  expect(existsSync(uploadsRoot)).toBe(false);
  expect(reconcile).toHaveBeenCalledTimes(2);
  expect(run.mock.calls.filter(([args]) => args.includes('upload'))).toHaveLength(1);
  expect(ssh).toHaveBeenCalledTimes(6);
  expect(ssh.mock.calls.at(-1)![0].at(-1)).toMatch(/ cached'$/);
  present = true;
  const resumed = new OpenShellRuntimeManager(config, run, undefined, ssh);
  const reused = await resumed.adoptKnowledge(conversation, runtime, AbortSignal.timeout(5000));
  expect(reused?.knowledgeRoot).toBe(first?.knowledgeRoot);
  expect(existsSync(uploadsRoot)).toBe(false);
  expect(run.mock.calls.filter(([args]) => args.includes('upload'))).toHaveLength(1);
  expect(runtime.workdir).toBe('/sandbox/workspaces/mgmt');
  damaged = true;
  ssh.mockImplementation(async (args: readonly string[]) => {
    const command = args.join(' ');
    if (command.includes('attest-knowledge-runtime.py'))
      return JSON.stringify(config.seedStackManifest.runtime);
    if (command.includes('knowledge-cache-probe')) {
      if (mutateHostDuringProbe) {
        const content = 'Changed during remote probe';
        writeFileSync(join(config.seed, 'memory/example.md'), content);
        const baselinePath = join(config.seed, '..', 'baseline.json');
        const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
        baseline.files['memory/example.md'].sha256 = digest(content);
        const payload = { ...baseline };
        delete payload.payloadSha256;
        baseline.payloadSha256 = digest(canonicalJsonPayload(payload));
        const bytes = JSON.stringify(baseline);
        writeFileSync(baselinePath, bytes);
        const receiptPath = join(config.seed, '..', 'publication.json');
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        writeFileSync(
          receiptPath,
          JSON.stringify({
            ...receipt,
            payloadSha256: baseline.payloadSha256,
            baselineSha256: digest(bytes),
          }),
        );
      }
      return JSON.stringify({ valid: !damaged, present });
    }
    if (command.includes('knowledge-cache-repair')) {
      damaged = false;
      return '';
    }
    if (damaged) throw new Error('knowledge mode changed');
    return JSON.stringify({
      context: compiledContext,
      receipt: {
        sourceCommit: 'a'.repeat(40),
        payloadSha256: JSON.parse(readFileSync(join(config.seed, '..', 'baseline.json'), 'utf8'))
          .payloadSha256,
      },
    });
  });
  await resumed.adoptKnowledge(conversation, runtime, AbortSignal.timeout(5000));
  expect(run.mock.calls.filter(([args]) => args.includes('upload'))).toHaveLength(2);
  expect(damaged).toBe(false);
  await resumed.adoptKnowledge(conversation, runtime, AbortSignal.timeout(5000));
  expect(run.mock.calls.filter(([args]) => args.includes('upload'))).toHaveLength(2);
  writeFileSync(join(config.seed, 'memory/example.md'), 'Host changed after prior adoption');
  await expect(
    resumed.adoptKnowledge(conversation, runtime, AbortSignal.timeout(5000)),
  ).rejects.toThrow();
  expect(run.mock.calls.filter(([args]) => args.includes('upload'))).toHaveLength(2);
  writeFileSync(join(config.seed, 'memory/example.md'), 'Accepted A');
  damaged = true;
  mutateHostDuringProbe = true;
  await expect(
    resumed.adoptKnowledge(conversation, runtime, AbortSignal.timeout(5000)),
  ).rejects.toThrow('Knowledge publication changed before upload');
  expect(run.mock.calls.filter(([args]) => args.includes('upload'))).toHaveLength(2);
  expect(readdirSync(uploadsRoot)).toEqual([]);
  expect(reconcile).toHaveBeenCalledTimes(7);
});

it.each(['success', 'failure'] as const)(
  'keeps the upload span open until actual sandbox upload settles with %s',
  async (outcome) => {
    const config = publication();
    const conversation = 'upload-span-chat';
    const name = `mitzo-${digest(conversation).slice(0, 13)}`;
    function span() {
      return {
        end: vi.fn(),
        setStatus: vi.fn(),
        setAttribute: vi.fn(),
        recordException: vi.fn(),
      };
    }
    const spans = new Map<string, ReturnType<typeof span>>();
    vi.spyOn(tracer, 'startSpan').mockImplementation((name) => {
      const created = span();
      spans.set(name, created);
      return created as unknown as ReturnType<typeof tracer.startSpan>;
    });
    let settle!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let entered!: () => void;
    const uploading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const failure = new Error('private upload stderr with credentials and prompt contents');
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('upload')) {
        entered();
        await uploadGate;
        if (outcome === 'failure') throw failure;
        return '';
      }
      return JSON.stringify({
        name,
        id: 'physical-id',
        workspace: 'mitzo',
        phase: 'Ready',
        labels: {
          'mitzo.conversation': digest(conversation).slice(0, 63),
          'mitzo.account_provider': 'openai-work',
        },
      });
    });
    const ssh = vi.fn(async (args: readonly string[]) => {
      const command = args.join(' ');
      if (command.includes('attest-knowledge-runtime.py'))
        return JSON.stringify(config.seedStackManifest.runtime);
      if (command.includes('knowledge-cache-probe'))
        return JSON.stringify({ valid: false, present: false });
      return JSON.stringify({
        context: compiledContext,
        receipt: {
          sourceCommit: 'a'.repeat(40),
          payloadSha256: JSON.parse(readFileSync(join(config.seed, '..', 'baseline.json'), 'utf8'))
            .payloadSha256,
        },
      });
    });
    const manager = new OpenShellRuntimeManager(config, run, undefined, ssh);

    const pending = manager
      .adoptKnowledge(
        conversation,
        {
          sandboxName: name,
          sandboxId: 'physical-id',
          workdir: '/sandbox/workspaces/mgmt',
          appServerCommand: '/sandbox/run-mitzo-app-server',
          cli: 'openshell',
          gateway: 'local',
          workspace: 'mitzo',
          gatewayInsecure: false,
        },
        AbortSignal.timeout(5000),
      )
      .then(
        (result) => result,
        (error: unknown) => error,
      );
    await uploading;
    try {
      expect(spans.get('knowledge.freeze_upload')?.end).toHaveBeenCalledOnce();
      expect(spans.has('knowledge.upload')).toBe(true);
      expect(spans.get('knowledge.upload')?.end).not.toHaveBeenCalled();
    } finally {
      settle();
      await pending;
    }
    const result = await pending;
    if (outcome === 'failure') expect(result).toBe(failure);
    else expect(result).toMatchObject({ sourceCommit: 'a'.repeat(40) });
    const upload = spans.get('knowledge.upload')!;
    expect(upload.end).toHaveBeenCalledOnce();
    expect(upload.setStatus).toHaveBeenCalledExactlyOnceWith({
      code: outcome === 'failure' ? SpanStatusCode.ERROR : SpanStatusCode.OK,
    });
    expect(upload.setAttribute).not.toHaveBeenCalled();
    expect(upload.recordException).not.toHaveBeenCalled();
  },
);

it('keeps publication verification separate from a pinned profile context without compiling default context', async () => {
  const config = publication();
  const conversation = 'retained-chat';
  const owner = digest(conversation).slice(0, 63);
  const name = `mitzo-${digest(conversation).slice(0, 13)}`;
  const run = vi.fn(async (_args: readonly string[]) =>
    JSON.stringify({
      name,
      id: 'physical-id',
      workspace: 'mitzo',
      phase: 'Ready',
      labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': 'openai-work' },
    }),
  );
  const present = false;
  const damaged = false;
  const ssh = vi.fn(async (args: readonly string[]) =>
    args.join(' ').includes('attest-knowledge-runtime.py')
      ? JSON.stringify(config.seedStackManifest.runtime)
      : args.join(' ').includes('knowledge-cache-probe')
        ? JSON.stringify({ valid: present && !damaged, present })
        : JSON.stringify({
            context: compiledContext,
            receipt: {
              sourceCommit: 'a'.repeat(40),
              payloadSha256: JSON.parse(
                readFileSync(join(config.seed, '..', 'baseline.json'), 'utf8'),
              ).payloadSha256,
            },
          }),
  );
  const manager = new OpenShellRuntimeManager(config, run, undefined, ssh);
  const compile = vi.spyOn(manager, 'compileContext').mockResolvedValue({
    type: 'boot_context',
    scope: 'sandbox',
    sourceCount: 1,
    tokenCount: 2,
    tokenBudget: 12000,
    sources: [],
    included: [],
    trimmed: [],
    fullMarkdown: 'Accepted context',
  });
  const runtime = {
    sandboxName: name,
    sandboxId: 'physical-id',
    workdir: '/sandbox/workspaces/mgmt',
    appServerCommand: '/sandbox/run-mitzo-app-server' as const,
    cli: 'openshell',
    gateway: 'local',
    workspace: 'mitzo',
    gatewayInsecure: false,
  };
  const profileContext = {
    type: 'boot_context' as const,
    scope: 'sandbox' as const,
    sourceCount: 1,
    tokenCount: 8,
    tokenBudget: 1000,
    sources: [{ path: 'context/architect.md', kind: 'reference' }],
    included: [],
    trimmed: [],
    fullMarkdown: 'Pinned accepted architecture context',
  };
  const first = await manager.adoptKnowledge(
    conversation,
    runtime,
    AbortSignal.timeout(5000),
    profileContext,
  );
  expect(first?.sourceCommit).toBe('a'.repeat(40));
  expect(first?.adoption).toHaveProperty(
    'runtimeContractImageDigest',
    config.seedStackManifest.runtime.digest,
  );
  expect(first?.adoption).not.toHaveProperty('runtimeImageDigest');
  expect(first?.knowledgeRoot).toMatch(
    /^\/sandbox\/workspaces\/knowledge\/knowledge-[a-f0-9]{64}\/mgmt$/,
  );
  expect(first?.context).toEqual(profileContext);
  expect(compile).not.toHaveBeenCalled();
  expect(ssh.mock.calls.at(-1)![0].at(-1)).toMatch(/ cached'$/);
  expect(
    ssh.mock.calls.some(([args]) => args.join(' ').includes('attest-knowledge-runtime.py')),
  ).toBe(true);
});

it('refuses knowledge adoption by an incompatible retained runtime before uploading', async () => {
  const config = publication();
  const conversation = 'retained-chat';
  const name = `mitzo-${digest(conversation).slice(0, 13)}`;
  const run = vi.fn(async (_args: readonly string[]) =>
    JSON.stringify({
      name,
      id: 'physical-id',
      workspace: 'mitzo',
      phase: 'Ready',
      labels: {
        'mitzo.conversation': digest(conversation).slice(0, 63),
        'mitzo.account_provider': 'openai-work',
      },
    }),
  );
  const ssh = vi.fn(async () =>
    JSON.stringify({
      ...config.seedStackManifest.runtime,
      knowledgeCompilerSha256: '0'.repeat(64),
    }),
  );
  const manager = new OpenShellRuntimeManager(config, run, undefined, ssh);
  await expect(
    manager.adoptKnowledge(
      conversation,
      {
        sandboxName: name,
        sandboxId: 'physical-id',
        workdir: '/sandbox/workspaces/mgmt',
        appServerCommand: '/sandbox/run-mitzo-app-server',
        cli: 'openshell',
        gateway: 'local',
        workspace: 'mitzo',
        gatewayInsecure: false,
      },
      AbortSignal.timeout(5000),
    ),
  ).rejects.toThrow(/incompatible.*knowledge/i);
  expect(run.mock.calls.some(([args]) => args.includes('upload'))).toBe(false);
});

it.each(['transport', 'receipt', 'context', 'missing-context', 'owner', 'cancelled'])(
  'does not retain a compiled context when batched delivery fails: %s',
  async (failure) => {
    const config = publication();
    const conversation = 'delivery-failure';
    const name = `mitzo-${digest(conversation).slice(0, 13)}`;
    let failing = true;
    let delivered = false;
    const abort = new AbortController();
    const run = vi.fn(async (_args: readonly string[]) =>
      JSON.stringify({
        name,
        id: failing && delivered && failure === 'owner' ? 'another-sandbox' : 'physical-id',
        workspace: 'mitzo',
        phase: 'Ready',
        labels: {
          'mitzo.conversation': digest(conversation).slice(0, 63),
          'mitzo.account_provider': config.account.provider,
        },
      }),
    );
    const deliveries: string[] = [];
    const ssh = vi.fn(async (args: readonly string[]) => {
      const command = args.join(' ');
      if (command.includes('attest-knowledge-runtime.py'))
        return JSON.stringify(config.seedStackManifest.runtime);
      if (command.includes('knowledge-cache-probe'))
        return JSON.stringify({ valid: true, present: true });
      deliveries.push(args.at(-1)!);
      delivered = true;
      if (failing && failure === 'transport') throw Error('SSH delivery failed');
      if (failing && failure === 'cancelled') abort.abort();
      return JSON.stringify({
        receipt: {
          sourceCommit: (failing && failure === 'receipt' ? 'b' : 'a').repeat(40),
          payloadSha256: JSON.parse(readFileSync(join(config.seed, '..', 'baseline.json'), 'utf8'))
            .payloadSha256,
        },
        ...(failing && failure === 'missing-context'
          ? {}
          : { context: failing && failure === 'context' ? {} : compiledContext }),
      });
    });
    const manager = new OpenShellRuntimeManager(config, run, undefined, ssh);
    const runtime = {
      sandboxName: name,
      sandboxId: 'physical-id',
      workdir: config.workdir,
      appServerCommand: '/sandbox/run-mitzo-app-server' as const,
      cli: 'openshell',
      gateway: 'local',
      workspace: 'mitzo',
      gatewayInsecure: false,
    };
    await expect(manager.adoptKnowledge(conversation, runtime, abort.signal)).rejects.toThrow();
    failing = false;
    const result = await manager.adoptKnowledge(conversation, runtime, AbortSignal.timeout(5000));
    expect(result?.context).toEqual(compiledContext);
    // Failure cannot mark context compiled: the next admission must compile again.
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((command) => command.endsWith(" compile'"))).toBe(true);
    expect(run.mock.calls.some(([args]) => args.includes('upload'))).toBe(false);
  },
);

it.each([
  { phased: false, admitted: false },
  { phased: true, admitted: false },
  { phased: false, admitted: true },
  { phased: true, admitted: true },
])(
  'ordinary ensure uploads the selected dynamic version through phased=$phased admitted=$admitted creation',
  async ({ phased, admitted }) => {
    const config = publication();
    const originalSeed = config.seed;
    let receipt: Record<string, unknown> | undefined;
    let snapshot = '';
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'provider')
        return JSON.stringify({
          providers: [
            { name: 'openai-work', type: 'openai', id: 'provider-id', workspace: 'mitzo' },
          ],
          next_page_token: '',
        });
      if (args.includes('provider') && args.includes('list'))
        return JSON.stringify({
          providers: [{ name: 'openai-work', type: 'openai' }],
          next_page_token: '',
        });
      if (args.includes('get')) {
        if (!receipt) throw new Error('sandbox not found');
        return JSON.stringify(receipt);
      }
      if (args.includes('create')) {
        const labels = Object.fromEntries(
          args.flatMap((value, i) => (args[i - 1] === '--label' ? [value.split('=')] : [])),
        );
        receipt = {
          name: args[args.indexOf('--name') + 1],
          id: 'physical-id',
          workspace: 'mitzo',
          phase: 'Ready',
          labels,
        };
        writeFileSync(join(originalSeed, 'memory/example.md'), 'Later B while create is in flight');
        if (!phased) {
          snapshot = args[args.indexOf('--upload') + 1].split(':')[0];
          expect(snapshot).not.toBe(config.seed);
          expect(readFileSync(join(snapshot, 'memory/example.md'), 'utf8')).toBe('Accepted A');
        } else expect(args).not.toContain('--upload');
        return JSON.stringify(receipt);
      }
      if (args.includes('upload')) {
        snapshot = args[args.indexOf('upload') + 2];
        expect(snapshot).not.toBe(config.seed);
        expect(readFileSync(join(snapshot, 'memory/example.md'), 'utf8')).toBe('Accepted A');
        expect(args.at(-1)).toBe('/sandbox/workspaces');
      }
      return '{}';
    });
    const manager = new OpenShellRuntimeManager(
      {
        ...config,
        ...(phased
          ? {
              cliContract: 'v0.1' as const,
              onSandboxCreateSettled: vi.fn(),
              accountProviderBindings: [{ name: 'openai-work', type: 'openai', id: 'provider-id' }],
              verifyAccountProviderUnion: () => undefined,
            }
          : {}),
      },
      run,
    );
    const prepared = admitted
      ? await preparePublishedOpenShellSeed(config, new AbortController().signal)
      : undefined;
    if (admitted) {
      config.seed = '/stale-unavailable-seed';
      Object.assign(config, {
        knowledgeStore: {
          id: 'mgmt',
          reconcile: vi.fn(() => {
            throw new Error('must not select another publication');
          }),
        },
      });
    }
    await expect(
      manager.ensure('conversation', new AbortController().signal, undefined, prepared),
    ).resolves.toMatchObject({ created: true });
    if (prepared) expect(snapshot).toBe(prepared.seed);
    expect(snapshot).not.toBe('');
    expect(existsSync(snapshot)).toBe(false);
  },
);

it('rejects tampered dynamic contents before create and upload', async () => {
  const config = publication();
  writeFileSync(join(config.seed, 'memory/example.md'), 'tampered');
  const run = vi.fn(async (_args: readonly string[]) => {
    throw new Error('sandbox not found');
  });
  await expect(
    new OpenShellRuntimeManager(config, run).ensure('conversation', new AbortController().signal),
  ).rejects.toThrow(/hash or mode/);
  expect(
    run.mock.calls.every(([args]) => !args.includes('create') && !args.includes('upload')),
  ).toBe(true);
});

it('cleans the dynamic upload snapshot when asynchronous creation fails', async () => {
  const config = publication();
  let snapshot = '';
  const run = vi.fn(async (args: readonly string[]) => {
    if (args.includes('create')) {
      snapshot = args[args.indexOf('--upload') + 1].split(':')[0];
      expect(existsSync(snapshot)).toBe(true);
      throw new Error('create failed');
    }
    throw new Error('sandbox not found');
  });
  await expect(
    new OpenShellRuntimeManager(config, run).ensure('conversation', new AbortController().signal),
  ).rejects.toThrow('create failed');
  expect(snapshot).not.toBe('');
  expect(existsSync(snapshot)).toBe(false);
});

it('checks selected publication capacity before allocating any host upload snapshot', async () => {
  const config = publication();
  const reconcile = vi.fn(async () => ({
    seed: config.seed,
    sourceCommit: 'a'.repeat(40),
    baselineSha256: digest(readFileSync(join(config.seed, '..', 'baseline.json'), 'utf8')),
  }));
  const selected = {
    ...config,
    seed: '/stale-smaller-seed',
    knowledgeStore: { id: 'mgmt', reconcile },
  };
  const rejectCapacity = vi.fn(async (seed: string) => {
    expect(seed).toBe(config.seed);
    expect(existsSync(join(root, 'private/knowledge-uploads'))).toBe(false);
    throw new Error('host storage capacity insufficient');
  });
  await expect(
    preparePublishedOpenShellSeed(selected, AbortSignal.timeout(5000), rejectCapacity),
  ).rejects.toThrow('capacity insufficient');
  expect(reconcile).toHaveBeenCalledOnce();
  expect(rejectCapacity).toHaveBeenCalledOnce();
  expect(existsSync(join(root, 'private/knowledge-uploads'))).toBe(false);
  const allowCapacity = vi.fn(async (seed: string) => {
    expect(seed).toBe(config.seed);
  });
  const prepared = await preparePublishedOpenShellSeed(
    selected,
    AbortSignal.timeout(5000),
    allowCapacity,
  );
  expect(allowCapacity).toHaveBeenCalledOnce();
  expect(readFileSync(join(prepared.seed, 'memory/example.md'), 'utf8')).toBe('Accepted A');
  prepared.cleanup();
  expect(readdirSync(join(root, 'private/knowledge-uploads'))).toEqual([]);
});

it.each([false, true])(
  'freezes verified file bytes and modes under umask 077 (executable=%s)',
  (executable) => {
    const config = publication(executable);
    const baseline = readFileSync(join(config.seed, '..', 'baseline.json'));
    const files = JSON.parse(baseline.toString()).files as Record<string, { mode: string }>;
    const before = Object.entries(files).map(([path]) => ({
      path,
      bytes: readFileSync(join(config.seed, path)),
      mode: statSync(join(config.seed, path)).mode & 0o7777,
    }));
    const previous = process.umask(0o077);
    let frozen: ReturnType<typeof prepareOpenShellSeed> | undefined;
    try {
      frozen = prepareOpenShellSeed(config);
      expect(statSync(join(frozen.seed, '..')).mode & 0o777).toBe(0o700);
      expect(readFileSync(join(frozen.seed, '..', 'baseline.json'))).toEqual(baseline);
      for (const file of before) {
        expect(readFileSync(join(frozen.seed, file.path))).toEqual(file.bytes);
        expect(statSync(join(frozen.seed, file.path)).mode & 0o7777).toBe(file.mode);
        expect(readFileSync(join(config.seed, file.path))).toEqual(file.bytes);
        expect(statSync(join(config.seed, file.path)).mode & 0o7777).toBe(file.mode);
      }
      expect(process.umask()).toBe(0o077);
    } finally {
      process.umask(previous);
      frozen?.cleanup();
    }
    expect(existsSync(frozen!.seed)).toBe(false);
  },
);

it('refuses linked source knowledge without copying or changing its target', () => {
  const config = publication();
  const target = join(root, 'outside.md');
  writeFileSync(target, 'Accepted A', { mode: 0o644 });
  rmSync(join(config.seed, 'memory/example.md'));
  symlinkSync(target, join(config.seed, 'memory/example.md'));
  expect(() => prepareOpenShellSeed(config)).toThrow('unsafe symlink');
  expect(readFileSync(target, 'utf8')).toBe('Accepted A');
  expect(statSync(target).mode & 0o777).toBe(0o644);
});

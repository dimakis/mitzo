import { createHash } from 'node:crypto';
import {
  chmodSync,
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
import { canonicalJsonPayload } from '../../scripts/verify-openshell-production.mjs';
import {
  OpenShellRuntimeManager,
  prepareOpenShellSeed,
  preparePublishedOpenShellSeed,
} from '../openshell-runtime.js';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
  vi.unstubAllEnvs();
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
  let present = false;
  let damaged = false;
  const ssh = vi.fn(async (args: readonly string[]) =>
    args.join(' ').includes('attest-knowledge-runtime.py')
      ? JSON.stringify(config.seedStackManifest.runtime)
      : args.join(' ').includes('knowledge-cache-status')
        ? String(present && !damaged)
        : args.join(' ').includes('os.path.lexists')
          ? String(present)
          : JSON.stringify({
              sourceCommit: 'a'.repeat(40),
              payloadSha256: JSON.parse(
                readFileSync(join(config.seed, '..', 'baseline.json'), 'utf8'),
              ).payloadSha256,
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
  expect(compile.mock.calls[0][0].workdir).toBe(first?.knowledgeRoot);
  const uploads = run.mock.calls.filter(([args]) => args.includes('upload'));
  expect(uploads).toHaveLength(1);
  expect(uploads[0][0].at(-1)).toBe('/sandbox/workspaces/knowledge');
  present = true;
  await manager.adoptKnowledge(conversation, runtime, AbortSignal.timeout(5000));
  expect(run.mock.calls.filter(([args]) => args.includes('upload'))).toHaveLength(1);
  expect(ssh).toHaveBeenCalledTimes(9);
  present = true;
  const resumed = new OpenShellRuntimeManager(config, run, undefined, ssh);
  vi.spyOn(resumed, 'compileContext').mockResolvedValue(await compile.mock.results[0].value);
  const reused = await resumed.adoptKnowledge(conversation, runtime, AbortSignal.timeout(5000));
  expect(reused?.knowledgeRoot).toBe(first?.knowledgeRoot);
  expect(run.mock.calls.filter(([args]) => args.includes('upload'))).toHaveLength(1);
  expect(runtime.workdir).toBe('/sandbox/workspaces/mgmt');
  damaged = true;
  ssh.mockImplementation(async (args: readonly string[]) => {
    const command = args.join(' ');
    if (command.includes('attest-knowledge-runtime.py'))
      return JSON.stringify(config.seedStackManifest.runtime);
    if (command.includes('knowledge-cache-status')) return String(!damaged);
    if (command.includes('os.path.lexists')) return String(present);
    if (command.includes('knowledge-cache-repair')) {
      damaged = false;
      return '';
    }
    if (damaged) throw new Error('knowledge mode changed');
    return JSON.stringify({
      sourceCommit: 'a'.repeat(40),
      payloadSha256: JSON.parse(readFileSync(join(config.seed, '..', 'baseline.json'), 'utf8'))
        .payloadSha256,
    });
  });
  await resumed.adoptKnowledge(conversation, runtime, AbortSignal.timeout(5000));
  expect(run.mock.calls.filter(([args]) => args.includes('upload'))).toHaveLength(2);
  expect(damaged).toBe(false);
  await resumed.adoptKnowledge(conversation, runtime, AbortSignal.timeout(5000));
  expect(run.mock.calls.filter(([args]) => args.includes('upload'))).toHaveLength(2);
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

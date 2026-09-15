import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalSeedJson,
  OpenShellRuntimeManager,
  openShellCodexRuntimeConfig,
  openShellRuntimeConfig,
  resolveImmutableSeed,
  sandboxNameForConversation,
  verifyImmutableDynamicSeed,
} from '../openshell-runtime.js';
import { createHash } from 'node:crypto';

let privateRoot: string;
beforeEach(() => {
  privateRoot = mkdtempSync(join(tmpdir(), 'mitzo-provider-policy-'));
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', privateRoot);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(privateRoot, { recursive: true, force: true });
});

const config = {
  cli: '/opt/isolated/bin/openshell',
  image: `registry.invalid/mitzo-runtime@sha256:${'c'.repeat(64)}`,
  policy: '/config/policy.yaml',
  seed: '/seed/mgmt',
  serviceProviders: ['github'],
  grantableServiceProviders: ['google-workspace'],
  workspace: 'mitzo',
  gateway: 'local',
  gatewayInsecure: false,
  createDetached: true,
  sandboxIdLength: 13,
  workdir: '/sandbox/workspaces/mgmt',
  webSearch: 'disabled' as const,
  account: { kind: 'api' as const, provider: 'openai-work', model: 'test-model' },
};
const owner = '8b34dbc2c05eb4d7e25d48efeace82456b16cee760bcae80c157f52a3c2e787';
const ready = (phase = 'Ready', providerPolicy = 'state-v2-github') =>
  JSON.stringify({
    name: 'sandbox',
    phase,
    labels: {
      'mitzo.conversation': owner,
      'mitzo.account_provider': 'openai-work',
      'mitzo.provider_policy': providerPolicy,
    },
  });

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function dynamicPayload(baseline: Record<string, unknown>) {
  return {
    startingCommit: baseline.startingCommit,
    runtimeBaseCommit: baseline.runtimeBaseCommit,
    runtimeDependencyProjectionSha256: baseline.runtimeDependencyProjectionSha256,
    files: baseline.files,
  };
}

function dynamicRelease(
  release: string,
  stackManifest: string,
  contents = 'immutable knowledge\n',
  writeStack = true,
) {
  const mgmt = join(release, 'mgmt');
  mkdirSync(mgmt, { recursive: true });
  writeFileSync(join(mgmt, 'knowledge.md'), contents);
  const unicodePath = 'réleases/Ω-note.md';
  const unicodeContents = 'café\n';
  mkdirSync(join(mgmt, 'réleases'), { recursive: true });
  writeFileSync(join(mgmt, unicodePath), unicodeContents);
  const files: Record<string, { sha256: string; mode: string }> = {
    'knowledge.md': { sha256: sha256(contents), mode: '0644' },
    [unicodePath]: { sha256: sha256(unicodeContents), mode: '0644' },
  };
  for (const name of ['index.json', 'wikilinks.json', 'by_type.json', 'by_tag.json']) {
    const path = `memory/manifest/${name}`;
    const manifest = JSON.stringify({ sourceCommit: 'a'.repeat(40) }) + '\n';
    mkdirSync(join(mgmt, 'memory', 'manifest'), { recursive: true });
    writeFileSync(join(mgmt, path), manifest);
    files[path] = { sha256: sha256(manifest), mode: '0644' };
  }
  const baseline = {
    startingCommit: 'a'.repeat(40),
    runtimeBaseCommit: 'a'.repeat(40),
    runtimeDependencyProjectionSha256: 'b'.repeat(64),
    files,
  };
  const payloadSha256 = sha256(canonicalSeedJson(dynamicPayload(baseline)));
  writeFileSync(join(release, 'baseline.json'), JSON.stringify({ ...baseline, payloadSha256 }));
  if (writeStack)
    writeFileSync(
      stackManifest,
      JSON.stringify({
        runtime: {
          image: config.image,
          mgmtSourceCommit: 'a'.repeat(40),
          dependencyProjectionSha256: 'b'.repeat(64),
          seedPayloadSha256: payloadSha256,
        },
      }),
    );
}

describe('OpenShell runtime lifecycle', () => {
  it('derives a stable non-revealing sandbox identity', () => {
    expect(sandboxNameForConversation('private-conversation-name')).toMatch(/^mitzo-[a-f0-9]{13}$/);
    expect(sandboxNameForConversation('private-conversation-name')).toHaveLength(19);
    expect(sandboxNameForConversation('private-conversation-name')).not.toContain('private');
  });

  it('pins a dynamic current release before the sandbox create request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-seed-releases-'));
    const releases = join(root, 'releases');
    mkdirSync(releases);
    const releaseA = join(releases, 'release-a');
    const releaseB = join(releases, 'release-b');
    const stackManifest = join(root, 'stack.lock.json');
    dynamicRelease(releaseA, stackManifest);
    dynamicRelease(releaseB, stackManifest, 'replacement knowledge\n', false);
    const current = join(releases, 'current');
    symlinkSync(releaseA, current);
    try {
      let created = false;
      let uploadedKnowledge = '';
      const run = vi.fn(async (args: readonly string[]) => {
        if (args.includes('get')) {
          if (!created) throw new Error('sandbox not found');
          return ready();
        }
        if (args.includes('create')) {
          // A release writer can change its source immediately after snapshot
          // creation. OpenShell must still read the frozen private copy.
          unlinkSync(current);
          symlinkSync(releaseB, current);
          const upload = args[args.indexOf('--upload') + 1] as string;
          uploadedKnowledge = readFileSync(join(upload.split(':')[0], 'knowledge.md'), 'utf8');
          created = true;
          return '{}';
        }
        return ready();
      });
      await new OpenShellRuntimeManager(
        { ...config, seed: join(current, 'mgmt'), stackManifest },
        run,
      ).ensure('conversation', new AbortController().signal);
      const create = run.mock.calls.find(([args]) =>
        (args as string[]).includes('create'),
      )![0] as string[];
      const upload = create[create.indexOf('--upload') + 1];
      expect(upload).not.toContain(realpathSync(join(releaseA, 'mgmt')));
      expect(upload).not.toContain(realpathSync(join(releaseB, 'mgmt')));
      expect(uploadedKnowledge).toBe('immutable knowledge\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects dangling or escaping dynamic current releases', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-seed-releases-'));
    const releases = join(root, 'releases');
    mkdirSync(releases);
    const outside = mkdtempSync(join(tmpdir(), 'mitzo-seed-outside-'));
    const current = join(releases, 'current');
    try {
      symlinkSync(join(releases, 'missing'), current);
      expect(() => resolveImmutableSeed(join(current, 'mgmt'))).toThrow('dangling');
      unlinkSync(current);
      mkdirSync(join(outside, 'mgmt'));
      symlinkSync(outside, current);
      expect(() => resolveImmutableSeed(join(current, 'mgmt'))).toThrow('escapes');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a tampered resolved dynamic release at the upload boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-seed-releases-'));
    const releases = join(root, 'releases');
    const release = join(releases, 'release-a');
    const stackManifest = join(root, 'stack.lock.json');
    mkdirSync(releases);
    dynamicRelease(release, stackManifest);
    const current = join(releases, 'current');
    symlinkSync(release, current);
    try {
      writeFileSync(join(release, 'mgmt', 'knowledge.md'), 'tampered\n');
      expect(() =>
        verifyImmutableDynamicSeed(join(current, 'mgmt'), stackManifest, config.image),
      ).toThrow('file hash');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects dynamic manifests whose source provenance differs from the baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-seed-releases-'));
    const releases = join(root, 'releases');
    const release = join(releases, 'release-a');
    const stackManifest = join(root, 'stack.lock.json');
    mkdirSync(releases);
    dynamicRelease(release, stackManifest);
    const current = join(releases, 'current');
    symlinkSync(release, current);
    try {
      const manifest = JSON.stringify({ sourceCommit: 'b'.repeat(40) }) + '\n';
      const path = join(release, 'mgmt', 'memory', 'manifest', 'index.json');
      writeFileSync(path, manifest);
      const baseline = JSON.parse(readFileSync(join(release, 'baseline.json'), 'utf8'));
      baseline.files['memory/manifest/index.json'].sha256 = sha256(manifest);
      baseline.payloadSha256 = sha256(canonicalSeedJson(dynamicPayload(baseline)));
      writeFileSync(join(release, 'baseline.json'), JSON.stringify(baseline));
      writeFileSync(
        stackManifest,
        JSON.stringify({
          runtime: {
            ...JSON.parse(readFileSync(stackManifest, 'utf8')).runtime,
            seedPayloadSha256: baseline.payloadSha256,
          },
        }),
      );
      expect(() =>
        verifyImmutableDynamicSeed(join(current, 'mgmt'), stackManifest, config.image),
      ).toThrow('manifest provenance');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds baseline control fields into the stack-pinned payload digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-seed-releases-'));
    const releases = join(root, 'releases');
    const release = join(releases, 'release-a');
    const stackManifest = join(root, 'stack.lock.json');
    mkdirSync(releases);
    dynamicRelease(release, stackManifest);
    const current = join(releases, 'current');
    symlinkSync(release, current);
    try {
      const baseline = JSON.parse(readFileSync(join(release, 'baseline.json'), 'utf8'));
      baseline.startingCommit = 'b'.repeat(40);
      writeFileSync(join(release, 'baseline.json'), JSON.stringify(baseline));
      expect(() =>
        verifyImmutableDynamicSeed(join(current, 'mgmt'), stackManifest, config.image),
      ).toThrow('payload digest');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('revalidates its private snapshot immediately before upload', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-seed-releases-'));
    const releases = join(root, 'releases');
    const release = join(releases, 'release-a');
    const stackManifest = join(root, 'stack.lock.json');
    mkdirSync(releases);
    dynamicRelease(release, stackManifest);
    const current = join(releases, 'current');
    symlinkSync(release, current);
    try {
      const snapshot = verifyImmutableDynamicSeed(
        join(current, 'mgmt'),
        stackManifest,
        config.image,
      );
      if (typeof snapshot === 'string') throw new Error('expected a private dynamic snapshot');
      writeFileSync(join(snapshot.path, 'knowledge.md'), 'tampered private copy\n');
      expect(snapshot.verify).toThrow('file hash');
      snapshot.cleanup();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires the dynamic stack lock and sandbox image to be the same digest reference', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-seed-releases-'));
    const releases = join(root, 'releases');
    const release = join(releases, 'release-a');
    const stackManifest = join(root, 'stack.lock.json');
    mkdirSync(releases);
    dynamicRelease(release, stackManifest);
    const current = join(releases, 'current');
    symlinkSync(release, current);
    try {
      expect(() =>
        verifyImmutableDynamicSeed(
          join(current, 'mgmt'),
          stackManifest,
          `registry.invalid/mitzo-runtime@sha256:${'d'.repeat(64)}`,
        ),
      ).toThrow('does not match the configured image');
      expect(() =>
        verifyImmutableDynamicSeed(join(current, 'mgmt'), stackManifest, 'mitzo-runtime:release'),
      ).toThrow('requires a digest-pinned configured image');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates a missing sandbox with the seed and broker providers', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('sandbox not found'))
      .mockRejectedValueOnce(new Error('sandbox not found'))
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(ready());
    const result = await new OpenShellRuntimeManager(config, run).ensure(
      'conversation',
      new AbortController().signal,
    );
    expect(result.workdir).toBe('/sandbox/workspaces/mgmt');
    const create = run.mock.calls[2][0] as string[];
    expect(create).toContain('create');
    expect(create).toContain('/seed/mgmt:/sandbox/workspaces');
    expect(create.filter((value) => value === '--provider')).toHaveLength(2);
    expect(create.filter((_, index) => create[index - 1] === '--provider')).toEqual([
      'openai-work',
      'github',
    ]);
    expect(create).toContain('mitzo.account_provider=openai-work');
    expect(create).toContain('mitzo.provider_policy=state-v2-github');
    expect(
      create.find((value) => value.startsWith('mitzo.conversation='))?.split('=')[1],
    ).toHaveLength(63);
    expect(create).not.toContain('--inference-provider');
    expect(create).not.toContain('--inference-model');
    expect(create).not.toContain('auto-providers');
  });

  it('waits through asynchronous creation phases until the sandbox is Ready', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('sandbox not found'))
      .mockRejectedValueOnce(new Error('sandbox not found'))
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(ready('Creating'))
      .mockResolvedValueOnce(ready('Starting'))
      .mockResolvedValueOnce(ready());
    await expect(
      new OpenShellRuntimeManager(config, run, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }).ensure('conversation', new AbortController().signal),
    ).resolves.toMatchObject({ workdir: '/sandbox/workspaces/mgmt' });
    expect(run).toHaveBeenCalledTimes(6);
  });

  it('bounds and aborts readiness polling', async () => {
    const creating = vi.fn().mockResolvedValue(ready('Creating'));
    await expect(
      new OpenShellRuntimeManager(config, creating, {
        pollIntervalMs: 0,
        timeoutMs: 5,
      }).ensure('conversation', new AbortController().signal),
    ).rejects.toThrow('did not become Ready');

    const controller = new AbortController();
    const pending = new OpenShellRuntimeManager(config, creating, {
      pollIntervalMs: 1_000,
      timeoutMs: 30_000,
    }).ensure('conversation', controller.signal);
    await vi.waitFor(() => expect(creating).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it('reuses Ready and starts Stopped sandboxes without recreating them', async () => {
    const readyRun = vi.fn().mockResolvedValue(ready());
    await new OpenShellRuntimeManager(config, readyRun).ensure(
      'conversation',
      new AbortController().signal,
    );
    expect(readyRun).toHaveBeenCalledTimes(1);

    const stopped = vi
      .fn()
      .mockResolvedValueOnce(ready('Stopped'))
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(ready('Starting'))
      .mockResolvedValueOnce(ready());
    await new OpenShellRuntimeManager(config, stopped, {
      pollIntervalMs: 0,
      timeoutMs: 100,
    }).ensure('conversation', new AbortController().signal);
    expect(stopped.mock.calls[1][0]).toContain('start');
    expect(stopped.mock.calls.flat().flat()).not.toContain('create');
  });

  it('normalizes a numeric gateway resource version for lifecycle fencing', async () => {
    const sandbox = JSON.parse(ready());
    sandbox.id = 'sandbox-id';
    sandbox.resource_version = 9;
    const runtime = await new OpenShellRuntimeManager(
      config,
      vi.fn().mockResolvedValue(JSON.stringify(sandbox)),
    ).ensure('conversation', new AbortController().signal);

    expect(runtime).toMatchObject({ sandboxId: 'sandbox-id', resourceVersion: '9' });
  });

  it('uses the stable gateway revision when inspecting a stopped lifecycle fence', async () => {
    const sandbox = JSON.parse(ready('Stopped'));
    sandbox.id = 'sandbox-id';
    sandbox.resource_version = 19;
    sandbox.revision = 1;
    const inspected = await new OpenShellRuntimeManager(
      config,
      vi.fn().mockResolvedValue(JSON.stringify(sandbox)),
    ).inspect('conversation', 'sandbox-id', new AbortController().signal);

    expect(inspected).toEqual({ id: 'sandbox-id', phase: 'Stopped', resourceVersion: '1' });
  });

  it('does not treat a stopped resource observation as a stable deletion revision', async () => {
    const sandbox = JSON.parse(ready('Stopped'));
    sandbox.id = 'sandbox-id';
    sandbox.resource_version = 19;
    const inspected = await new OpenShellRuntimeManager(
      config,
      vi.fn().mockResolvedValue(JSON.stringify(sandbox)),
    ).inspect('conversation', 'sandbox-id', new AbortController().signal);

    expect(inspected).toEqual({ id: 'sandbox-id', phase: 'Stopped' });
  });

  it('uses resource_version rather than revision for a Ready checkpoint source', async () => {
    const sandbox = JSON.parse(ready());
    sandbox.id = 'sandbox-id';
    sandbox.resource_version = 19;
    sandbox.revision = 1;
    const inspected = await new OpenShellRuntimeManager(
      config,
      vi.fn().mockResolvedValue(JSON.stringify(sandbox)),
    ).inspect('conversation', 'sandbox-id', new AbortController().signal);

    expect(inspected).toEqual({ id: 'sandbox-id', phase: 'Ready', resourceVersion: '19' });
  });

  it('reports an absent lifecycle sandbox as undefined during inspection', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('sandbox not found'))
      .mockRejectedValueOnce(new Error('sandbox not found'));

    await expect(
      new OpenShellRuntimeManager(config, run).inspect(
        'conversation',
        'sandbox-id',
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
  });

  it('revokes grant-only providers from a retained pre-change sandbox', async () => {
    const legacyPolicyReady = ready('Ready', 'grant-v1');
    const run = vi
      .fn()
      .mockResolvedValueOnce(legacyPolicyReady)
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(legacyPolicyReady);
    await new OpenShellRuntimeManager(
      {
        ...config,
        serviceProviders: ['github'],
        grantableServiceProviders: ['google-workspace'],
      },
      run,
    ).ensure('conversation', new AbortController().signal);

    expect(run.mock.calls.find(([args]) => args.includes('detach'))?.[0]).toEqual([
      'sandbox',
      '--gateway',
      'local',
      '--workspace',
      'mitzo',
      'provider',
      'detach',
      sandboxNameForConversation('conversation'),
      'google-workspace',
    ]);
    expect(
      JSON.parse(
        readFileSync(
          join(
            privateRoot,
            'openshell-provider-policy',
            `${sandboxNameForConversation('conversation')}.json`,
          ),
          'utf8',
        ),
      ),
    ).toEqual({ automatic: ['github'], granted: [] });
  });

  it('preserves a migrated chat grant across a server restart', async () => {
    let record: { automatic: string[]; granted: string[] } | undefined;
    const policyState = {
      read: vi.fn(() => record),
      write: vi.fn((_name: string, next: typeof record) => {
        record = next;
      }),
    };
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return ready('Ready', 'grant-v1');
      return '{}';
    });
    const migratedConfig = {
      ...config,
      serviceProviders: ['github'],
      grantableServiceProviders: ['google-workspace'],
    };
    const manager = new OpenShellRuntimeManager(
      migratedConfig,
      run,
      undefined,
      undefined,
      policyState,
    );
    const signal = new AbortController().signal;
    const runtime = await manager.ensure('conversation', signal);
    await manager.grantServiceProvider('conversation', runtime, 'google-workspace', signal);
    await new OpenShellRuntimeManager(
      migratedConfig,
      run,
      undefined,
      undefined,
      policyState,
    ).ensure('conversation', signal);

    const commands = run.mock.calls.map(([args]) => args as readonly string[]);
    expect(
      commands.filter((args) => args.includes('detach') && args.includes('google-workspace')),
    ).toHaveLength(1);
    expect(
      commands.filter((args) => args.includes('attach') && args.includes('google-workspace')),
    ).toHaveLength(1);
  });

  it('revokes a durable grant removed from administrator policy', async () => {
    let record = { automatic: ['github'], granted: ['google-workspace'] };
    const policyState = {
      read: vi.fn(() => record),
      write: vi.fn((_name: string, next: typeof record) => {
        record = next;
      }),
    };
    const run = vi
      .fn()
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(ready());
    await new OpenShellRuntimeManager(
      { ...config, serviceProviders: ['github'], grantableServiceProviders: [] },
      run,
      undefined,
      undefined,
      policyState,
    ).ensure('conversation', new AbortController().signal);

    expect(run.mock.calls.find(([args]) => args.includes('detach'))?.[0]).toEqual([
      'sandbox',
      '--gateway',
      'local',
      '--workspace',
      'mitzo',
      'provider',
      'detach',
      sandboxNameForConversation('conversation'),
      'google-workspace',
    ]);
    expect(record).toEqual({ automatic: ['github'], granted: [] });
  });

  it('requires approval when an automatic provider becomes grantable', async () => {
    let record = { automatic: ['google-workspace', 'github'], granted: [] as string[] };
    const policyState = {
      read: vi.fn(() => record),
      write: vi.fn((_name: string, next: typeof record) => {
        record = next;
      }),
    };
    const run = vi
      .fn()
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(ready());
    await new OpenShellRuntimeManager(
      { ...config, serviceProviders: ['github'], grantableServiceProviders: ['google-workspace'] },
      run,
      undefined,
      undefined,
      policyState,
    ).ensure('conversation', new AbortController().signal);

    expect(run.mock.calls.find(([args]) => args.includes('detach'))?.[0]).toContain(
      'google-workspace',
    );
    expect(record).toEqual({ automatic: ['github'], granted: [] });
  });

  it('attaches an explicitly grantable provider to the owned conversation sandbox', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(ready());
    const manager = new OpenShellRuntimeManager(config, run);
    const sandboxName = sandboxNameForConversation('conversation');
    await expect(
      manager.grantServiceProvider(
        'conversation',
        {
          sandboxName,
          workdir: config.workdir,
          appServerCommand: '/sandbox/run-mitzo-app-server',
          cli: config.cli,
          gateway: config.gateway,
          workspace: config.workspace,
          gatewayInsecure: false,
        },
        'google-workspace',
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    expect(run.mock.calls[1][0]).toEqual([
      'sandbox',
      '--gateway',
      'local',
      '--workspace',
      'mitzo',
      'provider',
      'attach',
      sandboxName,
      'google-workspace',
    ]);
  });

  it('serializes concurrent grants so durable provider state cannot be overwritten', async () => {
    let record = { automatic: [] as string[], granted: [] as string[] };
    const policyState = {
      read: vi.fn(() => ({
        ...record,
        automatic: [...record.automatic],
        granted: [...record.granted],
      })),
      write: vi.fn((_name: string, next: typeof record) => {
        record = next;
      }),
    };
    let releaseFirstAttach!: () => void;
    const firstAttach = new Promise<void>((resolve) => {
      releaseFirstAttach = resolve;
    });
    const attachCalls: string[] = [];
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return ready();
      if (args.includes('attach')) {
        const provider = args.at(-1)!;
        attachCalls.push(provider);
        if (provider === 'google-workspace') await firstAttach;
      }
      return '{}';
    });
    const grantConfig = {
      ...config,
      serviceProviders: [],
      grantableServiceProviders: ['google-workspace', 'github'],
    };
    const googleManager = new OpenShellRuntimeManager(
      grantConfig,
      run,
      undefined,
      undefined,
      policyState,
    );
    const githubManager = new OpenShellRuntimeManager(
      grantConfig,
      run,
      undefined,
      undefined,
      policyState,
    );
    const runtime = {
      sandboxName: sandboxNameForConversation('conversation'),
      workdir: config.workdir,
      appServerCommand: '/sandbox/run-mitzo-app-server' as const,
      cli: config.cli,
      gateway: config.gateway,
      workspace: config.workspace,
      gatewayInsecure: false,
    };
    const signal = new AbortController().signal;
    const googleGrant = googleManager.grantServiceProvider(
      'conversation',
      runtime,
      'google-workspace',
      signal,
    );
    const githubGrant = githubManager.grantServiceProvider(
      'conversation',
      runtime,
      'github',
      signal,
    );

    await vi.waitFor(() => expect(attachCalls).toEqual(['google-workspace']));
    releaseFirstAttach();
    await Promise.all([googleGrant, githubGrant]);

    expect(attachCalls).toEqual(['google-workspace', 'github']);
    expect(record).toEqual({ automatic: [], granted: ['google-workspace', 'github'] });
  });

  it('serializes retained-sandbox reconciliation with an in-flight grant', async () => {
    let record = { automatic: ['github'], granted: [] as string[] };
    const policyState = {
      read: vi.fn(() => ({
        ...record,
        automatic: [...record.automatic],
        granted: [...record.granted],
      })),
      write: vi.fn((_name: string, next: typeof record) => {
        record = next;
      }),
    };
    let releaseAttach!: () => void;
    const attach = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    const commands: (readonly string[])[] = [];
    const run = vi.fn(async (args: readonly string[]) => {
      commands.push(args);
      if (args.includes('get')) return ready();
      if (args.includes('attach') && args.at(-1) === 'google-workspace') await attach;
      return '{}';
    });
    const grantManager = new OpenShellRuntimeManager(
      config,
      run,
      undefined,
      undefined,
      policyState,
    );
    const reconnectManager = new OpenShellRuntimeManager(
      config,
      run,
      undefined,
      undefined,
      policyState,
    );
    const runtime = {
      sandboxName: sandboxNameForConversation('conversation'),
      workdir: config.workdir,
      appServerCommand: '/sandbox/run-mitzo-app-server' as const,
      cli: config.cli,
      gateway: config.gateway,
      workspace: config.workspace,
      gatewayInsecure: false,
    };
    const signal = new AbortController().signal;
    const grant = grantManager.grantServiceProvider(
      'conversation',
      runtime,
      'google-workspace',
      signal,
    );
    await vi.waitFor(() => expect(commands.some((args) => args.includes('attach'))).toBe(true));
    const reconnect = reconnectManager.ensure('conversation', signal);

    releaseAttach();
    await Promise.all([grant, reconnect]);

    expect(commands.some((args) => args.includes('detach'))).toBe(false);
    expect(record).toEqual({ automatic: ['github'], granted: ['google-workspace'] });
  });

  it('records an attached provider before readiness failure so policy can revoke it', async () => {
    let record = { automatic: ['github'], granted: [] as string[] };
    const policyState = {
      read: vi.fn(() => ({
        ...record,
        automatic: [...record.automatic],
        granted: [...record.granted],
      })),
      write: vi.fn((_name: string, next: typeof record) => {
        record = next;
      }),
    };
    const grantRun = vi
      .fn()
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(ready('Error'));
    const runtime = {
      sandboxName: sandboxNameForConversation('conversation'),
      workdir: config.workdir,
      appServerCommand: '/sandbox/run-mitzo-app-server' as const,
      cli: config.cli,
      gateway: config.gateway,
      workspace: config.workspace,
      gatewayInsecure: false,
    };
    await expect(
      new OpenShellRuntimeManager(
        config,
        grantRun,
        undefined,
        undefined,
        policyState,
      ).grantServiceProvider(
        'conversation',
        runtime,
        'google-workspace',
        new AbortController().signal,
      ),
    ).rejects.toThrow('is Error');
    expect(record.granted).toEqual(['google-workspace']);

    const reconcileRun = vi
      .fn()
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(ready());
    await new OpenShellRuntimeManager(
      { ...config, grantableServiceProviders: [] },
      reconcileRun,
      undefined,
      undefined,
      policyState,
    ).ensure('conversation', new AbortController().signal);

    expect(reconcileRun.mock.calls.find(([args]) => args.includes('detach'))?.[0]).toContain(
      'google-workspace',
    );
    expect(record).toEqual({ automatic: ['github'], granted: [] });
  });

  it('rejects unconfigured provider grants before calling OpenShell', async () => {
    const run = vi.fn();
    const manager = new OpenShellRuntimeManager(config, run);
    await expect(
      manager.grantServiceProvider(
        'conversation',
        {
          sandboxName: 'sandbox',
          workdir: config.workdir,
          appServerCommand: '/sandbox/run-mitzo-app-server',
          cli: config.cli,
          gateway: config.gateway,
          workspace: config.workspace,
          gatewayInsecure: false,
        },
        'unreviewed-provider',
        new AbortController().signal,
      ),
    ).rejects.toThrow('not grantable');
    expect(run).not.toHaveBeenCalled();
  });

  it('reuses a retained legacy sandbox with its original name and ownership label', async () => {
    const legacyOwner = `${owner}b`;
    const legacyReady = JSON.stringify({
      name: 'legacy',
      phase: 'Ready',
      labels: {
        'mitzo.conversation': legacyOwner,
        'mitzo.account_provider': 'openai-work',
      },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('sandbox not found'))
      .mockResolvedValueOnce(legacyReady)
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(legacyReady);

    const runtime = await new OpenShellRuntimeManager(config, run).ensure(
      'conversation',
      new AbortController().signal,
    );
    expect(runtime).toMatchObject({ sandboxName: `mitzo-${legacyOwner.slice(0, 24)}` });
    expect(runtime).not.toHaveProperty('created');
    expect(run).toHaveBeenCalledTimes(5);
    expect(run.mock.calls.flat().flat()).not.toContain('create');
  });

  it('does not adopt a retained legacy sandbox with mismatched ownership', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('sandbox not found'))
      .mockResolvedValueOnce(
        JSON.stringify({
          name: 'legacy',
          phase: 'Ready',
          labels: {
            'mitzo.conversation': 'different',
            'mitzo.account_provider': 'openai-work',
          },
        }),
      );

    await expect(
      new OpenShellRuntimeManager(config, run).ensure('conversation', new AbortController().signal),
    ).rejects.toThrow('not owned');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('fails closed on errored or incomplete runtimes', async () => {
    const run = vi.fn().mockResolvedValue(ready('Error'));
    await expect(
      new OpenShellRuntimeManager(config, run).ensure('conversation', new AbortController().signal),
    ).rejects.toThrow('is Error');
  });

  it('does not adopt a same-named sandbox owned by another conversation', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({
        name: 'sandbox',
        phase: 'Ready',
        labels: {
          'mitzo.conversation': 'different',
          'mitzo.account_provider': 'openai-work',
        },
      }),
    );
    await expect(
      new OpenShellRuntimeManager(config, run).ensure('conversation', new AbortController().signal),
    ).rejects.toThrow('not owned');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a sandbox bound to another API provider', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({
        name: 'sandbox',
        phase: 'Ready',
        labels: {
          'mitzo.conversation': owner,
          'mitzo.account_provider': 'openai-other',
        },
      }),
    );
    await expect(
      new OpenShellRuntimeManager(config, run).ensure('conversation', new AbortController().signal),
    ).rejects.toThrow('another account provider');
  });

  it('lists only verified conversation sandboxes and fences stop/delete by exact identity', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            id: 'physical-1',
            name: 'mitzo-123',
            phase: 'Stopped',
            workspace: 'mitzo',
            labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': 'openai-work' },
          },
          {
            id: 'foreign',
            name: 'other',
            phase: 'Ready',
            workspace: 'mitzo',
            labels: { 'mitzo.conversation': 'other', 'mitzo.account_provider': 'openai-work' },
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          id: 'physical-1',
          name: 'mitzo-123',
          phase: 'Ready',
          labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': 'openai-work' },
        }),
      )
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(
        JSON.stringify({
          id: 'physical-1',
          name: 'mitzo-123',
          phase: 'Stopped',
          labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': 'openai-work' },
        }),
      )
      .mockResolvedValueOnce('{}')
      .mockRejectedValueOnce(new Error('sandbox not found'));
    const manager = new OpenShellRuntimeManager(config, run);
    await expect(manager.inventory(new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({ id: 'physical-1', phase: 'Stopped' }),
      expect.objectContaining({ id: 'foreign', phase: 'Ready' }),
    ]);
    await manager.stop('conversation', 'physical-1', new AbortController().signal);
    await manager.delete('conversation', 'physical-1', new AbortController().signal);
    expect(run.mock.calls[2][0]).toEqual(expect.arrayContaining(['stop', 'mitzo-123']));
    expect(run.mock.calls[4][0]).toEqual(expect.arrayContaining(['delete', 'mitzo-123']));
  });

  it('waits for asynchronous gateway deletion to become absent', async () => {
    const stopped = JSON.stringify({
      id: 'physical-1',
      name: sandboxNameForConversation('conversation'),
      phase: 'Stopped',
      labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': 'openai-work' },
    });
    const run = vi
      .fn()
      .mockResolvedValueOnce(stopped)
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(stopped.replace('"Stopped"', '"Deleting"'))
      .mockRejectedValueOnce(new Error('sandbox not found'));
    await expect(
      new OpenShellRuntimeManager(config, run, { pollIntervalMs: 0, timeoutMs: 100 }).delete(
        'conversation',
        'physical-1',
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    expect(run.mock.calls[1][0]).toEqual(expect.arrayContaining(['delete']));
    expect(run.mock.calls).toHaveLength(4);
  });

  it('fails closed when a same-named replacement appears while deletion settles', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          id: 'physical-1',
          name: sandboxNameForConversation('conversation'),
          phase: 'Stopped',
          labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': 'openai-work' },
        }),
      )
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(
        JSON.stringify({
          id: 'replacement',
          name: sandboxNameForConversation('conversation'),
          phase: 'Ready',
          labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': 'openai-work' },
        }),
      );
    await expect(
      new OpenShellRuntimeManager(config, run, { pollIntervalMs: 0, timeoutMs: 100 }).delete(
        'conversation',
        'physical-1',
        new AbortController().signal,
      ),
    ).rejects.toThrow('identity changed during delete');
  });

  it('fails closed if asynchronous deletion never becomes absent', async () => {
    const stopped = JSON.stringify({
      id: 'physical-1',
      name: sandboxNameForConversation('conversation'),
      phase: 'Stopped',
      labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': 'openai-work' },
    });
    const run = vi.fn().mockResolvedValue(stopped);
    await expect(
      new OpenShellRuntimeManager(config, run, { pollIntervalMs: 0, timeoutMs: 5 }).delete(
        'conversation',
        'physical-1',
        new AbortController().signal,
      ),
    ).rejects.toThrow('did not disappear after delete');
  });

  it('bounds an individual gateway read by the deletion deadline', async () => {
    const stopped = JSON.stringify({
      id: 'physical-1',
      name: sandboxNameForConversation('conversation'),
      phase: 'Stopped',
      labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': 'openai-work' },
    });
    const run = vi
      .fn()
      .mockResolvedValueOnce(stopped)
      .mockResolvedValueOnce('{}')
      .mockImplementationOnce(
        (_args: readonly string[], signal: AbortSignal) =>
          new Promise<string>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('gateway read aborted'))),
          ),
      );
    await expect(
      new OpenShellRuntimeManager(config, run, { pollIntervalMs: 0, timeoutMs: 5 }).delete(
        'conversation',
        'physical-1',
        new AbortController().signal,
      ),
    ).rejects.toThrow('did not disappear after delete');
  });

  it('aborts while waiting for asynchronous deletion to settle', async () => {
    const stopped = JSON.stringify({
      id: 'physical-1',
      name: sandboxNameForConversation('conversation'),
      phase: 'Stopped',
      labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': 'openai-work' },
    });
    const run = vi.fn().mockResolvedValue(stopped);
    const controller = new AbortController();
    const deletion = new OpenShellRuntimeManager(config, run, {
      pollIntervalMs: 1_000,
      timeoutMs: 30_000,
    }).delete('conversation', 'physical-1', controller.signal);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    controller.abort();
    await expect(deletion).rejects.toThrow(/abort/i);
  });

  it('does not issue a stop after queue admission invalidates the lifecycle fence', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({
        id: 'physical-1',
        name: 'mitzo-123',
        phase: 'Ready',
        labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': 'openai-work' },
      }),
    );
    await expect(
      new OpenShellRuntimeManager(config, run).stop(
        'conversation',
        'physical-1',
        new AbortController().signal,
        () => false,
      ),
    ).rejects.toThrow('activity changed before stop');
    expect(run.mock.calls.flatMap(([args]) => args)).not.toContain('stop');
  });

  it('does not issue deletion after the final lifecycle fence changes', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({
        id: 'physical-1',
        name: 'mitzo-123',
        phase: 'Stopped',
        labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': 'openai-work' },
      }),
    );
    await expect(
      new OpenShellRuntimeManager(config, run).delete(
        'conversation',
        'physical-1',
        new AbortController().signal,
        () => false,
      ),
    ).rejects.toThrow('state changed before delete');
    expect(run.mock.calls.flatMap(([args]) => args)).not.toContain('delete');
  });

  it('refuses lifecycle mutation when the physical sandbox identity or phase changed', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({
        id: 'replacement',
        name: 'mitzo-123',
        phase: 'Stopped',
        labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': 'openai-work' },
      }),
    );
    await expect(
      new OpenShellRuntimeManager(config, run).delete(
        'conversation',
        'physical-1',
        new AbortController().signal,
      ),
    ).rejects.toThrow('identity changed');
    expect(run.mock.calls.flat().flat()).not.toContain('delete');
  });

  it('compiles launch context against the exact sandbox workspace', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({
        type: 'boot_context',
        scope: 'sandbox',
        sourceCount: 1,
        tokenCount: 2,
        tokenBudget: 12000,
        sources: [{ path: 'AGENTS.md', kind: 'instructions' }],
        included: [],
        trimmed: [],
        fullMarkdown: '# Context',
      }),
    );
    const manager = new OpenShellRuntimeManager(config, vi.fn(), undefined, run);
    await expect(
      manager.compileContext(
        {
          sandboxName: 'mitzo-runtime',
          workdir: '/sandbox/workspaces/mgmt',
          appServerCommand: '/sandbox/run-mitzo-app-server',
          cli: config.cli,
          gateway: config.gateway,
          workspace: config.workspace,
          gatewayInsecure: false,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ fullMarkdown: '# Context', scope: 'sandbox' });
    expect(run.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        'sandbox@openshell-mitzo-runtime.mitzo',
        '/usr/bin/node /sandbox/compile-mgmt-context.mjs /sandbox/workspaces/mgmt 12000',
      ]),
    );
  });

  it('accepts only explicit absolute lifecycle configuration', () => {
    expect(
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: 'runtime:1',
        MITZO_OPENSHELL_POLICY: '/policy',
        MITZO_OPENSHELL_SEED: '/seed',
        MITZO_OPENSHELL_SERVICE_PROVIDERS: 'github',
        MITZO_OPENSHELL_GRANTABLE_SERVICE_PROVIDERS: 'google-workspace',
      }),
    ).toMatchObject({
      serviceProviders: ['github'],
      grantableServiceProviders: ['google-workspace'],
    });
    expect(() =>
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: 'runtime:1',
        MITZO_OPENSHELL_POLICY: '/policy',
        MITZO_OPENSHELL_SEED: '/seed',
        MITZO_OPENSHELL_SERVICE_PROVIDERS: 'google-workspace',
        MITZO_OPENSHELL_GRANTABLE_SERVICE_PROVIDERS: 'google-workspace',
      }),
    ).toThrow('both automatic and grantable');
    expect(
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: 'runtime:1',
        MITZO_OPENSHELL_POLICY: '/policy',
        MITZO_OPENSHELL_SEED: '/seed',
        MITZO_OPENSHELL_CLI: '/isolated/openshell',
      }),
    ).toMatchObject({ cli: '/isolated/openshell' });
    expect(() =>
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: 'runtime:1',
        MITZO_OPENSHELL_POLICY: '/policy',
        MITZO_OPENSHELL_SEED: '/releases/current/mgmt',
      }),
    ).toThrow('STACK_MANIFEST is required');
    const dynamicStack = join(privateRoot, 'dynamic-stack.json');
    writeFileSync(
      dynamicStack,
      JSON.stringify({
        runtime: {
          image: config.image,
          mgmtSourceCommit: 'a'.repeat(40),
          dependencyProjectionSha256: 'b'.repeat(64),
          seedPayloadSha256: 'c'.repeat(64),
        },
      }),
    );
    expect(
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: config.image,
        MITZO_OPENSHELL_POLICY: '/policy',
        MITZO_OPENSHELL_SEED: '/releases/current/mgmt',
        MITZO_OPENSHELL_STACK_MANIFEST: dynamicStack,
      }),
    ).toMatchObject({ stackManifest: dynamicStack });
    writeFileSync(dynamicStack, '{}');
    expect(() =>
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: config.image,
        MITZO_OPENSHELL_POLICY: '/policy',
        MITZO_OPENSHELL_SEED: '/releases/current/mgmt',
        MITZO_OPENSHELL_STACK_MANIFEST: dynamicStack,
      }),
    ).toThrow('stack lock is malformed');
    expect(
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: 'runtime:1',
        MITZO_OPENSHELL_POLICY: '/policy',
        MITZO_OPENSHELL_SEED: '/seed',
        MITZO_OPENSHELL_CREATE_DETACHED: '0',
        MITZO_OPENSHELL_SANDBOX_ID_LENGTH: '12',
      }),
    ).toMatchObject({ createDetached: false, sandboxIdLength: 12 });
    expect(() =>
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: 'runtime:1',
        MITZO_OPENSHELL_POLICY: '/policy',
        MITZO_OPENSHELL_SEED: '/seed',
        MITZO_OPENSHELL_CLI: 'relative/openshell',
      }),
    ).toThrow('absolute');
    expect(() =>
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: 'runtime:1',
        MITZO_OPENSHELL_POLICY: 'relative',
        MITZO_OPENSHELL_SEED: '/seed',
      }),
    ).toThrow('absolute');
    expect(() =>
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: 'runtime:1',
        MITZO_OPENSHELL_POLICY: '/policy',
        MITZO_OPENSHELL_SEED: '/seed',
        MITZO_OPENSHELL_WEB_SEARCH: 'enabled',
      }),
    ).toThrow('web search');
    expect(() =>
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: 'runtime:1',
        MITZO_OPENSHELL_POLICY: '/policy',
        MITZO_OPENSHELL_SEED: '/seed',
        MITZO_OPENSHELL_SERVICE_PROVIDERS: 'openai-other-account',
      }),
    ).toThrow('allowed service provider');
    expect(() =>
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: 'runtime:1',
        MITZO_OPENSHELL_POLICY: '/policy',
        MITZO_OPENSHELL_SEED: '/seed',
        MITZO_OPENSHELL_PROVIDERS: 'openai-other-account',
      }),
    ).toThrow('ambiguous');
  });

  it('verifies the exact subscription provider and grant before creating a sandbox', async () => {
    const subscription = {
      ...config,
      createDetached: false,
      sandboxIdLength: 12,
      account: {
        kind: 'chatgpt-subscription' as const,
        provider: 'personal-chatgpt',
        providerType: 'openai-codex-oauth' as const,
        providerId: 'provider-object-1',
        grantId: 'grant-generation-1',
        model: 'gpt-test',
      },
    };
    const run = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            id: 'provider-object-1',
            name: 'personal-chatgpt',
            workspace: 'mitzo',
            type: 'openai-codex-oauth',
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          credentials: [
            {
              provider_name: 'personal-chatgpt',
              provider_id: 'provider-object-1',
              credential_key: 'OPENAI_CODEX_OAUTH_ACCESS_TOKEN',
              status: 'refreshed',
              expires_at_ms: Date.now() + 60_000,
              refresh_generation_id: 'grant-generation-1',
            },
          ],
        }),
      )
      .mockRejectedValueOnce(new Error('sandbox not found'))
      .mockRejectedValueOnce(new Error('sandbox not found'))
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(
        JSON.stringify({
          name: 'sandbox',
          phase: 'Ready',
          labels: {
            'mitzo.conversation': owner,
            'mitzo.account_provider': 'personal-chatgpt',
          },
        }),
      );
    await new OpenShellRuntimeManager(subscription, run).ensure(
      'conversation',
      new AbortController().signal,
    );
    expect(run.mock.calls[0][0]).toContain('list');
    expect(run.mock.calls[1][0]).toContain('status');
    expect(run.mock.calls[4][0]).toEqual(
      expect.arrayContaining([
        '--provider',
        'personal-chatgpt',
        '--inference-provider',
        'personal-chatgpt',
        '--inference-model',
        'gpt-test',
      ]),
    );
    expect(run.mock.calls[4][0]).not.toContain('--detach');
    expect(run.mock.calls[4][0]).toEqual(expect.arrayContaining(['--output', 'json']));
  });

  it.each([
    ['wrong provider object', { providerId: 'other' }],
    ['wrong grant generation', { grantId: 'other' }],
  ])('fails closed for %s', async (_name, override) => {
    const account = {
      kind: 'chatgpt-subscription' as const,
      provider: 'personal-chatgpt',
      providerType: 'openai-codex-oauth' as const,
      providerId: 'provider-object-1',
      grantId: 'grant-generation-1',
      model: 'gpt-test',
      ...override,
    };
    const run = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            id: 'provider-object-1',
            name: 'personal-chatgpt',
            workspace: 'mitzo',
            type: 'openai-codex-oauth',
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          credentials: [
            {
              provider_name: 'personal-chatgpt',
              provider_id: 'provider-object-1',
              credential_key: 'OPENAI_CODEX_OAUTH_ACCESS_TOKEN',
              status: 'refreshed',
              expires_at_ms: Date.now() + 60_000,
              refresh_generation_id: 'grant-generation-1',
            },
          ],
        }),
      );
    await expect(
      new OpenShellRuntimeManager({ ...config, account }, run).ensure(
        'conversation',
        new AbortController().signal,
      ),
    ).rejects.toThrow(/does not match|expired|revoked|sign-in/);
    expect(run.mock.calls.flat().flat()).not.toContain('create');
  });

  it('passes only explicitly sandboxed MCP servers and live search to Codex', () => {
    expect(
      openShellCodexRuntimeConfig(
        { webSearch: 'live' },
        {
          docs: { execution: 'sandbox', command: '/usr/bin/docs-mcp', args: ['--stdio'] },
          host: { command: '/host/private-mcp' },
        },
      ),
    ).toEqual({
      web_search: 'live',
      'mcp_servers.docs.command': '/usr/bin/docs-mcp',
      'mcp_servers.docs.args': ['--stdio'],
      'mcp_servers.docs.enabled': true,
    });
  });

  it('rejects sandbox MCP host paths, ambiguous names, and injected environments', () => {
    expect(() =>
      openShellCodexRuntimeConfig(config, {
        docs: { execution: 'sandbox', command: 'relative-mcp' },
      }),
    ).toThrow('absolute');
    expect(() =>
      openShellCodexRuntimeConfig(config, {
        'docs.private': { execution: 'sandbox', command: '/usr/bin/docs-mcp' },
      }),
    ).toThrow('name');
    expect(() =>
      openShellCodexRuntimeConfig(config, {
        docs: { execution: 'sandbox', command: '/usr/bin/docs-mcp', env: { TOKEN: 'secret' } },
      }),
    ).toThrow('providers');
  });
});

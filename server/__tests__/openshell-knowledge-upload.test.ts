import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalJsonPayload } from '../../scripts/verify-openshell-production.mjs';
import { OpenShellRuntimeManager } from '../openshell-runtime.js';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
  vi.unstubAllEnvs();
});

function publication() {
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
    chmodSync(join(seed, path), 0o644);
    files[path] = { sha256: digest(content), mode: '0644' };
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
  const ssh = vi.fn(async (args: readonly string[]) =>
    args.join(' ').includes('attest-knowledge-runtime.py')
      ? JSON.stringify(config.seedStackManifest.runtime)
      : args.join(' ').includes('else')
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
  expect(first?.knowledgeRoot).toMatch(
    /^\/sandbox\/workspaces\/knowledge\/knowledge-[a-f0-9]{64}\/mgmt$/,
  );
  expect(compile.mock.calls[0][0].workdir).toBe(first?.knowledgeRoot);
  const uploads = run.mock.calls.filter(([args]) => args.includes('upload'));
  expect(uploads).toHaveLength(1);
  expect(uploads[0][0].at(-1)).toBe('/sandbox/workspaces/knowledge');
  await manager.adoptKnowledge(conversation, runtime, AbortSignal.timeout(5000));
  expect(run.mock.calls.filter(([args]) => args.includes('upload'))).toHaveLength(1);
  expect(ssh).toHaveBeenCalledTimes(7);
  present = true;
  const resumed = new OpenShellRuntimeManager(config, run, undefined, ssh);
  vi.spyOn(resumed, 'compileContext').mockResolvedValue(await compile.mock.results[0].value);
  const reused = await resumed.adoptKnowledge(conversation, runtime, AbortSignal.timeout(5000));
  expect(reused?.knowledgeRoot).toBe(first?.knowledgeRoot);
  expect(run.mock.calls.filter(([args]) => args.includes('upload'))).toHaveLength(1);
  expect(runtime.workdir).toBe('/sandbox/workspaces/mgmt');
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

it.each([false, true])(
  'ordinary ensure uploads the selected dynamic version through phased=%s creation',
  async (phased) => {
    const config = publication();
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
        writeFileSync(join(config.seed, 'memory/example.md'), 'Later B while create is in flight');
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
    await expect(
      manager.ensure('conversation', new AbortController().signal),
    ).resolves.toMatchObject({ created: true });
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

import type { AccountBinding } from '@mitzo/protocol';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexConversationStore } from '../codex-conversation-store.js';
import type { OpenShellRuntimeConfig, OpenShellRuntimeManager } from '../openshell-runtime.js';
const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  restore: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
  initialize: vi.fn(),
  launch: vi.fn(),
  containers: new Map<string, string>(),
  candidatePolicy: {} as Record<string, unknown>,
  preparedSeed: vi.fn(),
  ensure: vi.fn(),
}));
vi.mock('../openshell-runtime.js', () => ({
  preparePublishedOpenShellSeed: (...args: unknown[]) => mocks.preparedSeed(...args),
}));
vi.mock('../openshell-runtime-migration-capacity.js', () => ({
  requireRuntimeMigrationCapacity: vi.fn(async () => ({})),
}));
vi.mock('node:child_process', () => ({
  execFile: (
    _binary: string,
    args: string[],
    _options: unknown,
    callback: (error: null, output: string) => void,
  ) => {
    let output: unknown;
    if (args[0] === 'ps') output = args[args.indexOf('--filter') + 1].split('=').pop();
    else if (args[0] === 'inspect') {
      const id = args[args.length - 1];
      output = [
        {
          Image: id,
          Config: {
            Labels: {
              'openshell.ai/sandbox-id': id,
              'openshell.ai/sandbox-name': mocks.containers.get(id),
              'openshell.ai/sandbox-workspace': 'default',
            },
          },
        },
      ];
    } else
      output = [
        {
          Digest:
            args[2] === 'old-id'
              ? `sha256:${'b89016abe4c17850ee31e2c4613697f6a4871356953952b0edcdb4fdfb8db624'}`
              : `sha256:${'a'.repeat(64)}`,
        },
      ];
    callback(null, typeof output === 'string' ? output : JSON.stringify(output));
  },
}));
vi.mock('../openshell-checkpoint-transport.js', () => ({
  OpenShellCheckpointTransport: class {
    constructor(readonly runtime: unknown) {}
    capture(...args: unknown[]) {
      return mocks.capture(this.runtime, ...args);
    }
    restore(...args: unknown[]) {
      return mocks.restore(this.runtime, ...args);
    }
  },
}));
vi.mock('../codex-app-server-client.js', () => ({
  CodexAppServerClient: {
    launchOpenShell: (...args: unknown[]) => {
      mocks.launch(...args);
      return { initialize: mocks.initialize, request: mocks.request, close: mocks.close };
    },
  },
}));
import { requireRuntimeMigrationCapacity } from '../openshell-runtime-migration-capacity.js';
import { runtimePolicyHash } from '../openshell-runtime-policy.js';
import { prepareRetainedRuntimeMigration } from '../openshell-runtime-migration-adapter.js';
const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.clearAllMocks();
  mocks.containers.clear();
  mocks.candidatePolicy = {};
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'migration-adapter-'));
  roots.push(root);
  const store = new CodexConversationStore(join(root, 'state.db'));
  const binding: AccountBinding = {
    accountLabel: 'Offline fixture',
    accountId: 'account',
    provider: 'codex',
    model: 'offline',
    profileRevision: 'v1',
  };
  store.create('chat', binding, root);
  store.bindThread('chat', binding, 'same-thread');
  const source = {
    runtime: {
      sandboxName: 'old',
      sandboxId: 'old-id',
      resourceVersion: 'r1',
      workdir: '/sandbox/workspaces/mgmt',
      appServerCommand: '/sandbox/run-mitzo-app-server' as const,
      cli: 'openshell',
      workspace: 'default',
      gateway: 'g',
      gatewayInsecure: false,
    },
    route: { kind: 'api' as const, provider: 'bound-provider', model: 'offline' },
  };
  store.setArtifactRuntime('chat', binding, source);
  mocks.containers.set('old-id', 'old');
  const policy = join(root, 'policy.yaml');
  writeFileSync(policy, '{}');
  const config = {
    policy,
    seedStackManifest: {
      runtime: { knowledgeSchemaVersion: 1, digest: `sha256:${'a'.repeat(64)}` },
    },
  } as unknown as OpenShellRuntimeConfig;
  const manager = {
    forSandbox: (name: string) => ({
      observeContract: async () => ({
        policy: name === 'old' ? {} : mocks.candidatePolicy,
        attestation: {
          basePolicy: name === 'old' ? {} : mocks.candidatePolicy,
          effectivePolicyHash: runtimePolicyHash(name === 'old' ? {} : mocks.candidatePolicy),
          providers: [],
        },
        approvedGrantableProviders: [],
        resourceVersion: 'r1',
      }),
      ensure: async (...args: unknown[]) => {
        mocks.ensure(...args);
        mocks.containers.set('new-id', name);
        return { ...source.runtime, sandboxName: name, sandboxId: 'new-id', resourceVersion: 'r2' };
      },
      verifyKnowledgeRuntime: vi.fn(async () => {}),
    }),
  } as unknown as OpenShellRuntimeManager;
  mocks.capture.mockImplementation(async (_runtime, directory: string) => {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'archive.tar');
    writeFileSync(path, 'payload');
    return { path, digest: 'content-only' };
  });
  mocks.preparedSeed.mockImplementation(async (_config, _signal, beforeFreeze) => {
    await beforeFreeze?.(join(root, 'selected-large'));
    return { seed: join(root, 'frozen-selected'), cleanup: vi.fn() };
  });
  mocks.restore.mockResolvedValue(undefined);
  mocks.initialize.mockResolvedValue(undefined);
  mocks.request.mockResolvedValue({
    thread: { id: 'same-thread' },
    model: 'offline',
    modelProvider: 'openshell',
  });
  return {
    store,
    source,
    binding,
    input: {
      conversationId: 'chat',
      binding,
      store,
      source,
      config,
      manager,
      privateDirectory: root,
      signal: new AbortController().signal,
    },
  };
}
it('compares original contents before native same-thread resume, then proves closed target writer barrier before commit', async () => {
  const f = fixture();
  await prepareRetainedRuntimeMigration(f.input);
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
    'thread/resume',
    expect.objectContaining({
      threadId: 'same-thread',
      model: 'offline',
      modelProvider: 'openshell',
      allowProviderModelFallback: false,
    }),
  );
  expect(mocks.capture).toHaveBeenCalledTimes(3);
  expect(mocks.capture.mock.invocationCallOrder[1]).toBeLessThan(
    mocks.launch.mock.invocationCallOrder[0],
  );
  expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.capture.mock.invocationCallOrder[2],
  );
  expect(f.store.readRuntimeMigration('chat', f.binding)?.phase).toBe('committed');
  expect(mocks.restore.mock.calls[0][2]).toMatchObject({
    sandboxId: 'old-id',
    thread: 'same-thread',
  });
  expect(mocks.capture.mock.calls[1][2]).toMatchObject({
    sandboxId: 'new-id',
    resourceVersion: 'r2',
  });
});
it.each(['failure', 'cancellation'])(
  'closes validation transport and retains original mapping on native resume %s',
  async (kind) => {
    const f = fixture();
    mocks.request.mockRejectedValueOnce(
      Object.assign(new Error('validation failed'), {
        name: kind === 'cancellation' ? 'AbortError' : 'Error',
      }),
    );
    await expect(prepareRetainedRuntimeMigration(f.input)).rejects.toThrow('validation failed');
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledTimes(3);
    expect(f.store.readArtifactRuntime('chat', f.binding)).toEqual(f.source);
    expect(f.store.readRuntimeMigration('chat', f.binding)).toMatchObject({
      phase: 'blocked',
      retryable: kind === 'cancellation',
    });
  },
);
it('blocks content mismatch before launching any native validation client', async () => {
  const f = fixture();
  mocks.capture
    .mockResolvedValueOnce({ path: '/origin', digest: 'original' })
    .mockResolvedValueOnce({ path: '/candidate', digest: 'different' });
  await expect(prepareRetainedRuntimeMigration(f.input)).rejects.toThrow('state differs');
  expect(mocks.launch).not.toHaveBeenCalled();
  expect(f.store.readArtifactRuntime('chat', f.binding)).toEqual(f.source);
});

it.each(['thread', 'model', 'provider'])(
  'rejects native %s drift without switching ownership',
  async (field) => {
    const f = fixture();
    mocks.request.mockResolvedValueOnce({
      thread: { id: field === 'thread' ? 'wrong-thread' : 'same-thread' },
      model: field === 'model' ? 'wrong-model' : 'offline',
      modelProvider: field === 'provider' ? 'wrong-provider' : 'openshell',
    });
    await expect(prepareRetainedRuntimeMigration(f.input)).rejects.toThrow(
      'thread or model changed',
    );
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(f.store.readArtifactRuntime('chat', f.binding)).toEqual(f.source);
  },
);
it('blocks a still-running validation writer after close rather than switching ownership', async () => {
  const f = fixture();
  mocks.capture
    .mockResolvedValueOnce({ path: '/origin', digest: 'content-only' })
    .mockResolvedValueOnce({ path: '/candidate', digest: 'content-only' })
    .mockRejectedValue(new Error('unknown provider state after close'));
  await expect(prepareRetainedRuntimeMigration(f.input)).rejects.toThrow('unknown provider state');
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(f.store.readArtifactRuntime('chat', f.binding)).toEqual(f.source);
});

it('rejects a candidate whose actual policy differs despite matching desired policy and image', async () => {
  const f = fixture();
  mocks.candidatePolicy = { filesystem: { write: ['/'] } };
  await expect(prepareRetainedRuntimeMigration(f.input)).rejects.toThrow('actual policy differs');
  expect(mocks.restore).not.toHaveBeenCalled();
  expect(mocks.launch).not.toHaveBeenCalled();
  expect(f.store.readArtifactRuntime('chat', f.binding)).toEqual(f.source);
});

it('capacity checks the publisher selection before freezing and ensure uses that exact snapshot', async () => {
  const f = fixture();
  f.input.config.seed = '/stale-small';
  await prepareRetainedRuntimeMigration(f.input);
  expect(requireRuntimeMigrationCapacity).toHaveBeenCalledWith(
    expect.objectContaining({ seedDirectory: expect.stringContaining('selected-large') }),
    expect.any(Function),
  );
  expect(mocks.ensure).toHaveBeenCalledWith(
    'chat',
    f.input.signal,
    undefined,
    expect.objectContaining({ seed: expect.stringContaining('frozen-selected') }),
    [],
  );
});

it.each(['success', 'failure', 'retry'] as const)(
  'retains only the immutable checkpoint after disposable probes: %s',
  async (kind) => {
    const f = fixture();
    if (kind !== 'success')
      mocks.request.mockRejectedValueOnce(
        Object.assign(new Error('validation timed out'), { name: 'TimeoutError' }),
      );
    if (kind === 'success') await prepareRetainedRuntimeMigration(f.input);
    else {
      await expect(prepareRetainedRuntimeMigration(f.input)).rejects.toThrow('timed out');
      if (kind === 'retry') {
        const record = f.store.readRuntimeMigration('chat', f.binding)!;
        f.store.advanceRuntimeMigration('chat', f.binding, record.generation, {
          retryNotBefore: 0,
        });
        await prepareRetainedRuntimeMigration(f.input);
      }
    }
    const record = f.store.readRuntimeMigration('chat', f.binding)!;
    expect(existsSync(record.checkpoint!.path)).toBe(true);
    const root = join(f.input.privateDirectory, 'runtime-migrations');
    const conversationRoot = join(root, readdirSync(root)[0]);
    expect(readdirSync(conversationRoot)).toHaveLength(1);
  },
);

import { OrdinaryRepositoryPreparationSchema } from '../ordinary-repository-preparation.js';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { SessionRegistry, type ManagedSession } from '@mitzo/harness';
import { EventStore } from '@mitzo/protocol/event-store';
import type { AccountBinding } from '@mitzo/protocol';
const repositorySeeds = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../repository-workspace-runtime.js', () => ({
  getRepositoryWorkspaces: () => ({ startupSeed: repositorySeeds.verify }),
}));
const native = vi.hoisted(() => ({ cli: vi.fn(), ssh: vi.fn(), launch: vi.fn() }));
// Native CLI, reviewed public contract observation and RPC boundaries are substituted.
// The startup fixture uses a legacy unprepared seed; policy correctness is covered
// by the real runtime/attestation suites. Conversation, send,
// queue, lifecycle coordinator, artifact mapping and lifecycle records are real.
vi.mock('../openshell-runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../openshell-runtime.js')>();
  return {
    ...actual,
    OpenShellRuntimeManager: class OfflineRuntimeManager extends actual.OpenShellRuntimeManager {
      constructor(
        private fixtureConfig: import('../openshell-runtime.js').BoundOpenShellRuntimeConfig,
      ) {
        super(fixtureConfig, native.cli, undefined, native.ssh);
      }
      override forSandbox(name: string) {
        return new OfflineRuntimeManager({ ...this.fixtureConfig, sandboxNameOverride: name });
      }
      override async verifyKnowledgeRuntime(
        runtime: import('../openshell-runtime.js').OpenShellRuntime,
        signal: AbortSignal,
      ) {
        // This fixture substitutes the immutable image/compiler attestation only;
        // real runtime suites qualify those pins. Preserve physical identity here.
        signal.throwIfAborted();
        const sandbox = sandboxes.get(runtime.sandboxName);
        if (!sandbox || sandbox.id !== runtime.sandboxId || sandbox.phase !== 'Ready')
          throw Error('Offline knowledge runtime identity changed');
        return {};
      }
      override async observeContract(
        conversationId: string,
        runtime: import('../openshell-runtime.js').OpenShellRuntime,
        signal: AbortSignal,
      ) {
        signal.throwIfAborted();
        const sandbox = sandboxes.get(runtime.sandboxName);
        if (
          !sandbox ||
          sandbox.id !== runtime.sandboxId ||
          sandbox.phase !== 'Ready' ||
          (sandbox.labels as Record<string, string>)['mitzo.conversation'] !==
            createHash('sha256').update(conversationId).digest('hex').slice(0, 63) ||
          sandbox.workspace !== runtime.workspace ||
          (sandbox.labels as Record<string, string>)['mitzo.account_provider'] !==
            'offline-provider'
        )
          throw new Error('Offline runtime observation identity changed');
        // Construct a real attestation from immutable reviewed public profile bytes,
        // never credentials. This receipt remains bound to this fixture's sandbox.
        const profile: Record<string, unknown> = {
          ...(reviewedRuntimeProfile('mitzo-openai-keychain-spike') as Record<string, unknown>),
          source: 'user',
          scope: 'workspace',
          resource_version: 2,
        };
        const base = { network_policies: {} };
        const policy = {
          network_policies: {
            _provider_offline_provider: {
              name: '_provider_offline_provider',
              endpoints: profile.endpoints,
              binaries: (profile.binaries as string[]).map((path) => ({ path })),
            },
          },
        };
        const providers = [
          {
            name: 'offline-provider',
            id: 'offline-provider-id',
            type: 'mitzo-openai-keychain-spike',
            profile,
          },
        ];
        const attestation = attestEffectiveRuntimePolicy(base, policy, providers);
        return {
          resourceVersion: String(sandbox.resource_version),
          policy,
          attestation,
          approvedGrantableProviders: [],
          requiredServiceEnvironment: verifiedRuntimeServiceEnvironment(
            base,
            policy,
            providers,
            'offline-provider',
          ),
        };
      }
    },
  };
});
vi.mock('../codex-app-server-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../codex-app-server-client.js')>()),
  CodexAppServerClient: { launchOpenShell: (...args: unknown[]) => native.launch(...args) },
}));
import {
  getCodexConversationStore,
  getCodexRuntime,
  openCodexChat,
} from '../codex-chat-session.js';
import { OpenShellRuntimeManager, openShellRuntimeConfig } from '../openshell-runtime.js';
import {
  attestEffectiveRuntimePolicy,
  reviewedRuntimeProfile,
  verifiedRuntimeServiceEnvironment,
} from '../openshell-runtime-policy.js';
import { initializeOpenShellLifecycle } from '../openshell-lifecycle-controller.js';
import { sharedOpenShellLifecycleCoordinator } from '../openshell-lifecycle.js';
import { loadAccountProfiles } from '../account-profiles.js';
import { TaskStore } from '../task-store.js';

const root = mkdtempSync(join(tmpdir(), 'chat-startup-fence-'));
let lifecycle: ReturnType<typeof initializeOpenShellLifecycle>;
let eventStore: EventStore;
let taskStore: TaskStore;
const registry = new SessionRegistry();
const sandboxes = new Map<string, Record<string, unknown>>();
const releases = new Map<string, () => void>();
const releaseCounts = new Map<string, number>();
const releaseSnapshots = new Map<string, { thread: string | undefined; artifact: boolean }>();
const realReserve = sharedOpenShellLifecycleCoordinator.reserve.bind(
  sharedOpenShellLifecycleCoordinator,
);
let binding: AccountBinding = {
  accountId: 'offline',
  accountLabel: 'Offline fixture',
  provider: 'openai',
  model: 'offline-model',
  profileRevision: 'v1',
};
beforeAll(() => {
  mkdirSync(join(root, 'seed'));
  writeFileSync(join(root, 'policy.yaml'), '{}');
  writeFileSync(
    join(root, 'accounts.json'),
    JSON.stringify([
      {
        id: 'offline',
        label: 'Offline fixture',
        provider: 'openai',
        credentialRef: { provider: 'fixture', service: 'offline', account: 'offline' },
        sandboxProvider: 'offline-provider',
        sandboxProviderId: 'offline-provider-id',
        models: [{ id: 'offline-model', label: 'Offline native RPC fixture' }],
      },
    ]),
  );
  vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', join(root, 'accounts.json'));
  binding = loadAccountProfiles().resolve('offline', 'offline-model');
  for (const [key, value] of Object.entries({
    MITZO_CODEX_PRIVATE_DIR: join(root, 'private'),
    REPO_PATH: root,
    MITZO_OPENSHELL_ENABLED: '1',
    MITZO_OPENSHELL_IMAGE: 'fixture:runtime',
    MITZO_OPENSHELL_POLICY: join(root, 'policy.yaml'),
    MITZO_OPENSHELL_SEED: join(root, 'seed'),
    MITZO_OPENSHELL_SERVICE_PROVIDERS: '',
    MITZO_OPENSHELL_GRANTABLE_SERVICE_PROVIDERS: '',
    MITZO_OPENSHELL_WEB_SEARCH: 'disabled',
    MITZO_OPENSHELL_LIFECYCLE_ENABLED: '1',
  }))
    vi.stubEnv(key, value);
  native.cli.mockImplementation(async (args: readonly string[]) => {
    if (args[0] === 'provider')
      return JSON.stringify({
        providers: [{ name: 'offline-provider', type: 'openai' }],
        next_page_token: '',
      });
    if (args.includes('create')) {
      const name = args[args.indexOf('--name') + 1];
      const labels = Object.fromEntries(
        args.flatMap((value, i) => (args[i - 1] === '--label' ? [value.split('=')] : [])),
      );
      sandboxes.set(name, {
        name,
        id: 'physical-' + name,
        resource_version: '1',
        workspace: 'default',
        phase: 'Ready',
        labels,
      });
      return JSON.stringify(sandboxes.get(name));
    }
    if (args.includes('get')) {
      const value = sandboxes.get(args[args.indexOf('get') + 1]);
      if (!value) throw new Error('sandbox not found');
      return JSON.stringify(value);
    }
    if (args.includes('provider'))
      return 'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\noffline-provider openai 1 0';
    return '{}';
  });
  native.ssh.mockResolvedValue(
    JSON.stringify({
      type: 'boot_context',
      scope: 'sandbox',
      sourceCount: 0,
      tokenCount: 0,
      tokenBudget: 12000,
      sources: [],
      included: [],
      trimmed: [],
      fullMarkdown: '',
    }),
  );
  eventStore = new EventStore(join(root, 'events.db'));
  taskStore = new TaskStore(join(root, 'tasks.db'));
  lifecycle = initializeOpenShellLifecycle(openShellRuntimeConfig(process.env), {
    registry,
    eventStore,
    taskStore,
    queue: (record) => getCodexConversationStore().lifecycleQueue(record.conversationId, binding),
    accountProviders: () => ['offline-provider'],
  });
  vi.spyOn(sharedOpenShellLifecycleCoordinator, 'reserve').mockImplementation(async (id) => {
    const release = await realReserve(id);
    let released = false;
    const wrapped = () => {
      if (!released) {
        released = true;
        releaseCounts.set(id, (releaseCounts.get(id) ?? 0) + 1);
        if (!releaseSnapshots.has(id)) {
          let artifact = false;
          try {
            artifact = !!getCodexConversationStore().readArtifactRuntime(id, binding);
          } catch {
            /* initialization failed before ledger creation */
          }
          releaseSnapshots.set(id, {
            thread: lifecycle?.store.get(id)?.identity?.threadId,
            artifact,
          });
        }
      }
      release();
    };
    if (!releases.has(id)) releases.set(id, wrapped);
    return wrapped;
  });
});
afterEach(() => {
  native.launch.mockReset();
});
afterAll(() => {
  vi.restoreAllMocks();
  registry.dispose();
  lifecycle?.store.close();
  getCodexConversationStore().close();
  eventStore.close();
  taskStore.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function fixture(
  mode: 'normal' | 'initialize-error' | 'initialize-abort' | 'send-error' = 'normal',
) {
  const id = 'startup-' + randomUUID();
  const abort = new AbortController();
  const requests: string[] = [];
  let initializeGate: Promise<void> | undefined;
  let closed = 0;
  native.launch.mockImplementation(() => ({
    initialize: async () => {
      await initializeGate;
      if (mode === 'initialize-error') throw new Error('native initialization failed');
      if (mode === 'initialize-abort') abort.abort();
    },
    close: () => {
      closed++;
    },
    request: async (method: string) => {
      requests.push(method);
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/start' || method === 'thread/resume')
        return {
          thread: { id: 'thread-' + id },
          model: 'offline-model',
          modelProvider: 'openshell',
        };
      if (method === 'turn/start') {
        if (mode === 'send-error') throw new Error('native turn admission failed');
        return { turn: { id: 'turn-' + id } };
      }
      return {};
    },
  }));
  const session = { cwd: root, abortController: abort, mode: 'agent' } as ManagedSession;
  registry.register(id, {
    transport: { isOpen: () => true, send: () => {} },
    abortController: abort,
    sessionId: id,
    cwd: root,
    mode: 'agent',
    sessionAllowList: new Set(),
    accountBinding: binding,
  });
  const options: Parameters<typeof openCodexChat>[0] = {
    conversationId: id,
    binding,
    profile: {
      accountId: 'offline',
      accountLabel: 'Offline fixture',
      credentialRef: '/sandbox/.codex',
      email: 'offline@example.invalid',
      planType: 'api',
      sandboxProvider: 'offline-provider',
      model: 'offline-model',
    },
    session,
    registry,
    prompt: 'offline prompt',
    model: 'offline-model',
    messageId: 'message-' + id,
    systemPrompt: 'offline context',
    env: {},
    mcpServers: {},
    eventStore,
  };
  return {
    id,
    abort,
    options,
    requests,
    closed: () => closed,
    holdInitialize: () => {
      let resume!: () => void;
      initializeGate = new Promise<void>((resolve) => (resume = resolve));
      return resume;
    },
  };
}
it('finishes a resumed chat after a provisioning failure before any provider initialization', async () => {
  const f = fixture();
  const ensure = vi.spyOn(OpenShellRuntimeManager.prototype, 'ensure');
  ensure.mockRejectedValueOnce(new Error('transient provisioning failure'));
  try {
    await expect(openCodexChat(f.options)).rejects.toThrow('transient provisioning failure');
    expect(native.launch).not.toHaveBeenCalled();
    const query = await openCodexChat({ ...f.options, resume: true, messageId: 'retry-' + f.id });
    expect(f.requests.filter((method) => method === 'thread/start')).toHaveLength(1);
    expect(f.requests.filter((method) => method === 'turn/start')).toHaveLength(1);
    expect(getCodexConversationStore().read(f.id, binding).threadId).toBe('thread-' + f.id);
    query.close();
  } finally {
    ensure.mockRestore();
  }
});

it('rechecks startup phase after waiting behind an initialization with no acknowledgment', async () => {
  const f = fixture('initialize-error');
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = OpenShellRuntimeManager.prototype.ensure;
  const ensure = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'ensure')
    .mockImplementationOnce(async function (this: OpenShellRuntimeManager, ...args) {
      entered();
      await gate;
      return original.apply(this, args);
    });
  const first = openCodexChat(f.options);
  void first.catch(() => {});
  await entry;
  const second = openCodexChat({ ...f.options, resume: true });
  void second.catch(() => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  try {
    await expect(first).rejects.toThrow('native initialization failed');
    await expect(second).rejects.toThrow(/unverified/);
    expect(native.launch).toHaveBeenCalledTimes(1);
  } finally {
    release();
    ensure.mockRestore();
  }
});

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('startup admission deadlock')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
it('retains setup fence through thread/artifact registration, then real initial send acquires both admission fences', async () => {
  const f = fixture();
  const resume = f.holdInitialize();
  const opening = openCodexChat(f.options);
  void opening.catch(() => {});
  let competingAdmission = false;
  let competing: Promise<void> | undefined;
  let chat: Awaited<ReturnType<typeof openCodexChat>> | undefined;
  try {
    await vi.waitFor(() => expect(native.launch).toHaveBeenCalled());
    competing = sharedOpenShellLifecycleCoordinator.admit(f.id, async () => {
      competingAdmission = true;
    });
    await Promise.resolve();
    expect(competingAdmission).toBe(false);
    resume();
    chat = await bounded(opening);
    await competing;
    expect(competingAdmission).toBe(true);
    expect(releaseSnapshots.get(f.id)).toEqual({ thread: undefined, artifact: true });
    expect(f.requests.filter((method) => method === 'turn/start')).toHaveLength(1);
    expect(releaseCounts.get(f.id)).toBe(4); // startup, competing, migration admission, system context
    expect(getCodexConversationStore().commands(f.id, binding)).toMatchObject([
      { id: f.options.messageId, status: 'running' },
    ]);
  } finally {
    resume();
    releases.get(f.id)?.();
    chat ??= await opening.catch(() => undefined);
    chat?.close();
    await sharedOpenShellLifecycleCoordinator.admit(f.id, async () => {});
  }
});
it.each(['initialize-error', 'initialize-abort', 'send-error'] as const)(
  'releases startup fence and closes native transport after %s',
  async (mode) => {
    const f = fixture(mode);
    const opening = openCodexChat(f.options);
    void opening.catch(() => {});
    try {
      await expect(bounded(opening)).rejects.toThrow(
        mode === 'initialize-abort'
          ? /abort/i
          : mode === 'initialize-error'
            ? 'native initialization failed'
            : 'native turn admission failed',
      );
      await bounded(sharedOpenShellLifecycleCoordinator.admit(f.id, async () => {}));
      expect(f.closed()).toBeGreaterThan(0);
      if (mode === 'send-error')
        expect(getCodexConversationStore().commands(f.id, binding)).toMatchObject([
          { id: f.options.messageId, status: 'failed' },
        ]);
      else expect(f.requests).not.toContain('turn/start');
      if (mode === 'initialize-error') {
        await expect(openCodexChat({ ...f.options, resume: true })).rejects.toThrow(/unverified/);
        expect(native.launch).toHaveBeenCalledTimes(1);
      }
    } finally {
      releases.get(f.id)?.();
      await opening.catch(() => {});
      await sharedOpenShellLifecycleCoordinator.admit(f.id, async () => {});
    }
  },
);
it('reattach-only leaves reserved provisioning available for the next explicit send', async () => {
  const f = fixture();
  let chat: Awaited<ReturnType<typeof openCodexChat>> | undefined;
  try {
    chat = await bounded(openCodexChat({ ...f.options, reattachOnly: true }));
    expect(native.launch).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
    expect(getCodexConversationStore().commands(f.id, binding)).toEqual([]);
    expect(releaseSnapshots.get(f.id)).toEqual({ thread: undefined, artifact: false });
    expect(releaseCounts.get(f.id)).toBe(1);
    chat.close();
    chat = await openCodexChat({ ...f.options, resume: true });
    expect(f.requests.filter((method) => method === 'thread/start')).toHaveLength(1);
    expect(f.requests.filter((method) => method === 'turn/start')).toHaveLength(1);
  } finally {
    chat?.close();
    await sharedOpenShellLifecycleCoordinator.admit(f.id, async () => {});
  }
});

it('uploads the controller-selected repository seed and avoids the MGMT task compiler for a repository chat', async () => {
  const f = fixture();
  const repositoryWorkspace = {
    id: 'source-fixture',
    repository: 'example/repo',
    baseBranch: 'main',
    baseOid: 'a'.repeat(40),
    featureBranch: 'mitzo/task',
    seed: join(root, 'repository-seed', 'mgmt'),
  };
  mkdirSync(repositoryWorkspace.seed, { recursive: true });
  repositorySeeds.verify.mockResolvedValue(repositoryWorkspace.seed);
  const compile = vi.spyOn(OpenShellRuntimeManager.prototype, 'compileContext');
  let chat: Awaited<ReturnType<typeof openCodexChat>> | undefined;
  try {
    chat = await openCodexChat({ ...f.options, repositoryWorkspace });
    expect(
      native.cli.mock.calls.some(
        ([args]) =>
          args.includes('--upload') &&
          args.includes(repositoryWorkspace.seed + ':/sandbox/workspaces'),
      ),
    ).toBe(true);
    expect(compile).not.toHaveBeenCalled();
    expect(f.requests.filter((method) => method === 'turn/start')).toHaveLength(1);
  } finally {
    compile.mockRestore();
    chat?.close();
    await sharedOpenShellLifecycleCoordinator.admit(f.id, async () => {});
  }
});

it.each(['missing', 'replaced'] as const)(
  'refuses repository reconnect when its retained sandbox is %s',
  async (condition) => {
    const f = fixture();
    const repositoryWorkspace = {
      id: 'source-fixture',
      repository: 'example/repo',
      baseBranch: 'main',
      baseOid: 'a'.repeat(40),
      featureBranch: 'mitzo/task',
      seed: join(root, 'repository-seed', 'mgmt'),
    };
    mkdirSync(repositoryWorkspace.seed, { recursive: true });
    repositorySeeds.verify.mockResolvedValue(repositoryWorkspace.seed);
    let chat: Awaited<ReturnType<typeof openCodexChat>> | undefined;
    try {
      chat = await openCodexChat({ ...f.options, repositoryWorkspace });
      const runtime = getCodexRuntime(f.options.session)!;
      const callbacks = native.launch.mock.calls[0][2];
      const artifact = getCodexConversationStore().readArtifactRuntime(f.id, binding)!;
      const name = artifact.runtime.sandboxName;
      if (condition === 'missing') sandboxes.delete(name);
      else sandboxes.set(name, { ...sandboxes.get(name), id: 'replacement-physical-id' });
      const creates = native.cli.mock.calls.filter(([args]) => args.includes('create')).length;
      callbacks.onClose(new Error('offline transport lost'));
      await expect(
        runtime.send({ id: 'follow-up-' + f.id, prompt: 'continue edits' }),
      ).rejects.toThrow('physical identity changed');
      expect(native.cli.mock.calls.filter(([args]) => args.includes('create'))).toHaveLength(
        creates,
      );
      expect(native.launch).toHaveBeenCalledOnce();
      expect(f.requests.filter((method) => method === 'thread/start')).toHaveLength(1);
      expect(f.requests.filter((method) => method === 'turn/start')).toHaveLength(1);
    } finally {
      chat?.close();
      await sharedOpenShellLifecycleCoordinator.admit(f.id, async () => {});
    }
  },
);

it('overlaps the read-only task inventory with knowledge adoption inside the same lifecycle fence', async () => {
  const f = fixture();
  let startKnowledge!: () => void;
  let finishKnowledge!: () => void;
  let finishInventory!: () => void;
  const knowledgeStarted = new Promise<void>((resolve) => (startKnowledge = resolve));
  const knowledgeGate = new Promise<void>((resolve) => (finishKnowledge = resolve));
  const inventoryGate = new Promise<void>((resolve) => (finishInventory = resolve));
  const adopt = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'adoptKnowledge')
    .mockImplementation(async (_conversation, _runtime, signal) => {
      startKnowledge();
      await knowledgeGate;
      signal.throwIfAborted();
      return undefined;
    });
  const inventory = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'inspectTaskCapabilities')
    .mockImplementation(async (_runtime, signal) => {
      await inventoryGate;
      signal.throwIfAborted();
      return { mgmtCli: true, meetingPrep: false, gws: false };
    });
  let chat: Awaited<ReturnType<typeof openCodexChat>> | undefined;
  let competitorEntered = false;
  const opening = openCodexChat(f.options);
  void opening.catch(() => {});
  let competing: Promise<void> | undefined;
  try {
    await bounded(knowledgeStarted);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(inventory).toHaveBeenCalledOnce();
    expect(f.requests).not.toContain('turn/start');
    competing = sharedOpenShellLifecycleCoordinator.admit(f.id, async () => {
      competitorEntered = true;
    });
    finishKnowledge();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(competitorEntered).toBe(false);
    expect(f.requests).not.toContain('turn/start');
    finishInventory();
    chat = await bounded(opening);
    await competing;
    expect(competitorEntered).toBe(true);
    expect(f.requests.filter((method) => method === 'turn/start')).toHaveLength(1);
  } finally {
    finishKnowledge();
    finishInventory();
    chat ??= await opening.catch(() => undefined);
    chat?.close();
    await competing;
    await sharedOpenShellLifecycleCoordinator.admit(f.id, async () => {});
    adopt.mockRestore();
    inventory.mockRestore();
  }
});

it.each(['knowledge', 'inventory'] as const)(
  'holds lifecycle ownership until both preparations settle after %s failure',
  async (failed) => {
    const f = fixture();
    let knowledgeStarted!: () => void;
    let inventoryStarted!: () => void;
    let finishKnowledge!: () => void;
    let finishInventory!: () => void;
    const knowledgeEntry = new Promise<void>((resolve) => (knowledgeStarted = resolve));
    const inventoryEntry = new Promise<void>((resolve) => (inventoryStarted = resolve));
    const knowledgeGate = new Promise<void>((resolve) => (finishKnowledge = resolve));
    const inventoryGate = new Promise<void>((resolve) => (finishInventory = resolve));
    const failure = new Error(`${failed} preparation failed`);
    const adopt = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'adoptKnowledge')
      .mockImplementation(async () => {
        knowledgeStarted();
        await knowledgeGate;
        if (failed === 'knowledge') throw failure;
        return undefined;
      });
    const inventory = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'inspectTaskCapabilities')
      .mockImplementation(async () => {
        inventoryStarted();
        await inventoryGate;
        if (failed === 'inventory') throw failure;
        return undefined;
      });
    let settled = false;
    let competitorEntered = false;
    const opening = openCodexChat(f.options);
    void opening.then(
      () => (settled = true),
      () => (settled = true),
    );
    let competing: Promise<void> | undefined;
    try {
      await bounded(Promise.all([knowledgeEntry, inventoryEntry]));
      competing = sharedOpenShellLifecycleCoordinator.admit(f.id, async () => {
        competitorEntered = true;
      });
      (failed === 'knowledge' ? finishKnowledge : finishInventory)();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(competitorEntered).toBe(false);
      expect(f.requests).not.toContain('turn/start');
      (failed === 'knowledge' ? finishInventory : finishKnowledge)();
      await expect(bounded(opening)).rejects.toThrow(failure.message);
      await competing;
      expect(competitorEntered).toBe(true);
      expect(f.requests).not.toContain('turn/start');
      expect(getCodexConversationStore().commands(f.id, binding)).toMatchObject([
        { id: f.options.messageId, status: 'failed' },
      ]);
    } finally {
      finishKnowledge();
      finishInventory();
      (await opening.catch(() => undefined))?.close();
      await competing;
      await sharedOpenShellLifecycleCoordinator.admit(f.id, async () => {});
      adopt.mockRestore();
      inventory.mockRestore();
    }
  },
);

it.each([false, true])(
  'starts the ordinary OpenShell default through its real native queue and MGMT seed (real credential gate: %s)',
  async (realCredentialGate) => {
    const f = fixture();
    const taskRoot = realpathSync(root);
    const { RepositoryWorkspaces } = await import('../repository-workspaces.js');
    const { OrdinaryOpenShellCodexOwnedRuntime } =
      await import('../ordinary-openshell-codex-owned-runtime.js');
    const { ordinaryOpenShellCodexTarget, projectOrdinaryOpenShellCodexCapabilities } =
      await import('../ordinary-openshell-codex-route.js');
    const { readBuiltinAgentLibraryProfile } = await import('../agent-library-transport.js');
    const { assertOrdinaryOpenShellPhysicalOwner } =
      await import('../openshell-lifecycle-controller.js');
    const config = openShellRuntimeConfig(process.env)!;
    const profiles = loadAccountProfiles();
    const target = ordinaryOpenShellCodexTarget({
      targetId: 'default-shell',
      runtimeContractRevision: 'offline-reviewed-runtime',
      config,
      openaiApi: 'enabled',
    });
    const projection = projectOrdinaryOpenShellCodexCapabilities({
      profiles,
      target,
      deployment: 'ordinary',
    });
    const { resolveOrdinarySessionRuntime } = await import('../ordinary-session-runtime.js');
    const resolved = resolveOrdinarySessionRuntime(
      {
        account: {
          accountId: binding.accountId,
          provider: binding.provider,
          profileRevision: binding.profileRevision,
        },
        harness: 'codex',
        targetId: target.targetId,
        mode: 'agent',
      },
      projection.catalog,
    );
    expect(resolved.status).toBe('compatible');
    if (resolved.status !== 'compatible') throw Error('Offline target unavailable');
    const runtimeBinding = resolved.binding;
    const agentProfile = readBuiltinAgentLibraryProfile({
      kind: 'builtin',
      profileId: 'default-mitzo',
      revision: 1,
    })!;
    const selection = {
      version: 1 as const,
      agent: { kind: 'builtin' as const, profileId: 'default-mitzo', revision: 1 },
      context: { source: 'none' as const, revision: null },
      permission: { mode: 'agent' as const, revision: 0 as const },
      model: binding.model,
      thinking: null,
    };
    const forbiddenRepository = vi.fn(async () => {
      throw Error('Repository preparation is forbidden for the default');
    });
    const workspaces = new RepositoryWorkspaces(
      join(taskRoot, 'ordinary-default-' + randomUUID()),
      {
        authorize: forbiddenRepository,
        inspect: forbiddenRepository,
        prepare: forbiddenRepository,
        ordinaryPreparation: {
          capture: async () =>
            OrdinaryRepositoryPreparationSchema.parse({
              version: 1,
              originalBinding: binding,
              runtimeBinding,
              credentialDigest: 'a'.repeat(64),
              sandboxWorkdir: config.workdir,
            }),
          assert: async () => {},
        },
      },
    );
    const prepared = await workspaces.prepareOrdinaryWorkspace({
      binding,
      selection: {
        runOn: 'openshell',
        runtime: { account: runtimeBinding.account, harness: 'codex', targetId: target.targetId },
      },
      signal: f.abort.signal,
    });
    const reserved = await workspaces.reserveOrdinaryWorkspace({
      preparationId: prepared.preparationId,
      allocationOperationId: randomUUID(),
      binding,
      taskRoot,
      agentProfile,
      settings: {
        version: 2,
        binding: runtimeBinding,
        selection,
        workspace: { kind: 'ordinary', preparationId: prepared.preparationId },
      },
      signal: f.abort.signal,
    });
    const meta = {
      sessionId: reserved.conversationId,
      ordinaryWorkspaceId: reserved.id,
      cwd: reserved.directory,
      accountBinding: binding,
      agentProfile,
      selectedModel: binding.model,
      reasoningEffort: null,
      mode: 'agent' as const,
    };
    eventStore.prepareOrdinaryWorkspaceSession(meta, {
      allocationOperationId: reserved.allocationOperationId,
      preparationFingerprint: reserved.preparationFingerprint,
      settings: reserved.settings,
    });
    const session = registry.get(f.id)!;
    session.sessionId = reserved.conversationId;
    session.cwd = config.workdir;
    const nativeStore = getCodexConversationStore();
    const readRetained = () => {
      try {
        return nativeStore.readArtifactRuntime(reserved.conversationId, binding) ?? undefined;
      } catch {
        return undefined;
      }
    };
    const { ConnectionsService } = await import('../connections-service.js');
    const { getConnectionsRuntime, setConnectionsRuntime } =
      await import('../connections-runtime.js');
    const { openAIAccountKeyAuthority } = await import('../openai-account-key-authority.js');
    const previousRuntime = getConnectionsRuntime();
    const ready = vi.fn(async () => {});
    if (realCredentialGate) {
      const service = new ConnectionsService(
        { list: () => [] } as never,
        {
          sandbox: async (name: string) => sandboxes.get(name),
          sandboxProviders: async () => [],
        } as never,
        { accountCredentialReady: ready },
      );
      setConnectionsRuntime({
        service,
        assertOpenAIKeyReady: ready,
      } as unknown as import('../connections-runtime.js').ConnectionsRuntime);
    }
    const compile = vi.spyOn(OpenShellRuntimeManager.prototype, 'compileContext');
    repositorySeeds.verify.mockClear();
    let query: Awaited<ReturnType<typeof openCodexChat>> | undefined;
    const driver = new OrdinaryOpenShellCodexOwnedRuntime({
      enabled: true,
      workspaceKind: 'ordinary',
      nativeStore,
      authSessionId: 'offline-signed-operator',
      events: eventStore,
      profiles,
      workspace: workspaces,
      sessionId: reserved.conversationId,
      workspaceId: reserved.id,
      taskRoot,
      target,
      config,
      projection,
      capabilitiesCurrent: () => ({ profiles, projection }),
      account: binding,
      assertCurrentSync: () => {
        workspaces.validateRetainedOrdinaryWorkspace(reserved.conversationId);
      },
      assertCurrentIdentitySync: () => {
        workspaces.validateRetainedOrdinaryWorkspace(reserved.conversationId);
      },
      assertCurrent: async () => {
        if (realCredentialGate)
          await openAIAccountKeyAuthority(binding, profiles).assertReady(f.abort.signal);
        await workspaces.revalidateOrdinaryWorkspace({
          id: reserved.id,
          conversationId: reserved.conversationId,
          binding,
          taskRoot,
          signal: f.abort.signal,
        });
      },
      readRetained,
      assertRetainedAuthority: (artifact) =>
        assertOrdinaryOpenShellPhysicalOwner(reserved.conversationId, artifact, binding),
      signal: f.abort.signal,
      close: () => {},
      dispatch: async (input) => {
        query = await openCodexChat({
          ...f.options,
          session,
          conversationId: reserved.conversationId,
          ownedOpenShell: input.admission,
          messageId: input.commandId,
          profile: input.profile,
          agentProfile,
          ordinaryWorkspace: input.workspace as typeof reserved,
          repositoryWorkspace: undefined,
          model: binding.model,
          reasoningEffort: null,
          prompt: input.payload.text,
          systemPrompt: input.payload.systemPrompt,
        });
      },
      dispatchContinuation: async () => {
        throw Error('No continuation in initial-send qualification');
      },
    });
    try {
      const result = await bounded(
        driver.admitPreparedFirst(reserved.allocationOperationId, meta, {
          clientMsgId: f.options.messageId,
          capabilityRevision: projection.inventory.capabilityRevision,
          runtime: {
            account: runtimeBinding.account,
            harness: 'codex',
            targetId: target.targetId,
            mode: 'agent',
          },
          selection,
          payload: { text: f.options.prompt, systemPrompt: f.options.systemPrompt },
        }),
      );
      expect(result.dispatched).toBe(true);
      if (realCredentialGate) expect(ready.mock.calls.length).toBeGreaterThan(2);
      expect(f.requests.filter((method) => method === 'turn/start')).toHaveLength(1);
      expect(compile).toHaveBeenCalledOnce();
      expect(repositorySeeds.verify).not.toHaveBeenCalled();
      expect(forbiddenRepository).not.toHaveBeenCalled();
      expect(
        native.cli.mock.calls.some(
          ([args]) =>
            args.includes('--upload') && args.includes(config.seed + ':/sandbox/workspaces'),
        ),
      ).toBe(true);
      expect(eventStore.getSession(reserved.conversationId)?.ordinaryWorkspaceId).toBe(reserved.id);
      expect(
        nativeStore.readOpenShellCustody(reserved.conversationId, binding)?.workspaceKind,
      ).toBe('ordinary');
    } finally {
      compile.mockRestore();
      query?.close();
      driver.close();
      await sharedOpenShellLifecycleCoordinator.admit(reserved.conversationId, async () => {});
      workspaces.close();
      setConnectionsRuntime(previousRuntime ?? null);
    }
  },
);

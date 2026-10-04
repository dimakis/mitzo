import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SessionRegistry, type ManagedSession } from '@mitzo/harness';
import { EventStore } from '@mitzo/protocol/event-store';
import type { AccountBinding } from '@mitzo/protocol';
const native = vi.hoisted(() => ({ cli: vi.fn(), ssh: vi.fn(), launch: vi.fn() }));
// Only the native CLI and RPC boundaries are substituted. Conversation, send,
// queue, lifecycle coordinator, artifact mapping and lifecycle records are real.
vi.mock('../openshell-runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../openshell-runtime.js')>();
  return {
    ...actual,
    OpenShellRuntimeManager: class extends actual.OpenShellRuntimeManager {
      constructor(config: import('../openshell-runtime.js').BoundOpenShellRuntimeConfig) {
        super(config, native.cli, undefined, native.ssh);
      }
    },
  };
});
vi.mock('../codex-app-server-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../codex-app-server-client.js')>()),
  CodexAppServerClient: { launchOpenShell: (...args: unknown[]) => native.launch(...args) },
}));
import { getCodexConversationStore, openCodexChat } from '../codex-chat-session.js';
import { openShellRuntimeConfig } from '../openshell-runtime.js';
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
    } finally {
      releases.get(f.id)?.();
      await opening.catch(() => {});
      await sharedOpenShellLifecycleCoordinator.admit(f.id, async () => {});
    }
  },
);
it('reattach-only initializes registration and releases its fence without admitting initial work', async () => {
  const f = fixture();
  let chat: Awaited<ReturnType<typeof openCodexChat>> | undefined;
  try {
    chat = await bounded(openCodexChat({ ...f.options, reattachOnly: true }));
    expect(f.requests).toContain('thread/start');
    expect(f.requests).not.toContain('turn/start');
    expect(getCodexConversationStore().commands(f.id, binding)).toEqual([]);
    expect(releaseSnapshots.get(f.id)).toEqual({ thread: undefined, artifact: true });
    expect(releaseCounts.get(f.id)).toBe(1);
  } finally {
    chat?.close();
    await sharedOpenShellLifecycleCoordinator.admit(f.id, async () => {});
  }
});

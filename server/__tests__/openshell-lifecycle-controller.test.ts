import { basename, dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { OpenShellCheckpointTransport } from '../openshell-checkpoint-transport.js';
import { openShellRuntimeConfig, OpenShellRuntimeManager } from '../openshell-runtime.js';
import {
  checkpointDirectoryForConversation,
  configureOpenShellLifecycleInventory,
  initializeOpenShellLifecycle,
  openShellLifecycleAudit,
  openShellLifecycleCapability,
  openShellLifecycleInventory,
  openShellLifecyclePhaseCounts,
  recordOpenShellLifecycleAudit,
  registerOpenShellLifecycle,
  registerOpenShellLifecycleProvisional,
  restoreOpenShellLifecycleIfNeeded,
} from '../openshell-lifecycle-controller.js';

it('hashes arbitrary conversation IDs before creating checkpoint directories', () => {
  const base = '/private/mitzo';
  const ids = ['../escape', '/absolute/path', '会話/../../escape', 'stable id'];
  const paths = ids.map((id) => checkpointDirectoryForConversation(base, id, 7));
  expect(checkpointDirectoryForConversation(base, ids[0]!, 7)).toBe(paths[0]);
  for (const path of paths) {
    expect(dirname(dirname(path))).toBe(`${base}/openshell-checkpoints`);
    expect(basename(dirname(path))).toMatch(/^[a-f0-9]{64}$/);
    expect(basename(path)).toBe('7');
  }
  expect(paths[0]).not.toBe(paths[1]);
});

it('does not read the checkpoint policy when lifecycle is disabled', () => {
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '');
  try {
    expect(
      initializeOpenShellLifecycle(
        {
          cli: 'openshell',
          image: 'mitzo-runtime:1',
          policy: '/unavailable/lifecycle-policy.yaml',
          seed: '/seed/mgmt',
          serviceProviders: [],
          grantableServiceProviders: [],
          workspace: 'default',
          gateway: 'openshell',
          gatewayInsecure: false,
          createDetached: true,
          sandboxIdLength: 13,
          workdir: '/sandbox/workspaces/mgmt',
          webSearch: 'disabled',
        },
        {} as Parameters<typeof initializeOpenShellLifecycle>[1],
      ),
    ).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('keeps read-only inventory available while lifecycle cleanup is disabled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-lifecycle-inventory-only-'));
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', directory);
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '0');
  const inventory = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'inventory')
    .mockResolvedValue([{ id: 'physical-id', name: 'sandbox', phase: 'Ready' as const }]);
  const controller = configureOpenShellLifecycleInventory(
    {
      cli: 'openshell',
      image: 'mitzo-runtime:1',
      policy: '/unavailable/lifecycle-policy.yaml',
      seed: '/seed/mgmt',
      serviceProviders: [],
      grantableServiceProviders: [],
      workspace: 'default',
      gateway: 'openshell',
      gatewayInsecure: false,
      createDetached: true,
      sandboxIdLength: 13,
      workdir: '/sandbox/workspaces/mgmt',
      webSearch: 'disabled',
    },
    {
      registry: { findBySessionId: () => undefined, entries: function* () {} },
      eventStore: { getSession: () => ({}) },
      taskStore: { getTree: () => [] },
      queue: () => ({ queued: 0, running: 0, recovery: false }),
      accountProviders: () => ['openai-work'],
    },
  )!;
  try {
    await expect(openShellLifecycleInventory(AbortSignal.timeout(100))).resolves.toMatchObject({
      available: true,
      sandboxes: [{ status: 'orphaned', physicalId: 'physical-id' }],
    });
    expect(inventory).toHaveBeenCalledOnce();
    inventory.mockRejectedValueOnce(new Error('provider offline'));
    await expect(openShellLifecycleInventory(AbortSignal.timeout(100))).resolves.toMatchObject({
      available: false,
      partial: true,
      scopes: [
        {
          provider: 'openai-work',
          workspace: 'default',
          status: 'unavailable',
          error: 'provider_inventory_unavailable',
        },
      ],
    });
  } finally {
    inventory.mockRestore();
    controller.store.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('keeps historical lifecycle audits visible while cleanup is disabled', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-lifecycle-audit-only-'));
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', directory);
  const controller = configureOpenShellLifecycleInventory(
    {
      cli: 'openshell',
      image: 'mitzo-runtime:1',
      policy: '/unavailable/lifecycle-policy.yaml',
      seed: '/seed/mgmt',
      serviceProviders: [],
      grantableServiceProviders: [],
      workspace: 'default',
      gateway: 'openshell',
      gatewayInsecure: false,
      createDetached: true,
      sandboxIdLength: 13,
      workdir: '/sandbox/workspaces/mgmt',
      webSearch: 'disabled',
    },
    {} as Parameters<typeof configureOpenShellLifecycleInventory>[1],
  )!;
  try {
    recordOpenShellLifecycleAudit({
      at: 1,
      actor: 'operator',
      conversationId: 'historical-conversation',
      sandboxId: 'historical-sandbox',
      generation: 1,
      action: 'preview',
      outcome: 'allowed',
      error: null,
    });
    expect(openShellLifecycleAudit()).toEqual([
      expect.objectContaining({ conversationId: 'historical-conversation', action: 'preview' }),
    ]);
  } finally {
    controller.store.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  ['idle interval', 'MITZO_OPENSHELL_IDLE_MINUTES', 'not-a-number'],
  ['reconcile interval', 'MITZO_OPENSHELL_RECONCILE_MINUTES', 'not-a-number'],
  ['retention', 'MITZO_OPENSHELL_RETENTION_DAYS', 'not-a-number'],
  ['usage threshold', 'MITZO_OPENSHELL_USAGE_THRESHOLD_BYTES', '0'],
  ['sandbox threshold', 'MITZO_OPENSHELL_SANDBOX_THRESHOLD', '-1'],
  ['policy path', 'MITZO_OPENSHELL_POLICY', 'relative-policy.yaml'],
])('is inert with stale %s configuration while OpenShell is disabled', (_name, key, value) => {
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '');
  vi.stubEnv(key, value);
  try {
    expect(openShellRuntimeConfig(process.env)).toBeUndefined();
    expect(() =>
      initializeOpenShellLifecycle(
        openShellRuntimeConfig(process.env),
        {} as Parameters<typeof initializeOpenShellLifecycle>[1],
      ),
    ).not.toThrow();
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each([
  ['idle interval', 'MITZO_OPENSHELL_IDLE_MINUTES', 'not-a-number'],
  ['reconcile interval', 'MITZO_OPENSHELL_RECONCILE_MINUTES', 'not-a-number'],
  ['retention', 'MITZO_OPENSHELL_RETENTION_DAYS', 'not-a-number'],
  ['usage threshold', 'MITZO_OPENSHELL_USAGE_THRESHOLD_BYTES', '0'],
  ['sandbox threshold', 'MITZO_OPENSHELL_SANDBOX_THRESHOLD', '-1'],
  ['policy path', 'MITZO_OPENSHELL_POLICY', 'relative-policy.yaml'],
])(
  'is inert with stale %s configuration while lifecycle cleanup is disabled',
  (_name, key, value) => {
    vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '');
    vi.stubEnv(key, value);
    try {
      expect(() =>
        initializeOpenShellLifecycle(
          {
            cli: 'openshell',
            image: 'mitzo-runtime:1',
            policy: '/unavailable/lifecycle-policy.yaml',
            seed: '/seed/mgmt',
            serviceProviders: [],
            grantableServiceProviders: [],
            workspace: 'default',
            gateway: 'openshell',
            gatewayInsecure: false,
            createDetached: true,
            sandboxIdLength: 13,
            workdir: '/sandbox/workspaces/mgmt',
            webSearch: 'disabled',
          },
          {} as Parameters<typeof initializeOpenShellLifecycle>[1],
        ),
      ).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it('rejects an invalid lifecycle enable flag before parsing lifecycle settings', () => {
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', 'sometimes');
  vi.stubEnv('MITZO_OPENSHELL_IDLE_MINUTES', 'not-a-number');
  try {
    expect(() =>
      initializeOpenShellLifecycle(
        {
          cli: 'openshell',
          image: 'mitzo-runtime:1',
          policy: '/unavailable/lifecycle-policy.yaml',
          seed: '/seed/mgmt',
          serviceProviders: [],
          grantableServiceProviders: [],
          workspace: 'default',
          gateway: 'openshell',
          gatewayInsecure: false,
          createDetached: true,
          sandboxIdLength: 13,
          workdir: '/sandbox/workspaces/mgmt',
          webSearch: 'disabled',
        },
        {} as Parameters<typeof initializeOpenShellLifecycle>[1],
      ),
    ).toThrow('lifecycle enabled');
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each([
  ['MITZO_OPENSHELL_IDLE_MINUTES', 'not-a-number'],
  ['MITZO_OPENSHELL_RECONCILE_MINUTES', 'not-a-number'],
  ['MITZO_OPENSHELL_RETENTION_DAYS', 'not-a-number'],
])('still validates %s when OpenShell is configured', (key, value) => {
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
  vi.stubEnv(key, value);
  try {
    expect(() =>
      initializeOpenShellLifecycle(
        {
          cli: 'openshell',
          image: 'mitzo-runtime:1',
          policy: '/unavailable/lifecycle-policy.yaml',
          seed: '/seed/mgmt',
          serviceProviders: [],
          grantableServiceProviders: [],
          workspace: 'default',
          gateway: 'openshell',
          gatewayInsecure: false,
          createDetached: true,
          sandboxIdLength: 13,
          workdir: '/sandbox/workspaces/mgmt',
          webSearch: 'disabled',
        },
        {} as Parameters<typeof initializeOpenShellLifecycle>[1],
      ),
    ).toThrow();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('keeps a newly ensured sandbox durably fenced until its provider thread is ready', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-lifecycle-controller-'));
  const policy = join(directory, 'policy.yaml');
  writeFileSync(policy, 'reviewed: policy\n');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', directory);
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
  try {
    const lifecycle = initializeOpenShellLifecycle(
      {
        cli: 'openshell',
        image: 'mitzo-runtime:1',
        policy,
        seed: '/seed/mgmt',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      {
        registry: { findBySessionId: () => undefined, entries: function* () {} },
        eventStore: { getSession: () => ({}) },
        taskStore: { getTree: () => [] },
        queue: () => ({ queued: 0, running: 0, recovery: false }),
      },
    )!;
    const runtime = {
      sandboxName: 'mitzo-sandbox',
      sandboxId: 'physical-id',
      workdir: '/sandbox/workspaces/mgmt',
      appServerCommand: '/sandbox/run-mitzo-app-server' as const,
      cli: 'openshell',
      gateway: 'openshell',
      workspace: 'default',
      gatewayInsecure: false,
    };
    const account = { kind: 'api' as const, provider: 'openai-work', model: 'model' };
    const binding = {
      accountId: 'account',
      accountLabel: 'Account',
      provider: 'openai',
      model: 'model',
      profileRevision: '1',
    };
    registerOpenShellLifecycleProvisional('conversation', runtime, account, 'client');
    expect(lifecycle.store.get('conversation')).toMatchObject({
      phase: 'retained',
      physicalSandboxId: 'physical-id',
      identity: null,
    });
    await expect(
      restoreOpenShellLifecycleIfNeeded(
        'conversation',
        runtime,
        AbortSignal.timeout(100),
        binding,
        account,
      ),
    ).resolves.toBeUndefined();
    await expect(
      restoreOpenShellLifecycleIfNeeded(
        'conversation',
        { ...runtime, sandboxId: 'replacement-id', created: true },
        AbortSignal.timeout(100),
        binding,
        account,
        true,
      ),
    ).rejects.toThrow('account binding changed');
    registerOpenShellLifecycle('conversation', runtime, binding, account, 'thread', 'client');
    expect(lifecycle.store.get('conversation')).toMatchObject({
      physicalSandboxId: 'physical-id',
      identity: expect.objectContaining({ threadId: 'thread' }),
    });
    lifecycle.store.close();
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('keeps a failed same-sandbox stop fenced until checkpoint and ownership recovery succeeds', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-lifecycle-controller-failed-recovery-'));
  const policy = join(directory, 'policy.yaml');
  writeFileSync(policy, 'reviewed: policy\n');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', directory);
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
  const lifecycle = initializeOpenShellLifecycle(
    {
      cli: 'openshell',
      image: 'mitzo-runtime:1',
      policy,
      seed: '/seed/mgmt',
      serviceProviders: [],
      grantableServiceProviders: [],
      workspace: 'default',
      gateway: 'openshell',
      gatewayInsecure: false,
      createDetached: true,
      sandboxIdLength: 13,
      workdir: '/sandbox/workspaces/mgmt',
      webSearch: 'disabled',
    },
    {
      registry: { findBySessionId: () => undefined, entries: function* () {} },
      eventStore: { getSession: () => ({}) },
      taskStore: { getTree: () => [] },
      queue: () => ({ queued: 0, running: 0, recovery: false }),
    },
  )!;
  const runtime = {
    sandboxName: 'mitzo-sandbox',
    sandboxId: 'physical-id',
    workdir: '/sandbox/workspaces/mgmt',
    appServerCommand: '/sandbox/run-mitzo-app-server' as const,
    cli: 'openshell',
    gateway: 'openshell',
    workspace: 'default',
    gatewayInsecure: false,
  };
  const account = { kind: 'api' as const, provider: 'openai-work', model: 'model' };
  const binding = {
    accountId: 'account',
    accountLabel: 'Account',
    provider: 'openai',
    model: 'model',
    profileRevision: '1',
  };
  const inspect = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'inspect')
    .mockResolvedValue({ id: 'physical-id', phase: 'Ready' });
  const verify = vi
    .spyOn(OpenShellCheckpointTransport.prototype, 'verify')
    .mockRejectedValueOnce(new Error('checkpoint unavailable'))
    .mockResolvedValue({ digest: 'a'.repeat(64) } as Awaited<
      ReturnType<typeof OpenShellCheckpointTransport.prototype.verify>
    >);
  try {
    registerOpenShellLifecycle('conversation', runtime, binding, account, 'thread', 'client');
    const retained = lifecycle.store.get('conversation')!;
    lifecycle.store.upsert({
      ...retained,
      phase: 'failed',
      generation: retained.generation + 1,
      stoppedAt: Date.now(),
      checkpoint: {
        path: '/private/checkpoint',
        digest: 'a'.repeat(64),
        version: 1,
        sandboxId: 'physical-id',
        sourceResourceVersion: 'stopped-version',
      },
      failure: 'OpenShell stop could not be verified',
    });

    await expect(
      restoreOpenShellLifecycleIfNeeded(
        'conversation',
        runtime,
        AbortSignal.timeout(100),
        binding,
        account,
        true,
      ),
    ).rejects.toThrow('checkpoint unavailable');
    expect(lifecycle.store.get('conversation')).toMatchObject({
      phase: 'failed',
      failure: 'OpenShell stop could not be verified',
    });
    expect(() =>
      registerOpenShellLifecycle('conversation', runtime, binding, account, 'thread', 'client'),
    ).toThrow('recovery must be verified');

    await expect(
      restoreOpenShellLifecycleIfNeeded(
        'conversation',
        runtime,
        AbortSignal.timeout(100),
        binding,
        account,
        true,
      ),
    ).resolves.toBeUndefined();
    expect(lifecycle.store.get('conversation')).toMatchObject({
      phase: 'retained',
      failure: null,
      physicalSandboxId: 'physical-id',
    });
    registerOpenShellLifecycle('conversation', runtime, binding, account, 'thread', 'client');
    expect(inspect).toHaveBeenCalledTimes(2);
  } finally {
    inspect.mockRestore();
    verify.mockRestore();
    lifecycle.store.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('restores repeated replacements from the immutable checkpoint origin and rejects tampering', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-lifecycle-controller-recovery-'));
  const policy = join(directory, 'policy.yaml');
  writeFileSync(policy, 'reviewed: policy\n');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', directory);
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
  const lifecycle = initializeOpenShellLifecycle(
    {
      cli: 'openshell',
      image: 'mitzo-runtime:1',
      policy,
      seed: '/seed/mgmt',
      serviceProviders: [],
      grantableServiceProviders: [],
      workspace: 'default',
      gateway: 'openshell',
      gatewayInsecure: false,
      createDetached: true,
      sandboxIdLength: 13,
      workdir: '/sandbox/workspaces/mgmt',
      webSearch: 'disabled',
    },
    {
      registry: { findBySessionId: () => undefined, entries: function* () {} },
      eventStore: { getSession: () => ({}) },
      taskStore: { getTree: () => [] },
      queue: () => ({ queued: 0, running: 0, recovery: false }),
    },
  )!;
  const source = {
    sandboxName: 'mitzo-sandbox',
    sandboxId: 'origin-a',
    workdir: '/sandbox/workspaces/mgmt',
    appServerCommand: '/sandbox/run-mitzo-app-server' as const,
    cli: 'openshell',
    gateway: 'openshell',
    workspace: 'default',
    gatewayInsecure: false,
  };
  const account = { kind: 'api' as const, provider: 'openai-work', model: 'model' };
  const binding = {
    accountId: 'account',
    accountLabel: 'Account',
    provider: 'openai',
    model: 'model',
    profileRevision: '1',
  };
  registerOpenShellLifecycle('conversation', source, binding, account, 'thread', 'client');
  const retained = lifecycle.store.get('conversation')!;
  lifecycle.store.upsert({
    ...retained,
    phase: 'stopped',
    generation: retained.generation + 1,
    stoppedAt: Date.now(),
    checkpoint: {
      path: '/private/checkpoint',
      digest: 'a'.repeat(64),
      version: 1,
      sandboxId: 'origin-a',
      sourceResourceVersion: 'origin-version',
    },
  });
  const restore = vi
    .spyOn(OpenShellCheckpointTransport.prototype, 'restore')
    .mockImplementation(async (_path, identity) => {
      if (identity.sandboxId !== 'origin-a')
        throw new Error('checkpoint helper returned mismatched manifest');
    });
  try {
    await expect(
      restoreOpenShellLifecycleIfNeeded(
        'conversation',
        { ...source, sandboxId: 'replacement-b', created: true },
        AbortSignal.timeout(100),
        binding,
        account,
        true,
      ),
    ).resolves.toBeUndefined();
    expect(lifecycle.store.get('conversation')).toMatchObject({
      phase: 'retained',
      physicalSandboxId: 'replacement-b',
      checkpoint: expect.objectContaining({ sandboxId: 'origin-a' }),
    });

    await expect(
      restoreOpenShellLifecycleIfNeeded(
        'conversation',
        { ...source, sandboxId: 'replacement-c', created: true },
        AbortSignal.timeout(100),
        binding,
        account,
        true,
      ),
    ).resolves.toBeUndefined();
    expect(restore).toHaveBeenCalledTimes(2);
    expect(restore.mock.calls.map(([, identity]) => identity.sandboxId)).toEqual([
      'origin-a',
      'origin-a',
    ]);

    const restored = lifecycle.store.get('conversation')!;
    lifecycle.store.upsert({
      ...restored,
      phase: 'deleted',
      generation: restored.generation + 1,
      checkpoint: { ...restored.checkpoint!, sandboxId: 'tampered-origin' },
    });
    await expect(
      restoreOpenShellLifecycleIfNeeded(
        'conversation',
        { ...source, sandboxId: 'replacement-d', created: true },
        AbortSignal.timeout(100),
        binding,
        account,
        true,
      ),
    ).rejects.toThrow('checkpoint helper returned mismatched manifest');
    expect(lifecycle.store.get('conversation')).toMatchObject({ phase: 'failed' });
  } finally {
    restore.mockRestore();
    lifecycle.store.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('counts configured recordless providers once while retaining partial inventory errors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-lifecycle-controller-telemetry-'));
  const policy = join(directory, 'policy.yaml');
  writeFileSync(policy, 'reviewed: policy\n');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', directory);
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
  const inventory = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'inventory')
    .mockResolvedValueOnce([
      {
        id: 'legacy-sandbox',
        name: 'mitzo-legacy',
        phase: 'Ready' as const,
      },
    ])
    .mockRejectedValueOnce(new Error('provider unavailable'));
  const lifecycle = initializeOpenShellLifecycle(
    {
      cli: 'openshell',
      image: 'mitzo-runtime:1',
      policy,
      seed: '/seed/mgmt',
      serviceProviders: [],
      grantableServiceProviders: [],
      workspace: 'default',
      gateway: 'openshell',
      gatewayInsecure: false,
      createDetached: true,
      sandboxIdLength: 13,
      workdir: '/sandbox/workspaces/mgmt',
      webSearch: 'disabled',
    },
    {
      registry: { findBySessionId: () => undefined, entries: function* () {} },
      eventStore: { getSession: () => ({}) },
      taskStore: { getTree: () => [] },
      queue: () => ({ queued: 0, running: 0, recovery: false }),
      accountProviders: () => ['legacy-provider', 'legacy-provider', 'unavailable-provider'],
    } as Parameters<typeof initializeOpenShellLifecycle>[1] & {
      accountProviders: () => string[];
    },
  )!;
  try {
    await expect(openShellLifecyclePhaseCounts(AbortSignal.timeout(100))).resolves.toEqual({
      phaseCounts: { Ready: 1 },
      providerErrors: { 'unavailable-provider': 'provider unavailable' },
    });
    expect(inventory).toHaveBeenCalledTimes(2);
  } finally {
    inventory.mockRestore();
    lifecycle.store.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('discovers recordless orphans and reconciles identity-less provisional records', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-lifecycle-controller-orphans-'));
  const policy = join(directory, 'policy.yaml');
  writeFileSync(policy, 'reviewed: policy\n');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', directory);
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
  const inventory = vi.spyOn(OpenShellRuntimeManager.prototype, 'inventory').mockResolvedValue([
    { id: 'provisional-id', name: 'mitzo-provisional', phase: 'Ready' as const },
    { id: 'orphan-id', name: 'mitzo-orphan', phase: 'Ready' as const },
  ]);
  const lifecycle = initializeOpenShellLifecycle(
    {
      cli: 'openshell',
      image: 'mitzo-runtime:1',
      policy,
      seed: '/seed/mgmt',
      serviceProviders: [],
      grantableServiceProviders: [],
      workspace: 'default',
      gateway: 'openshell',
      gatewayInsecure: false,
      createDetached: true,
      sandboxIdLength: 13,
      workdir: '/sandbox/workspaces/mgmt',
      webSearch: 'disabled',
    },
    {
      registry: { findBySessionId: () => undefined, entries: function* () {} },
      eventStore: { getSession: () => ({}) },
      taskStore: { getTree: () => [] },
      queue: () => ({ queued: 0, running: 0, recovery: false }),
      accountProviders: () => [],
    },
  )!;
  try {
    registerOpenShellLifecycleProvisional(
      'provisional-conversation',
      {
        sandboxName: 'mitzo-provisional',
        sandboxId: 'provisional-id',
        workdir: '/sandbox/workspaces/mgmt',
        appServerCommand: '/sandbox/run-mitzo-app-server',
        cli: 'openshell',
        gateway: 'openshell',
        workspace: 'default',
        gatewayInsecure: false,
      },
      { kind: 'api', provider: 'openai-work', model: 'model' },
      'client',
    );
    await expect(openShellLifecycleInventory(AbortSignal.timeout(100))).resolves.toMatchObject({
      available: true,
      partial: false,
      scopes: [{ provider: 'openai-work', workspace: 'default', status: 'available' }],
      sandboxes: [
        {
          status: 'verified',
          physicalId: 'provisional-id',
          provider: 'openai-work',
          conversationId: 'provisional-conversation',
          capabilities: { runtime: false, lifecycleActions: 'unsupported' },
        },
        {
          status: 'orphaned',
          physicalId: 'orphan-id',
          provider: 'openai-work',
          conversationId: null,
          capabilities: { lifecycleActions: 'unsupported' },
        },
      ],
    });
  } finally {
    inventory.mockRestore();
    lifecycle.store.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('matches physical inventory only to records from the queried provider', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-lifecycle-provider-scope-'));
  const policy = join(directory, 'policy.yaml');
  writeFileSync(policy, 'reviewed: policy\n');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', directory);
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
  const inventory = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'inventory')
    .mockResolvedValue([{ id: 'shared-id', name: 'shared-name', phase: 'Ready' as const }]);
  const lifecycle = initializeOpenShellLifecycle(
    {
      cli: 'openshell',
      image: 'mitzo-runtime:1',
      policy,
      seed: '/seed/mgmt',
      serviceProviders: [],
      grantableServiceProviders: [],
      workspace: 'default',
      gateway: 'openshell',
      gatewayInsecure: false,
      createDetached: true,
      sandboxIdLength: 13,
      workdir: '/sandbox/workspaces/mgmt',
      webSearch: 'disabled',
    },
    {
      registry: { findBySessionId: () => undefined, entries: function* () {} },
      eventStore: { getSession: () => ({}) },
      taskStore: { getTree: () => [] },
      queue: () => ({ queued: 0, running: 0, recovery: false }),
      accountProviders: () => [],
    },
  )!;
  const runtime = {
    sandboxName: 'shared-name',
    sandboxId: 'shared-id',
    workdir: '/sandbox/workspaces/mgmt',
    appServerCommand: '/sandbox/run-mitzo-app-server' as const,
    cli: 'openshell',
    gateway: 'openshell',
    workspace: 'default',
    gatewayInsecure: false,
  };
  try {
    registerOpenShellLifecycleProvisional(
      'provider-one-conversation',
      runtime,
      { kind: 'api', provider: 'provider-one', model: 'model' },
      'client',
    );
    registerOpenShellLifecycleProvisional(
      'provider-two-conversation',
      runtime,
      { kind: 'api', provider: 'provider-two', model: 'model' },
      'client',
    );

    const result = await openShellLifecycleInventory(AbortSignal.timeout(100));
    expect(result.sandboxes).toEqual([
      expect.objectContaining({
        status: 'verified',
        provider: 'provider-one',
        conversationId: 'provider-one-conversation',
      }),
      expect.objectContaining({
        status: 'verified',
        provider: 'provider-two',
        conversationId: 'provider-two-conversation',
      }),
    ]);
    expect(inventory).toHaveBeenCalledTimes(2);
  } finally {
    inventory.mockRestore();
    lifecycle.store.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('does not let audit persistence failure escape into a completed action path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-lifecycle-controller-audit-failure-'));
  const policy = join(directory, 'policy.yaml');
  writeFileSync(policy, 'reviewed: policy\n');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', directory);
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
  const lifecycle = initializeOpenShellLifecycle(
    {
      cli: 'openshell',
      image: 'mitzo-runtime:1',
      policy,
      seed: '/seed/mgmt',
      serviceProviders: [],
      grantableServiceProviders: [],
      workspace: 'default',
      gateway: 'openshell',
      gatewayInsecure: false,
      createDetached: true,
      sandboxIdLength: 13,
      workdir: '/sandbox/workspaces/mgmt',
      webSearch: 'disabled',
    },
    {
      registry: { findBySessionId: () => undefined, entries: function* () {} },
      eventStore: { getSession: () => ({}) },
      taskStore: { getTree: () => [] },
      queue: () => ({ queued: 0, running: 0, recovery: false }),
    },
  )!;
  vi.spyOn(lifecycle.store, 'appendAudit').mockImplementation(() => {
    throw new Error('disk response includes secret-token');
  });
  try {
    expect(() =>
      recordOpenShellLifecycleAudit({
        at: Date.now(),
        actor: 'operator',
        conversationId: 'conversation',
        sandboxId: 'sandbox',
        generation: 1,
        action: 'confirm',
        outcome: 'confirmed',
        error: null,
      }),
    ).not.toThrow();
  } finally {
    lifecycle.store.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('keeps raw provider and lifecycle diagnostics out of operator inventory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-lifecycle-controller-redaction-'));
  const policy = join(directory, 'policy.yaml');
  writeFileSync(policy, 'reviewed: policy\n');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', directory);
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
  const inventory = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'inventory')
    .mockRejectedValue(new Error('Bearer secret-token grant-123 response-body'));
  const lifecycle = initializeOpenShellLifecycle(
    {
      cli: 'openshell',
      image: 'mitzo-runtime:1',
      policy,
      seed: '/seed/mgmt',
      serviceProviders: [],
      grantableServiceProviders: [],
      workspace: 'default',
      gateway: 'openshell',
      gatewayInsecure: false,
      createDetached: true,
      sandboxIdLength: 13,
      workdir: '/sandbox/workspaces/mgmt',
      webSearch: 'disabled',
    },
    {
      registry: { findBySessionId: () => undefined, entries: function* () {} },
      eventStore: { getSession: () => ({}) },
      taskStore: { getTree: () => [] },
      queue: () => ({ queued: 0, running: 0, recovery: false }),
    },
  )!;
  const runtime = {
    sandboxName: 'mitzo-sandbox',
    sandboxId: 'physical-id',
    workdir: '/sandbox/workspaces/mgmt',
    appServerCommand: '/sandbox/run-mitzo-app-server' as const,
    cli: 'openshell',
    gateway: 'openshell',
    workspace: 'default',
    gatewayInsecure: false,
  };
  const account = { kind: 'api' as const, provider: 'openai-work', model: 'model' };
  const binding = {
    accountId: 'account',
    accountLabel: 'Account',
    provider: 'openai',
    model: 'model',
    profileRevision: '1',
  };
  try {
    registerOpenShellLifecycle('conversation', runtime, binding, account, 'thread', 'client');
    const record = lifecycle.store.get('conversation')!;
    lifecycle.store.upsert({
      ...record,
      generation: record.generation + 1,
      failure: 'Bearer stored-secret grant-456 provider-response',
      identity: { ...record.identity!, image: 'retired-image', policyDigest: 'retired-policy' },
    });

    const result = await openShellLifecycleInventory(AbortSignal.timeout(100));
    expect(result.scopes).toEqual([
      expect.objectContaining({
        status: 'unavailable',
        error: 'provider_inventory_unavailable',
      }),
    ]);
    expect(result.sandboxes).toEqual([
      expect.objectContaining({ lastFailure: 'lifecycle_operation_failed' }),
    ]);
    expect(inventory).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/secret-token|stored-secret|grant-123|grant-456/);

    const aborted = new AbortController();
    aborted.abort();
    await expect(openShellLifecycleInventory(aborted.signal)).rejects.toThrow();
  } finally {
    inventory.mockRestore();
    lifecycle.store.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('fails closed for Vertex lifecycle/checkpoint capabilities until an adapter exists', () => {
  const common = {
    conversationId: 'c',
    workspace: 'w',
    gateway: 'g',
    gatewayEndpoint: null,
    sandboxName: 's',
    physicalSandboxId: 'id',
    accountProvider: 'provider',
    phase: 'retained' as const,
    generation: 1,
    lastActivityAt: 1,
    idleSince: null,
    stoppedAt: null,
    checkpoint: null,
  };
  expect(
    openShellLifecycleCapability({
      ...common,
      identity: {
        threadId: 't',
        accountId: 'a',
        provider: 'google-vertex',
        model: 'm',
        profileRevision: 'r',
        image: 'i',
        policyDigest: 'p',
        runtimeScope: 'w',
        route: { kind: 'api', provider: 'future-vertex', model: 'm' },
      },
    }),
  ).toMatchObject({ checkpoint: 'unsupported', lifecycleActions: 'unsupported' });
  expect(
    openShellLifecycleCapability({
      ...common,
      identity: {
        threadId: 't',
        accountId: 'a',
        provider: 'openai-codex',
        model: 'm',
        profileRevision: 'r',
        image: 'i',
        policyDigest: 'p',
        runtimeScope: 'w',
        route: {
          kind: 'chatgpt-subscription',
          provider: 'openai',
          providerType: 'openai-codex-oauth',
          providerId: 'p',
          grantId: 'g',
          model: 'm',
        },
      },
    }),
  ).toMatchObject({ checkpoint: 'supported', lifecycleActions: 'supported' });
});

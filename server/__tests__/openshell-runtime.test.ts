import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OpenShellRuntimeManager,
  openShellCodexRuntimeConfig,
  openShellRuntimeConfig,
  sandboxNameForConversation,
} from '../openshell-runtime.js';

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
  image: 'mitzo-runtime:1',
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

describe('OpenShell runtime lifecycle', () => {
  it('derives a stable non-revealing sandbox identity', () => {
    expect(sandboxNameForConversation('private-conversation-name')).toMatch(/^mitzo-[a-f0-9]{13}$/);
    expect(sandboxNameForConversation('private-conversation-name')).toHaveLength(19);
    expect(sandboxNameForConversation('private-conversation-name')).not.toContain('private');
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
      .mockResolvedValueOnce('{}');
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

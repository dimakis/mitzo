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
const providerList = (sandbox: string, providers: string[]) =>
  providers.length
    ? `NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n${providers
        .map((provider) => `${provider} service 0 0`)
        .join('\n')}`
    : `No providers attached to sandbox ${sandbox}.`;

describe('OpenShell runtime lifecycle', () => {
  it('requires OpenShell 0.1 and physical attestation for an artifact mount', async () => {
    const artifactDriverConfig = {
      podman: {
        mounts: [
          {
            type: 'volume' as const,
            source: 'artifacts-1',
            target: '/sandbox/symposium-artifacts',
            read_only: true,
          },
        ],
      },
    };
    const run = vi.fn(async () => '{}');
    await expect(
      new OpenShellRuntimeManager({ ...config, artifactDriverConfig }, run).ensure(
        'conversation',
        new AbortController().signal,
      ),
    ).rejects.toThrow('requires OpenShell 0.1');
    await expect(
      new OpenShellRuntimeManager(
        {
          ...config,
          cliContract: 'v0.1',
          artifactDriverConfig,
          serviceProviders: [],
          grantableServiceProviders: [],
          accountProviderBindings: [{ name: 'openai-work', type: 'openai', id: 'provider-id' }],
          verifyAccountProviderUnion: () => undefined,
        },
        run,
      ).ensure('conversation', new AbortController().signal),
    ).rejects.toThrow('physical mount attestation');
    expect(run).not.toHaveBeenCalled();
  });

  it('passes a lease-bound driver config only on 0.1 create and attests physical mount', async () => {
    const commands: string[][] = [];
    const sandboxName = sandboxNameForConversation('conversation');
    const artifactDriverConfig = {
      podman: {
        mounts: [
          {
            type: 'volume' as const,
            source: 'artifacts-1',
            target: '/sandbox/symposium-artifacts',
            read_only: true,
          },
        ],
      },
    };
    let created = false;
    const run = vi.fn(async (args: readonly string[]) => {
      commands.push([...args]);
      if (args[0] === 'sandbox' && args.includes('provider') && args.includes('list'))
        return JSON.stringify({
          providers: [{ name: 'openai-work', type: 'openai' }],
          next_page_token: '',
        });
      if (args[0] === 'provider')
        return JSON.stringify({
          providers: [
            {
              name: 'openai-work',
              id: 'provider-id',
              type: 'openai',
              workspace: 'mitzo',
            },
          ],
          next_page_token: '',
        });
      if (args.includes('get')) {
        if (!created) throw new Error('sandbox not found');
        return JSON.stringify({
          name: sandboxName,
          id: 'physical-id',
          workspace: 'mitzo',
          phase: 'Ready',
          labels: {
            'mitzo.conversation': owner,
            'mitzo.account_provider': 'openai-work',
            'mitzo.provider_policy': 'state-v2-none',
          },
        });
      }
      if (args.includes('create')) {
        created = true;
        return '{}';
      }
      if (args.includes('list')) return JSON.stringify({ providers: [], next_page_token: '' });
      return '{}';
    });
    const verifyArtifactMount = vi.fn(async () => {});
    const manager = new OpenShellRuntimeManager(
      {
        ...config,
        cliContract: 'v0.1',
        serviceProviders: [],
        grantableServiceProviders: [],
        accountProviderBindings: [{ name: 'openai-work', type: 'openai', id: 'provider-id' }],
        verifyAccountProviderUnion: () => undefined,
        artifactDriverConfig,
        verifyArtifactMount,
      },
      run,
    );
    await manager.ensure('conversation', new AbortController().signal);
    const create = commands.find((args) => args.includes('create'))!;
    expect(create[create.indexOf('--driver-config-json') + 1]).toBe(
      JSON.stringify(artifactDriverConfig),
    );
    expect(verifyArtifactMount).toHaveBeenCalledWith(
      sandboxName,
      'physical-id',
      artifactDriverConfig,
    );
  });
  it('uses 0.1 workspace, pagination, and exactly one pinned account attachment', async () => {
    const commands: string[][] = [];
    const sandboxName = sandboxNameForConversation('conversation');
    let created = false;
    const runtimeConfig = {
      ...config,
      cliContract: 'v0.1' as const,
      serviceProviders: [],
      grantableServiceProviders: [],
      accountProviderBindings: [{ name: 'openai-work', type: 'openai', id: 'provider-id' }],
      verifyAccountProviderUnion: () => undefined,
    };
    const run = vi.fn(async (args: readonly string[]) => {
      commands.push([...args]);
      if (args[0] === 'provider' && args.includes('list'))
        return JSON.stringify({
          providers: [
            { name: 'openai-work', id: 'provider-id', type: 'openai', workspace: 'mitzo' },
          ],
          next_page_token: '',
        });
      if (args.includes('get')) {
        if (!created) throw new Error('sandbox not found');
        return JSON.stringify({
          name: sandboxName,
          id: 'sandbox-id',
          workspace: 'mitzo',
          phase: 'Ready',
          labels: {
            'mitzo.conversation': owner,
            'mitzo.account_provider': 'openai-work',
            'mitzo.provider_policy': 'state-v2-none',
          },
        });
      }
      if (args.includes('create')) {
        created = true;
        return '{}';
      }
      if (args.includes('provider') && args.includes('list'))
        return JSON.stringify({
          providers: [
            {
              name: 'openai-work',
              type: 'openai',
              credential_keys: ['OPENAI_API_KEY'],
              config_keys: [],
            },
          ],
          next_page_token: '',
        });
      if (args.includes('list')) return JSON.stringify({ sandboxes: [], next_page_token: '' });
      return '{}';
    });
    const manager = new OpenShellRuntimeManager(runtimeConfig, run);
    const result = await manager.ensure('conversation', new AbortController().signal);
    expect(result.sandboxName).toBe(sandboxName);
    const create = commands.find((args) => args.includes('create'))!;
    expect(create).toContain('--workspace');
    expect(create[create.indexOf('--workspace') + 1]).toBe('mitzo');
    expect(create.filter((part) => part === '--provider')).toHaveLength(1);
    expect(create[create.indexOf('--provider') + 1]).toBe('openai-work');
    expect(create).not.toContain('--inference-model');
    expect(
      commands
        .filter((args) => args.includes('provider') && args.includes('list'))
        .every((args) => args.includes('--output') && args.includes('json')),
    ).toBe(true);
    expect(commands.find((args) => args[0] === 'provider' && args.includes('list'))).toContain(
      '--page-size',
    );
  });
  it('rejects a retained 0.1 seat sandbox with a sibling provider', async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'provider')
        return JSON.stringify({
          providers: [
            { name: 'openai-work', id: 'provider-id', type: 'openai', workspace: 'mitzo' },
          ],
          next_page_token: '',
        });
      if (args.includes('get'))
        return JSON.stringify({
          ...JSON.parse(ready('Ready', 'state-v2-none')),
          name: sandboxNameForConversation('conversation'),
          workspace: 'mitzo',
        });
      if (args.includes('provider') && args.includes('list'))
        return JSON.stringify({
          providers: [
            { name: 'openai-work', type: 'openai' },
            { name: 'vertex-work', type: 'google-vertex-ai' },
          ],
          next_page_token: '',
        });
      return '{}';
    });
    const manager = new OpenShellRuntimeManager(
      {
        ...config,
        cliContract: 'v0.1',
        serviceProviders: [],
        grantableServiceProviders: [],
        accountProviderBindings: [{ name: 'openai-work', type: 'openai', id: 'provider-id' }],
        verifyAccountProviderUnion: () => undefined,
      },
      run,
    );
    await expect(manager.ensure('conversation', new AbortController().signal)).rejects.toThrow(
      /another provider attachment/,
    );
    expect(run).not.toHaveBeenCalledWith(expect.arrayContaining(['attach']), expect.anything());
  });
  it('waits for the exact 0.1 provider attachment before admitting a retained seat', async () => {
    const commands: string[][] = [];
    let attached = false;
    const run = vi.fn(async (args: readonly string[]) => {
      commands.push([...args]);
      if (args[0] === 'provider')
        return JSON.stringify({
          providers: [
            { name: 'openai-work', id: 'provider-id', type: 'openai', workspace: 'mitzo' },
          ],
          next_page_token: '',
        });
      if (args.includes('get'))
        return JSON.stringify({
          ...JSON.parse(ready('Ready', 'state-v2-none')),
          name: sandboxNameForConversation('conversation'),
          workspace: 'mitzo',
        });
      if (args.includes('provider') && args.includes('list'))
        return JSON.stringify({
          providers: attached ? [{ name: 'openai-work', type: 'openai' }] : [],
          next_page_token: '',
        });
      if (args.includes('attach')) {
        attached = true;
        return '{}';
      }
      return '{}';
    });
    const manager = new OpenShellRuntimeManager(
      {
        ...config,
        cliContract: 'v0.1',
        serviceProviders: [],
        grantableServiceProviders: [],
        accountProviderBindings: [{ name: 'openai-work', type: 'openai', id: 'provider-id' }],
        verifyAccountProviderUnion: () => undefined,
      },
      run,
    );
    await manager.ensure('conversation', new AbortController().signal);
    const attach = commands.find((args) => args.includes('attach'))!;
    expect(attach).toEqual(
      expect.arrayContaining(['--workspace', 'mitzo', 'openai-work', '--wait', '--output', 'json']),
    );
    expect(commands.filter((args) => args.includes('attach'))).toHaveLength(1);
  });
  it('reads all 0.1 attachment pages before accepting a retained seat', async () => {
    const attachmentPages: string[][] = [];
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'provider')
        return JSON.stringify({
          providers: [
            { name: 'openai-work', id: 'provider-id', type: 'openai', workspace: 'mitzo' },
          ],
          next_page_token: '',
        });
      if (args.includes('get'))
        return JSON.stringify({
          ...JSON.parse(ready('Ready', 'state-v2-none')),
          name: sandboxNameForConversation('conversation'),
          workspace: 'mitzo',
        });
      if (args.includes('provider') && args.includes('list')) {
        attachmentPages.push([...args]);
        return args.includes('--page-token')
          ? JSON.stringify({
              providers: [{ name: 'vertex-work', type: 'google-vertex-ai' }],
              next_page_token: '',
            })
          : JSON.stringify({
              providers: [{ name: 'openai-work', type: 'openai' }],
              next_page_token: 'next',
            });
      }
      return '{}';
    });
    const manager = new OpenShellRuntimeManager(
      {
        ...config,
        cliContract: 'v0.1',
        serviceProviders: [],
        grantableServiceProviders: [],
        accountProviderBindings: [{ name: 'openai-work', type: 'openai', id: 'provider-id' }],
        verifyAccountProviderUnion: () => undefined,
      },
      run,
    );
    await expect(manager.ensure('conversation', new AbortController().signal)).rejects.toThrow(
      /another provider attachment/,
    );
    expect(attachmentPages).toHaveLength(2);
    expect(attachmentPages[1]).toEqual(expect.arrayContaining(['--page-token', 'next']));
  });
  it.each([
    ['bare array', JSON.stringify([{ name: 'openai-work', type: 'openai' }])],
    ['missing token', JSON.stringify({ providers: [{ name: 'openai-work', type: 'openai' }] })],
    [
      'malformed row',
      JSON.stringify({ providers: [{ name: 'openai-work' }], next_page_token: '' }),
    ],
  ])('rejects a 0.1 attachment inventory with %s', async (_case, inventory) => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'provider')
        return JSON.stringify({
          providers: [
            { name: 'openai-work', id: 'provider-id', type: 'openai', workspace: 'mitzo' },
          ],
          next_page_token: '',
        });
      if (args.includes('get'))
        return JSON.stringify({
          ...JSON.parse(ready('Ready', 'state-v2-none')),
          name: sandboxNameForConversation('conversation'),
          workspace: 'mitzo',
        });
      if (args.includes('provider') && args.includes('list')) return inventory;
      return '{}';
    });
    const manager = new OpenShellRuntimeManager(
      {
        ...config,
        cliContract: 'v0.1',
        serviceProviders: [],
        grantableServiceProviders: [],
        accountProviderBindings: [{ name: 'openai-work', type: 'openai', id: 'provider-id' }],
        verifyAccountProviderUnion: () => undefined,
      },
      run,
    );
    await expect(manager.ensure('conversation', new AbortController().signal)).rejects.toThrow();
    expect(run).not.toHaveBeenCalledWith(expect.arrayContaining(['attach']), expect.anything());
  });
  it('rejects a repeating 0.1 attachment page token', async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'provider')
        return JSON.stringify({
          providers: [
            { name: 'openai-work', id: 'provider-id', type: 'openai', workspace: 'mitzo' },
          ],
          next_page_token: '',
        });
      if (args.includes('get'))
        return JSON.stringify({
          ...JSON.parse(ready('Ready', 'state-v2-none')),
          name: sandboxNameForConversation('conversation'),
          workspace: 'mitzo',
        });
      if (args.includes('provider') && args.includes('list'))
        return JSON.stringify({
          providers: [{ name: 'openai-work', type: 'openai' }],
          next_page_token: 'same',
        });
      return '{}';
    });
    const manager = new OpenShellRuntimeManager(
      {
        ...config,
        cliContract: 'v0.1',
        serviceProviders: [],
        grantableServiceProviders: [],
        accountProviderBindings: [{ name: 'openai-work', type: 'openai', id: 'provider-id' }],
        verifyAccountProviderUnion: () => undefined,
      },
      run,
    );
    await expect(manager.ensure('conversation', new AbortController().signal)).rejects.toThrow(
      /pagination repeated a token/,
    );
    expect(run).not.toHaveBeenCalledWith(expect.arrayContaining(['attach']), expect.anything());
  });
  it('rejects the legacy subscription route before any 0.1 CLI call', async () => {
    const run = vi.fn();
    expect(
      () =>
        new OpenShellRuntimeManager(
          {
            ...config,
            cliContract: 'v0.1',
            serviceProviders: [],
            grantableServiceProviders: [],
            accountProviderBindings: [
              { name: 'personal-chatgpt', type: 'openai-codex-oauth', id: 'provider-object-1' },
            ],
            account: {
              kind: 'chatgpt-subscription',
              provider: 'personal-chatgpt',
              providerType: 'openai-codex-oauth',
              providerId: 'provider-object-1',
              grantId: 'grant-generation-1',
              model: 'gpt-test',
            },
          },
          run,
        ),
    ).toThrow(/exactly one account provider/);
    expect(run).not.toHaveBeenCalled();
  });
  it('uses opaque 0.1 sandbox page tokens for workspace-scoped inventory', async () => {
    const requests: string[][] = [];
    const run = vi.fn(async (args: readonly string[]) => {
      requests.push([...args]);
      return args.includes('--page-token')
        ? JSON.stringify({
            sandboxes: [
              {
                name: 'seat',
                phase: 'Ready',
                workspace: 'mitzo',
                labels: {
                  'mitzo.conversation': owner,
                  'mitzo.account_provider': 'openai-work',
                },
              },
            ],
            next_page_token: '',
          })
        : JSON.stringify({ sandboxes: [], next_page_token: 'next' });
    });
    const manager = new OpenShellRuntimeManager(
      {
        ...config,
        cliContract: 'v0.1',
        serviceProviders: [],
        grantableServiceProviders: [],
        accountProviderBindings: [{ name: 'openai-work', type: 'openai', id: 'provider-id' }],
        verifyAccountProviderUnion: () => undefined,
      },
      run,
    );
    expect(
      (await manager.inventory(new AbortController().signal)).map((item) => item.name),
    ).toEqual(['seat']);
    expect(requests[1]).toEqual(
      expect.arrayContaining(['--workspace', 'mitzo', '--page-token', 'next']),
    );
    expect(requests[0]).not.toContain('--offset');
  });
  it('verifies and attaches an explicitly bound second inference provider in one sandbox', async () => {
    const commands: string[][] = [];
    let created = false;
    const run = vi.fn(async (args: readonly string[]) => {
      commands.push([...args]);
      if (args[0] === 'provider' && args.includes('list'))
        return JSON.stringify([
          { name: 'openai-work', type: 'openai', id: 'openai-provider-id', workspace: 'mitzo' },
          {
            name: 'vertex-work',
            type: 'google-vertex-ai',
            id: 'vertex-provider-id',
            workspace: 'mitzo',
          },
        ]);
      if (args[0] === 'sandbox' && args.includes('provider') && args.includes('list'))
        return providerList(sandboxNameForConversation('conversation'), [
          'openai-work',
          'github',
          'vertex-work',
        ]);
      if (args.includes('get')) {
        if (!created) throw new Error('sandbox not found');
        return ready();
      }
      if (args.includes('create')) {
        created = true;
        return '{}';
      }
      return ready();
    });
    const manager = new OpenShellRuntimeManager(
      {
        ...config,
        verifyAccountProviderUnion: () => {},
        accountProviderBindings: [
          { name: 'openai-work', type: 'openai', id: 'openai-provider-id' },
          { name: 'vertex-work', type: 'google-vertex-ai', id: 'vertex-provider-id' },
        ],
      },
      run,
    );
    await manager.ensure('conversation', new AbortController().signal);
    const create = commands.find((args) => args.includes('create'))!;
    expect(create.filter((_, index) => create[index - 1] === '--provider')).toEqual([
      'openai-work',
      'github',
      'vertex-work',
    ]);
    expect(create).not.toContain('--inference-provider');
    expect(create).not.toContain('--inference-model');
  });

  it('rejects a changed second account provider before creating a sandbox', async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'provider' && args.includes('list'))
        return JSON.stringify([
          { name: 'openai-work', type: 'openai', id: 'openai-provider-id', workspace: 'mitzo' },
          { name: 'vertex-work', type: 'google-vertex-ai', id: 'wrong-id', workspace: 'mitzo' },
        ]);
      throw new Error('No sandbox operation should occur');
    });
    const manager = new OpenShellRuntimeManager(
      {
        ...config,
        verifyAccountProviderUnion: () => {},
        accountProviderBindings: [
          { name: 'openai-work', type: 'openai', id: 'openai-provider-id' },
          { name: 'vertex-work', type: 'google-vertex-ai', id: 'vertex-provider-id' },
        ],
      },
      run,
    );
    await expect(manager.ensure('conversation', new AbortController().signal)).rejects.toThrow(
      /account provider/i,
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reconciles a changed account union on the same retained owner sandbox', async () => {
    let created = false;
    const attached = new Set<string>();
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'provider' && args.includes('list'))
        return JSON.stringify([
          { name: 'openai-work', type: 'openai', id: 'openai-provider-id', workspace: 'mitzo' },
          {
            name: 'vertex-work',
            type: 'google-vertex-ai',
            id: 'vertex-provider-id',
            workspace: 'mitzo',
          },
        ]);
      if (args.includes('get')) {
        if (!created) throw new Error('sandbox not found');
        return ready();
      }
      if (args.includes('create')) {
        created = true;
        args.forEach((value, index) => {
          if (args[index - 1] === '--provider') attached.add(value);
        });
        return '{}';
      }
      if (args.includes('attach')) attached.add(args.at(-1)!);
      if (args.includes('detach')) attached.delete(args.at(-1)!);
      if (args[0] === 'sandbox' && args.includes('provider') && args.includes('list'))
        return providerList(sandboxNameForConversation('conversation'), [...attached]);
      return '{}';
    });
    const owner = { name: 'openai-work', type: 'openai', id: 'openai-provider-id' };
    const vertex = { name: 'vertex-work', type: 'google-vertex-ai', id: 'vertex-provider-id' };
    const signal = new AbortController().signal;
    await new OpenShellRuntimeManager(
      { ...config, verifyAccountProviderUnion: () => {}, accountProviderBindings: [owner] },
      run,
    ).ensure('conversation', signal);
    expect([...attached].sort()).toEqual(['github', 'openai-work']);
    await new OpenShellRuntimeManager(
      { ...config, verifyAccountProviderUnion: () => {}, accountProviderBindings: [owner, vertex] },
      run,
    ).ensure('conversation', signal);
    expect([...attached].sort()).toEqual(['github', 'openai-work', 'vertex-work']);
    await new OpenShellRuntimeManager(
      { ...config, verifyAccountProviderUnion: () => {}, accountProviderBindings: [owner] },
      run,
    ).ensure('conversation', signal);
    expect([...attached].sort()).toEqual(['github', 'openai-work']);
    expect(
      run.mock.calls.some(([args]) => args.includes('detach') && args.includes('vertex-work')),
    ).toBe(true);
  });
  it.each(['failure', 'unconfirmed'] as const)(
    'retries an obsolete account detach after %s across manager restart',
    async (failureMode) => {
      let created = false;
      const attached = new Set<string>();
      let failDetach = true;
      const run = vi.fn(async (args: readonly string[]) => {
        if (args[0] === 'provider' && args.includes('list'))
          return JSON.stringify([
            { name: 'openai-work', type: 'openai', id: 'openai-provider-id', workspace: 'mitzo' },
            {
              name: 'vertex-work',
              type: 'google-vertex-ai',
              id: 'vertex-provider-id',
              workspace: 'mitzo',
            },
          ]);
        if (args.includes('get')) {
          if (!created) throw new Error('sandbox not found');
          return ready();
        }
        if (args.includes('create')) {
          created = true;
          args.forEach((value, index) => {
            if (args[index - 1] === '--provider') attached.add(value);
          });
          return '{}';
        }
        if (args.includes('attach')) attached.add(args.at(-1)!);
        if (args.includes('detach')) {
          if (failDetach) {
            if (failureMode === 'failure') throw new Error('gateway temporarily unavailable');
          } else attached.delete(args.at(-1)!);
        }
        if (args[0] === 'sandbox' && args.includes('provider') && args.includes('list'))
          return providerList(sandboxNameForConversation('conversation'), [...attached]);
        return '{}';
      });
      const owner = { name: 'openai-work', type: 'openai', id: 'openai-provider-id' };
      const vertex = { name: 'vertex-work', type: 'google-vertex-ai', id: 'vertex-provider-id' };
      const signal = new AbortController().signal;
      await new OpenShellRuntimeManager(
        { ...config, verifyAccountProviderUnion: () => {}, accountProviderBindings: [owner] },
        run,
      ).ensure('conversation', signal);
      expect([...attached].sort()).toEqual(['github', 'openai-work']);
      await new OpenShellRuntimeManager(
        {
          ...config,
          verifyAccountProviderUnion: () => {},
          accountProviderBindings: [owner, vertex],
        },
        run,
      ).ensure('conversation', signal);
      expect([...attached].sort()).toEqual(['github', 'openai-work', 'vertex-work']);
      const reducedConfig = {
        ...config,
        verifyAccountProviderUnion: () => {},
        accountProviderBindings: [owner],
      };
      await expect(
        new OpenShellRuntimeManager(reducedConfig, run).ensure('conversation', signal),
      ).rejects.toThrow(
        failureMode === 'failure' ? /reconciliation failed/ : /attachments are not confirmed/,
      );
      const policyPath = join(
        privateRoot,
        'openshell-provider-policy',
        `${sandboxNameForConversation('conversation')}.json`,
      );
      expect(JSON.parse(readFileSync(policyPath, 'utf8'))).toEqual({
        automatic: ['github'],
        granted: [],
        pendingDetach: ['vertex-work'],
      });
      expect(attached.has('vertex-work')).toBe(true);
      failDetach = false;
      // A fresh manager must recover using the durable file, not process-local history.
      await new OpenShellRuntimeManager(reducedConfig, run).ensure('conversation', signal);
      expect([...attached].sort()).toEqual(['github', 'openai-work']);
      expect(JSON.parse(readFileSync(policyPath, 'utf8'))).toEqual({
        automatic: ['github'],
        granted: [],
      });
      expect(
        run.mock.calls.some(([args]) => args.includes('detach') && args.includes('vertex-work')),
      ).toBe(true);
    },
  );
  it('cannot confirm a stale union after a delayed attach and lets the new revision clean it up', async () => {
    let created = false;
    let revision = 1;
    const attached = new Set<string>();
    let resolveStarted!: () => void;
    let releaseAttach!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'provider' && args.includes('list'))
        return JSON.stringify([
          { name: 'openai-work', type: 'openai', id: 'openai-provider-id', workspace: 'mitzo' },
          {
            name: 'vertex-work',
            type: 'google-vertex-ai',
            id: 'vertex-provider-id',
            workspace: 'mitzo',
          },
        ]);
      if (args.includes('get')) {
        if (!created) throw new Error('sandbox not found');
        return ready();
      }
      if (args.includes('create')) {
        created = true;
        args.forEach((value, index) => {
          if (args[index - 1] === '--provider') attached.add(value);
        });
        return '{}';
      }
      if (args.includes('attach')) {
        resolveStarted();
        await delayed;
        attached.add(args.at(-1)!);
      }
      if (args.includes('detach')) attached.delete(args.at(-1)!);
      if (args[0] === 'sandbox' && args.includes('provider') && args.includes('list'))
        return providerList(sandboxNameForConversation('conversation'), [...attached]);
      return '{}';
    });
    const owner = { name: 'openai-work', type: 'openai', id: 'openai-provider-id' };
    const vertex = { name: 'vertex-work', type: 'google-vertex-ai', id: 'vertex-provider-id' };
    const configFor = (expected: number, bindings: (typeof owner)[]) => ({
      ...config,
      accountProviderBindings: bindings,
      verifyAccountProviderUnion: () => {
        if (revision !== expected) throw new Error('Symposium provider union revision changed');
      },
    });
    const signal = new AbortController().signal;
    await new OpenShellRuntimeManager(configFor(1, [owner]), run).ensure('conversation', signal);
    revision = 2;
    const stale = new OpenShellRuntimeManager(configFor(2, [owner, vertex]), run).ensure(
      'conversation',
      signal,
    );
    await started;
    revision = 3;
    releaseAttach();
    await expect(stale).rejects.toThrow(/union revision changed/i);
    expect(attached.has('vertex-work')).toBe(true);
    await new OpenShellRuntimeManager(configFor(3, [owner]), run).ensure('conversation', signal);
    expect(attached.has('vertex-work')).toBe(false);
  });
  it('rejects a grantable account provider before any runtime call', () => {
    const run = vi.fn();
    expect(
      () =>
        new OpenShellRuntimeManager(
          {
            ...config,
            account: { kind: 'api', provider: 'github', model: 'test-model' },
            grantableServiceProviders: ['github'],
          },
          run,
        ),
    ).toThrow('account provider cannot also be grantable: github');
    expect(run).not.toHaveBeenCalled();
  });

  it('derives a stable non-revealing sandbox identity', () => {
    expect(sandboxNameForConversation('private-conversation-name')).toMatch(/^mitzo-[a-f0-9]{13}$/);
    expect(sandboxNameForConversation('private-conversation-name')).toHaveLength(19);
    expect(sandboxNameForConversation('private-conversation-name')).not.toContain('private');
  });

  it('uploads the MGMT seed to the canonical Jira runtime workspace and attaches broker providers', async () => {
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
    expect(create).not.toContain('/seed/mgmt:/sandbox/workspaces/mgmt');
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

  it('keeps reviewed on-demand custom providers detached until an explicit grant', async () => {
    const customProvider = 'mitzo-conn-12345678';
    const attached = new Set(['github']);
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return ready();
      if (args.includes('provider') && args.includes('list'))
        return providerList(sandboxNameForConversation('conversation'), [...attached]);
      if (args.includes('attach')) attached.add(args.at(-1)!);
      return '{}';
    });
    const manager = new OpenShellRuntimeManager(
      { ...config, grantableServiceProviders: [customProvider] },
      run,
    );
    const signal = new AbortController().signal;
    const runtime = await manager.ensure('conversation', signal);
    expect(attached).not.toContain(customProvider);
    expect(
      run.mock.calls.some(([args]) => args.includes('attach') && args.includes(customProvider)),
    ).toBe(false);

    await manager.grantServiceProvider('conversation', runtime, customProvider, signal);
    expect(attached).toContain(customProvider);
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
    const sandboxName = sandboxNameForConversation('conversation');
    const readyRun = vi.fn(async (args: readonly string[]) =>
      args.includes('provider') && args.includes('list')
        ? providerList(sandboxName, ['github'])
        : ready(),
    );
    await new OpenShellRuntimeManager(config, readyRun).ensure(
      'conversation',
      new AbortController().signal,
    );
    expect(readyRun).toHaveBeenCalledTimes(2);

    const stopped = vi
      .fn()
      .mockResolvedValueOnce(ready('Stopped'))
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(ready('Starting'))
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce(providerList(sandboxName, ['github']));
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
      vi.fn(async (args: readonly string[]) =>
        args.includes('provider') && args.includes('list')
          ? providerList(sandboxNameForConversation('conversation'), ['github'])
          : JSON.stringify(sandbox),
      ),
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
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return legacyPolicyReady;
      if (args.includes('provider') && args.includes('list'))
        return providerList(sandboxNameForConversation('conversation'), [
          'github',
          'google-workspace',
        ]);
      return '{}';
    });
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
    const attached = new Set(['github']);
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return ready('Ready', 'grant-v1');
      if (args.includes('attach')) attached.add(args.at(-1)!);
      if (args.includes('provider') && args.includes('list'))
        return `NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n${[...attached]
          .map((provider) => `${provider} service 0 0`)
          .join('\n')}`;
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
    expect(
      await manager.hasServiceProviderAccess('conversation', runtime, 'github', signal),
    ).toEqual({
      state: 'available',
    });
    expect(
      await manager.hasServiceProviderAccess('conversation', runtime, 'google-workspace', signal),
    ).toEqual({ state: 'absent' });
    await manager.grantServiceProvider('conversation', runtime, 'google-workspace', signal);
    expect(
      await manager.hasServiceProviderAccess('conversation', runtime, 'google-workspace', signal),
    ).toEqual({ state: 'available' });
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
    ).toHaveLength(0);
    expect(
      commands.filter((args) => args.includes('attach') && args.includes('google-workspace')),
    ).toHaveLength(1);
  });

  it('preserves an explicitly approved custom grant through file-state restart', async () => {
    const customProvider = 'mitzo-conn-12345678';
    const attached = new Set(['github']);
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return ready('Ready', 'custom-v1');
      if (args.includes('attach')) attached.add(args.at(-1)!);
      if (args.includes('provider') && args.includes('list'))
        return providerList(sandboxNameForConversation('conversation'), [...attached]);
      return '{}';
    });
    const customConfig = {
      ...config,
      serviceProviders: ['github'],
      grantableServiceProviders: [customProvider],
    };
    const signal = new AbortController().signal;
    const first = new OpenShellRuntimeManager(customConfig, run);
    const runtime = await first.ensure('conversation', signal);
    await first.grantServiceProvider('conversation', runtime, customProvider, signal);
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
    ).toEqual({ automatic: ['github'], granted: [customProvider] });

    await new OpenShellRuntimeManager(customConfig, run).ensure('conversation', signal);
    const commands = run.mock.calls.map(([args]) => args as readonly string[]);
    expect(
      commands.filter((args) => args.includes('detach') && args.includes(customProvider)),
    ).toHaveLength(0);
    expect(
      await new OpenShellRuntimeManager(customConfig, run).hasServiceProviderAccess(
        'conversation',
        runtime,
        customProvider,
        signal,
      ),
    ).toEqual({ state: 'available' });
  });

  it('requires a current attachment for a durable grant to be available', async () => {
    const attached = new Set<string>();
    const policyState = {
      read: vi.fn(() => ({ automatic: ['github'], granted: ['google-workspace'] })),
      write: vi.fn(),
    };
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return ready();
      if (args.includes('attach')) attached.add(args.at(-1)!);
      if (args.includes('provider') && args.includes('list'))
        return providerList(sandboxNameForConversation('conversation'), [...attached]);
      return '{}';
    });
    const manager = new OpenShellRuntimeManager(config, run, undefined, undefined, policyState);
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
      manager.hasServiceProviderAccess(
        'conversation',
        runtime,
        'google-workspace',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ state: 'approved-detached' });
    await manager.grantServiceProvider(
      'conversation',
      runtime,
      'google-workspace',
      new AbortController().signal,
    );
    expect(policyState.write).toHaveBeenLastCalledWith(sandboxNameForConversation('conversation'), {
      automatic: ['github'],
      granted: ['google-workspace'],
    });
    await expect(
      manager.hasServiceProviderAccess(
        'conversation',
        runtime,
        'google-workspace',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ state: 'available' });
  });

  it('verifies a Ready owned sandbox attachment for a durable grant', async () => {
    const policyState = {
      read: vi.fn(() => ({ automatic: ['github'], granted: ['google-workspace'] })),
      write: vi.fn(),
    };
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return ready();
      if (args.includes('provider') && args.includes('list'))
        return 'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\ngoogle-workspace service 0 0';
      return '{}';
    });
    const manager = new OpenShellRuntimeManager(config, run, undefined, undefined, policyState);
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
      manager.hasServiceProviderAccess(
        'conversation',
        runtime,
        'google-workspace',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ state: 'available' });
  });

  it('keeps unavailable, misbound, and unreadable provider state distinct from absence', async () => {
    const policyState = {
      read: vi.fn(() => ({ automatic: ['github'], granted: ['google-workspace'] })),
      write: vi.fn(),
    };
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

    await expect(
      new OpenShellRuntimeManager(
        config,
        vi.fn().mockResolvedValue(ready('Creating')),
        undefined,
        undefined,
        policyState,
      ).hasServiceProviderAccess('conversation', runtime, 'google-workspace', signal),
    ).resolves.toMatchObject({ state: 'indeterminate', error: expect.any(Error) });

    const foreign = JSON.parse(ready());
    foreign.labels['mitzo.conversation'] = 'different';
    await expect(
      new OpenShellRuntimeManager(
        config,
        vi.fn().mockResolvedValue(JSON.stringify(foreign)),
        undefined,
        undefined,
        policyState,
      ).hasServiceProviderAccess('conversation', runtime, 'google-workspace', signal),
    ).resolves.toMatchObject({ state: 'indeterminate', error: expect.any(Error) });

    const listFailure = new Error('provider list failed');
    const listFailingRun = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return ready();
      if (args.includes('provider') && args.includes('list')) throw listFailure;
      return '{}';
    });
    await expect(
      new OpenShellRuntimeManager(
        config,
        listFailingRun,
        undefined,
        undefined,
        policyState,
      ).hasServiceProviderAccess('conversation', runtime, 'google-workspace', signal),
    ).resolves.toEqual({ state: 'indeterminate', error: listFailure });
  });

  it('revokes a durable grant removed from administrator policy', async () => {
    let record = { automatic: ['github'], granted: ['google-workspace'] };
    const policyState = {
      read: vi.fn(() => record),
      write: vi.fn((_name: string, next: typeof record) => {
        record = next;
      }),
    };
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return ready();
      if (args.includes('provider') && args.includes('list'))
        return providerList(sandboxNameForConversation('conversation'), [
          'github',
          'google-workspace',
        ]);
      return '{}';
    });
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

  it('detaches an actual grantable provider without durable approval state', async () => {
    const record = { automatic: ['github'], granted: [] as string[] };
    const policyState = {
      read: vi.fn(() => record),
      write: vi.fn(),
    };
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return ready();
      if (args.includes('provider') && args.includes('list'))
        return providerList(sandboxNameForConversation('conversation'), [
          'github',
          'google-workspace',
        ]);
      return '{}';
    });

    await new OpenShellRuntimeManager(config, run, undefined, undefined, policyState).ensure(
      'conversation',
      new AbortController().signal,
    );

    expect(run.mock.calls.find(([args]) => args.includes('detach'))?.[0]).toContain(
      'google-workspace',
    );
    expect(policyState.write).toHaveBeenCalledWith(
      sandboxNameForConversation('conversation'),
      record,
    );
  });

  it('preserves an account provider that also has a managed service name', async () => {
    const sandboxName = sandboxNameForConversation('conversation');
    const accountSandbox = JSON.parse(ready());
    accountSandbox.labels['mitzo.account_provider'] = 'github';
    const policyState = {
      read: vi.fn(() => undefined),
      write: vi.fn(),
    };
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return JSON.stringify(accountSandbox);
      if (args.includes('provider') && args.includes('list'))
        return providerList(sandboxName, ['github', 'google-workspace']);
      return '{}';
    });

    await new OpenShellRuntimeManager(
      {
        ...config,
        account: { kind: 'api', provider: 'github', model: 'test-model' },
        // `github` names the account binding here, not an automatic service
        // grant. The stale Workspace attachment remains reconcilable.
        serviceProviders: ['github'],
      },
      run,
      undefined,
      undefined,
      policyState,
    ).ensure('conversation', new AbortController().signal);

    const detached = run.mock.calls
      .filter(([args]) => args.includes('detach'))
      .map(([args]) => args.at(-1));
    expect(detached).toEqual(['google-workspace']);
    expect(policyState.write).toHaveBeenCalledWith(sandboxName, {
      automatic: [],
      granted: [],
    });
  });

  it('fails retained reconciliation before mutating policy when provider listing fails', async () => {
    const listFailure = new Error('provider list failed');
    const policyState = {
      read: vi.fn(() => ({ automatic: ['github'], granted: ['google-workspace'] })),
      write: vi.fn(),
    };
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return ready();
      if (args.includes('provider') && args.includes('list')) throw listFailure;
      return '{}';
    });

    await expect(
      new OpenShellRuntimeManager(config, run, undefined, undefined, policyState).ensure(
        'conversation',
        new AbortController().signal,
      ),
    ).rejects.toBe(listFailure);
    expect(policyState.write).not.toHaveBeenCalled();
    expect(
      run.mock.calls.some(([args]) => args.includes('attach') || args.includes('detach')),
    ).toBe(false);
  });

  it('requires approval when an automatic provider becomes grantable', async () => {
    let record = { automatic: ['google-workspace', 'github'], granted: [] as string[] };
    const policyState = {
      read: vi.fn(() => record),
      write: vi.fn((_name: string, next: typeof record) => {
        record = next;
      }),
    };
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return ready();
      if (args.includes('provider') && args.includes('list'))
        return providerList(sandboxNameForConversation('conversation'), [
          'github',
          'google-workspace',
        ]);
      return '{}';
    });
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

  it('records an approved grant before an attach crash and repairs it on a fresh ensure', async () => {
    let record: { automatic: string[]; granted: string[] } | undefined;
    const events: string[] = [];
    const policyState = {
      read: vi.fn(() => record),
      write: vi.fn((_name: string, next: NonNullable<typeof record>) => {
        events.push('write');
        record = next;
      }),
    };
    const runtime = {
      sandboxName: sandboxNameForConversation('conversation'),
      workdir: config.workdir,
      appServerCommand: '/sandbox/run-mitzo-app-server' as const,
      cli: config.cli,
      gateway: config.gateway,
      workspace: config.workspace,
      gatewayInsecure: false,
    };
    const crashingRun = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return ready();
      if (args.includes('attach')) {
        events.push('attach');
        throw new Error('connection dropped during attach');
      }
      return '{}';
    });

    await expect(
      new OpenShellRuntimeManager(
        config,
        crashingRun,
        undefined,
        undefined,
        policyState,
      ).grantServiceProvider(
        'conversation',
        runtime,
        'google-workspace',
        new AbortController().signal,
      ),
    ).rejects.toThrow('grant failed');
    expect(events).toEqual(['write', 'attach']);
    expect(record).toEqual({ automatic: ['github'], granted: ['google-workspace'] });

    const attached = new Set(['github']);
    const recoveredRun = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return ready();
      if (args.includes('attach')) attached.add(args.at(-1)!);
      if (args.includes('provider') && args.includes('list'))
        return `NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n${[...attached]
          .map((provider) => `${provider} service 0 0`)
          .join('\n')}`;
      return '{}';
    });
    const recovered = new OpenShellRuntimeManager(
      config,
      recoveredRun,
      undefined,
      undefined,
      policyState,
    );
    await expect(
      recovered.hasServiceProviderAccess(
        'conversation',
        runtime,
        'google-workspace',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ state: 'approved-detached' });
    const recoveredRuntime = await recovered.ensure('conversation', new AbortController().signal);
    expect(recoveredRun.mock.calls.some(([args]) => args.includes('attach'))).toBe(true);
    await expect(
      recovered.hasServiceProviderAccess(
        'conversation',
        recoveredRuntime,
        'google-workspace',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ state: 'available' });
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
    const attached = new Set(['github']);
    const run = vi.fn(async (args: readonly string[]) => {
      commands.push(args);
      if (args.includes('get')) return ready();
      if (args.includes('provider') && args.includes('list'))
        return providerList(sandboxNameForConversation('conversation'), [...attached]);
      if (args.includes('attach') && args.at(-1) === 'google-workspace') {
        await attach;
        attached.add('google-workspace');
      }
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
      .mockResolvedValueOnce(ready('Error'))
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
    const manager = new OpenShellRuntimeManager(
      config,
      grantRun,
      undefined,
      undefined,
      policyState,
    );
    await expect(
      manager.grantServiceProvider(
        'conversation',
        runtime,
        'google-workspace',
        new AbortController().signal,
      ),
    ).rejects.toThrow('is Error');
    expect(record.granted).toEqual(['google-workspace']);
    await expect(
      manager.hasServiceProviderAccess(
        'conversation',
        runtime,
        'google-workspace',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ state: 'indeterminate', error: expect.any(Error) });

    const reconcileRun = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) return ready();
      if (args.includes('provider') && args.includes('list'))
        return providerList(sandboxNameForConversation('conversation'), [
          'github',
          'google-workspace',
        ]);
      return '{}';
    });
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
    let getCalls = 0;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('get')) {
        getCalls += 1;
        if (getCalls === 1) throw new Error('sandbox not found');
        return legacyReady;
      }
      if (args.includes('provider') && args.includes('list'))
        return providerList(`mitzo-${legacyOwner.slice(0, 24)}`, []);
      return '{}';
    });

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

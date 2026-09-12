import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectionStore, type Connection } from '../connections-store.js';
import { ConnectionsService } from '../connections-service.js';
import type { ConnectionGateway, GatewayProvider } from '../connections-gateway.js';
import { OpenShellRuntimeManager } from '../openshell-runtime.js';

const provider = (name: string): GatewayProvider => ({
  id: `provider-${name}`,
  name,
  workspace: 'default',
  type: 'jira-readonly',
  credentialKeys: ['JIRA_API_TOKEN'],
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'connections-runtime-'));
  const store = new ConnectionStore(join(directory, 'connections.db'));
  const providers = new Map<string, GatewayProvider>();
  const sandboxProviders = new Map<string, string[]>();
  const sandboxes = new Map<
    string,
    { name: string; phase: string; labels: Record<string, string> }
  >();
  const gateway: ConnectionGateway = {
    verifyCompatibility: vi.fn(),
    provision: vi.fn(async ({ name }) => {
      const value = provider(name);
      providers.set(name, value);
      return value;
    }),
    rotate: vi.fn(),
    get: vi.fn(async (name) => providers.get(name)),
    list: vi.fn(async () => [...providers.values()]),
    delete: vi.fn(async (name) => {
      providers.delete(name);
    }),
    attachments: vi.fn(async (name) =>
      [...sandboxProviders.entries()]
        .filter(([, names]) => names.includes(name))
        .map(([sandbox]) => sandbox),
    ),
    stopSandbox: vi.fn(async () => {}),
    sandboxStopped: vi.fn(async () => true),
    detach: vi.fn(async (sandbox, name) => {
      sandboxProviders.set(
        sandbox,
        (sandboxProviders.get(sandbox) ?? []).filter((item) => item !== name),
      );
    }),
    probe: vi.fn(async () => ({ identity: 'operator@example.test' })),
    deleteSandbox: vi.fn(async () => {}),
    sandbox: vi.fn(async (name) => sandboxes.get(name)),
    sandboxProviders: vi.fn(async (name) => sandboxProviders.get(name) ?? []),
  };
  const service = new ConnectionsService(store, gateway, { eligibleAccountIds: () => ['work'] });
  const createActive = () => {
    const created = store.create({
      ownerId: 'operator',
      templateId: 'jira-readonly',
      templateVersion: 1,
      label: 'Jira',
      endpoint: 'https://redhat.atlassian.net',
      gatewayProviderName: 'mitzo-conn-12345678',
      desiredAccountIds: ['work'],
      submittedEmail: 'operator@example.test',
    });
    const current = provider(created.gatewayProviderName);
    providers.set(current.name, current);
    return store.transition(
      created.id,
      created.revision,
      {
        status: 'active',
        gatewayProviderId: current.id,
        identity: 'operator@example.test',
        verifiedAt: Date.now(),
      },
      { operation: 'provision', outcome: 'success', actor: 'operator' },
    );
  };
  return { directory, store, service, gateway, sandboxes, sandboxProviders, createActive };
}

describe('connections runtime integration', () => {
  const cleanups: Array<ReturnType<typeof setup>> = [];
  afterEach(() => {
    for (const item of cleanups.splice(0)) {
      item.store.close();
      rmSync(item.directory, { recursive: true, force: true });
    }
  });

  it('permits a provider for a new conversation but rejects retained sandbox grant drift', async () => {
    const test = setup();
    cleanups.push(test);
    const connection = test.createActive();
    let granted: Connection | null = null;
    await test.service.withAccountRuntime('work', async (resolved) => {
      granted = resolved;
      await test.service.verifyRuntimeSandbox(
        'new-conversation',
        resolved,
        AbortSignal.timeout(500),
      );
    });
    expect((granted as Connection | null)?.gatewayProviderName).toBe(
      connection.gatewayProviderName,
    );

    test.sandboxes.set('retained', { name: 'retained', phase: 'Ready', labels: {} });
    test.sandboxProviders.set('retained', []);
    await expect(
      test.service.verifyRuntimeSandbox('retained', connection, AbortSignal.timeout(500)),
    ).rejects.toThrow('permissions changed');
  });

  it('serializes revoke behind an in-flight runtime ensure callback', async () => {
    const test = setup();
    cleanups.push(test);
    const connection = test.createActive();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ensuring = test.service.withAccountRuntime('work', async (resolved) => {
      expect(resolved?.id).toBe(connection.id);
      await gate;
    });
    await vi.waitFor(() => expect(test.gateway.get).toHaveBeenCalled());
    const revoking = test.service.revoke(
      connection.id,
      connection.revision,
      'operator',
      AbortSignal.timeout(500),
    );
    await Promise.resolve();
    expect(test.gateway.delete).not.toHaveBeenCalled();
    release();
    await ensuring;
    await expect(revoking).resolves.toMatchObject({ status: 'revoked' });
  });

  it('checks provider attachments again on a fresh reconnect and rejects stale managed access', async () => {
    const test = setup();
    cleanups.push(test);
    const connection = test.createActive();
    test.sandboxes.set('reconnect', { name: 'reconnect', phase: 'Ready', labels: {} });
    test.sandboxProviders.set('reconnect', [connection.gatewayProviderName]);
    await test.service.withAccountRuntime('work', async (resolved) => {
      await test.service.verifyRuntimeSandbox('reconnect', resolved, AbortSignal.timeout(500));
    });

    // A reconnect after revocation resolves no grant and must not accept the retained attachment.
    test.sandboxProviders.set('reconnect', [connection.gatewayProviderName]);
    await expect(
      test.service.verifyRuntimeSandbox('reconnect', null, AbortSignal.timeout(500)),
    ).rejects.toThrow('permissions changed');
  });

  it('checks actual attachments before and after create and labels the sandbox account', async () => {
    const checks: string[] = [];
    const owner = '8b34dbc2c05eb4d7e25d48efeace82456b16cee760bcae80c157f52a3c2e787';
    const ready = JSON.stringify({
      name: 'sandbox',
      phase: 'Ready',
      labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': 'openai-work' },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('sandbox not found'))
      .mockRejectedValueOnce(new Error('sandbox not found'))
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(ready);
    await new OpenShellRuntimeManager(
      {
        cli: '/opt/isolated/bin/openshell',
        image: 'mitzo-runtime:1',
        policy: '/config/policy.yaml',
        seed: '/seed/mgmt',
        serviceProviders: ['mitzo-conn-12345678'],
        workspace: 'default',
        gateway: 'local',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
        account: { kind: 'api', provider: 'openai-work', model: 'model' },
        connectionAccountId: 'work',
        verifyConnections: async (name) => {
          checks.push(name);
        },
      },
      run,
    ).ensure('conversation', AbortSignal.timeout(500));
    expect(checks).toHaveLength(2);
    const create = run.mock.calls[2][0] as string[];
    expect(create).toContain('mitzo.connection_account=work');
  });
});

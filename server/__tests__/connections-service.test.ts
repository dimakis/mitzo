import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { ConnectionStore } from '../connections-store.js';
import { ConnectionsService } from '../connections-service.js';
import {
  ConnectionProbeError,
  OpenShellConnectionGateway,
  customRestProfileId,
} from '../connections-gateway.js';
import { connectionTemplateRegistry } from '../connections/registry.js';

function jiraAdapter() {
  return {
    supportsTemplate: vi.fn(
      (templateId: string, templateVersion: number) =>
        templateId === 'jira-readonly' && templateVersion === 1,
    ),
    validateBinding: vi.fn(
      ({
        templateId,
        templateVersion,
        provider,
      }: {
        templateId: string;
        templateVersion: number;
        provider: { type: string; credentialKeys: string[] };
      }) => {
        if (
          templateId !== 'jira-readonly' ||
          templateVersion !== 1 ||
          provider.type !== 'jira-readonly' ||
          provider.credentialKeys.length !== 1 ||
          provider.credentialKeys[0] !== 'JIRA_API_TOKEN'
        )
          throw new Error('Managed provider credential binding changed');
      },
    ),
  };
}

describe('ConnectionsService', () => {
  it('keeps on-demand custom providers out of automatic selection and binds explicit grants', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const fields = {
      endpoint: 'https://api.openai.com:8443',
      port: '8443',
      protocol: 'rest',
      methods: ['GET'],
      paths: ['/v1/items'],
      credentialStyle: 'bearer-token',
      credentialLocation: 'header',
      credentialName: 'authorization',
      binaries: ['curl'],
      attachmentMode: 'on-demand',
      dnsPin: ['1.1.1.1'],
    };
    const policy = connectionTemplateRegistry.compileProviderPolicy({
      templateId: 'custom-rest-readonly',
      templateVersion: 1,
      fields,
    });
    const created = store.create({
      ownerId: 'operator',
      templateId: 'custom-rest-readonly',
      templateVersion: 1,
      label: 'Reviewed inventory API',
      endpoint: 'https://api.openai.com:8443',
      publicConfig: fields,
      gatewayProviderName: 'mitzo-conn-12345678',
      desiredAccountIds: ['work'],
    });
    const active = store.transition(
      created.id,
      created.revision,
      {
        status: 'active',
        gatewayProviderId: 'provider-1',
        identity: 'custom:api.openai.com',
        verifiedAt: Date.now(),
      },
      { operation: 'provision', outcome: 'success', actor: 'operator' },
    );
    const gateway = {
      verifyCompatibility: vi.fn(),
      validateBinding: vi.fn(),
      get: vi.fn().mockResolvedValue({
        id: 'provider-1',
        name: active.gatewayProviderName,
        workspace: 'default',
        type: customRestProfileId(policy),
        credentialKeys: ['MITZO_CUSTOM_API_TOKEN'],
      }),
      sandbox: vi.fn().mockResolvedValue({ name: 'sandbox' }),
      sandboxProviders: vi.fn().mockResolvedValue([active.gatewayProviderName]),
    };
    const service = new ConnectionsService(store, gateway as never);
    const signal = AbortSignal.timeout(500);

    // It remains invisible to the automatic account route.
    expect(service.resolveForAccount('work')).toBeNull();
    expect(service.onDemandForAccount('work')).toEqual([active]);
    // A physical attachment without a durable per-conversation grant fails closed.
    await expect(
      service.verifyRuntimeSandbox('sandbox', null, 'work', signal, [active], []),
    ).rejects.toThrow('Connection permissions changed');

    await expect(
      service.authorizeOnDemand(active.id, active.revision, 'work', signal),
    ).resolves.toMatchObject({ id: active.id, revision: active.revision });
    await expect(
      service.authorizeOnDemand(active.id, active.revision + 1, 'work', signal),
    ).rejects.toThrow('Connection changed');
    await expect(
      service.authorizeOnDemand(active.id, active.revision, 'other-account', signal),
    ).rejects.toThrow('no longer eligible');
    await expect(
      service.verifyRuntimeSandbox(
        'sandbox',
        null,
        'work',
        signal,
        [active],
        [active.gatewayProviderName],
      ),
    ).resolves.toBeUndefined();
    // Built-in grantable names never inflate the managed custom attachment
    // expectation for a retained sandbox.
    await expect(
      service.verifyRuntimeSandbox(
        'sandbox',
        null,
        'work',
        signal,
        [active],
        ['github', active.gatewayProviderName],
      ),
    ).resolves.toBeUndefined();
    expect(gateway.verifyCompatibility).toHaveBeenCalled();

    const rollback = vi.fn().mockResolvedValue(undefined);
    await expect(
      service.grantOnDemand(
        active.id,
        active.revision,
        'work',
        signal,
        async () => {
          // Simulate an out-of-band lifecycle mutation after physical attach;
          // the service must revalidate and revoke the just-created grant.
          store.transition(
            active.id,
            active.revision,
            { status: 'needs_attention' },
            { operation: 'test', outcome: 'changed', actor: 'operator' },
          );
        },
        rollback,
      ),
    ).rejects.toThrow('Connection changed');
    expect(rollback).toHaveBeenCalledOnce();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('provisions through the template-neutral contract and never persists request credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const gateway = {
      ...jiraAdapter(),
      verifyCompatibility: vi.fn(),
      provision: vi.fn(async ({ name }: { name: string }) => ({
        id: 'provider-1',
        name,
        workspace: 'default',
        type: 'jira-readonly',
        credentialKeys: ['JIRA_API_TOKEN'],
      })),
      rotate: vi.fn(),
      get: vi.fn().mockResolvedValue(undefined),
      list: vi.fn(),
      delete: vi.fn(),
      attachments: vi.fn().mockResolvedValue([]),
      stopSandbox: vi.fn(),
      sandboxStopped: vi.fn().mockResolvedValue(true),
      detach: vi.fn(),
      probe: vi.fn().mockResolvedValue({ identity: 'account-1' }),
      deleteSandbox: vi.fn().mockResolvedValue(undefined),
      sandbox: vi.fn(),
      sandboxProviders: vi.fn(),
    };
    const service = new ConnectionsService(store, gateway as never, {
      eligibleAccountIds: () => ['work'],
    });
    const connection = await service.createAndProvision(
      {
        ownerId: 'operator',
        templateId: 'jira-readonly',
        templateVersion: 1,
        label: 'Work Jira',
        fields: { email: 'person@example.test' },
        desiredAccountIds: ['work'],
      },
      { token: 'SENTINEL_PROVIDER_SECRET' },
      AbortSignal.timeout(500),
    );
    expect(connection).toMatchObject({
      templateId: 'jira-readonly',
      templateVersion: 1,
      endpoint: 'https://api.atlassian.com',
      publicConfig: { email: 'person@example.test' },
      submittedEmail: 'person@example.test',
      status: 'active',
    });
    expect(JSON.stringify(store.get(connection.id))).not.toContain('SENTINEL_PROVIDER_SECRET');
    expect(gateway.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'jira-readonly',
        templateVersion: 1,
        credentials: { token: 'SENTINEL_PROVIDER_SECRET' },
      }),
      expect.anything(),
    );
    expect(gateway.probe).toHaveBeenCalledWith(
      expect.objectContaining({ publicConfig: { email: 'person@example.test' } }),
      expect.anything(),
    );
    const database = new Database(join(dir, 'db'));
    const raw = {
      connections: database.prepare('SELECT * FROM connections').all(),
      audit: database.prepare('SELECT * FROM connection_audit').all(),
    };
    database.close();
    expect(JSON.stringify(raw)).not.toContain('SENTINEL_PROVIDER_SECRET');
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists canonical policy config rather than generic creation input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const gateway = {
      supportsTemplate: vi.fn(
        (templateId: string, templateVersion: number) =>
          templateId === 'github-readonly' && templateVersion === 1,
      ),
      validateBinding: vi.fn(),
      verifyCompatibility: vi.fn(),
      provision: vi.fn(async ({ name }: { name: string }) => ({
        id: 'provider-1',
        name,
        workspace: 'default',
        type: 'github',
        credentialKeys: ['GITHUB_TOKEN'],
      })),
      rotate: vi.fn(),
      get: vi.fn().mockResolvedValue(undefined),
      list: vi.fn(),
      delete: vi.fn(),
      attachments: vi.fn().mockResolvedValue([]),
      stopSandbox: vi.fn(),
      sandboxStopped: vi.fn().mockResolvedValue(true),
      detach: vi.fn(),
      probe: vi.fn().mockResolvedValue({ identity: 'account-1' }),
      deleteSandbox: vi.fn().mockResolvedValue(undefined),
      sandbox: vi.fn(),
      sandboxProviders: vi.fn(),
    };
    const service = new ConnectionsService(store, gateway as never);
    const connection = await service.createAndProvision(
      {
        ownerId: 'operator',
        templateId: 'github-readonly',
        templateVersion: 1,
        label: 'GitHub',
        fields: {
          allowedRepositories: ['Acme/Widget', 'acme/widget'],
          allowedBaseBranches: ['main', 'main'],
        },
        desiredAccountIds: [],
      },
      { token: 'SENTINEL_GITHUB_SECRET' },
      AbortSignal.timeout(500),
    );
    const canonical = {
      allowedRepositories: ['acme/widget'],
      allowedBaseBranches: ['main'],
    };
    expect(connection.publicConfig).toEqual(canonical);
    expect(store.get(connection.id)?.publicConfig).toEqual(canonical);
    expect(gateway.provision).toHaveBeenCalledWith(
      expect.objectContaining({ policy: expect.objectContaining({ publicConfig: canonical }) }),
      expect.anything(),
    );
    expect(JSON.stringify(store.get(connection.id))).not.toContain('SENTINEL_GITHUB_SECRET');
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects unknown public fields before gateway provisioning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const gateway = { provision: vi.fn() };
    const service = new ConnectionsService(store, gateway as never);
    await expect(
      service.createAndProvision(
        {
          ownerId: 'operator',
          templateId: 'jira-readonly',
          templateVersion: 1,
          label: 'Work Jira',
          fields: { email: 'person@example.test', injected: 'no' },
          desiredAccountIds: [],
        },
        { token: 'ok' },
        AbortSignal.timeout(500),
      ),
    ).rejects.toThrow();
    expect(gateway.provision).not.toHaveBeenCalled();
    expect(store.list('operator')).toEqual([]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects unknown credential keys before gateway provisioning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const gateway = { ...jiraAdapter(), provision: vi.fn() };
    const service = new ConnectionsService(store, gateway as never);
    await expect(
      service.createAndProvision(
        {
          ownerId: 'operator',
          templateId: 'jira-readonly',
          templateVersion: 1,
          label: 'Work Jira',
          fields: { email: 'person@example.test' },
          desiredAccountIds: [],
        },
        { token: 'ok', unexpected: 'SENTINEL_REJECTED' },
        AbortSignal.timeout(500),
      ),
    ).rejects.toThrow('Connection credentials are invalid');
    expect(gateway.provision).not.toHaveBeenCalled();
    expect(store.list('operator')).toEqual([]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['rotate', {}],
    ['rotate', { token: 'ok', unexpected: 'SENTINEL_EXTRA' }],
    ['retry', {}],
    ['retry', { token: 'ok', unexpected: 'SENTINEL_EXTRA' }],
  ] as const)(
    '%s rejects incomplete credential maps before any gateway or candidate action',
    async (method, credentials) => {
      const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
      const store = new ConnectionStore(join(dir, 'db'));
      const created = store.create({
        ownerId: 'operator',
        templateId: 'jira-readonly',
        templateVersion: 1,
        label: 'Jira',
        endpoint: 'https://redhat.atlassian.net',
        gatewayProviderName: 'mitzo-conn-12345678',
        submittedEmail: 'person@example.test',
        desiredAccountIds: [],
      });
      const active = store.transition(
        created.id,
        created.revision,
        { status: 'active', gatewayProviderId: 'provider-1', identity: 'account-1', verifiedAt: 1 },
        { operation: 'provision', outcome: 'success', actor: 'operator' },
      );
      const gateway = {
        verifyCompatibility: vi.fn(),
        provision: vi.fn(),
        rotate: vi.fn(),
        get: vi.fn(),
      };
      const service = new ConnectionsService(store, gateway as never);
      const operation =
        method === 'rotate'
          ? service.rotate(active.id, active.revision, credentials, AbortSignal.timeout(500))
          : service.retry(active.id, active.revision, credentials, AbortSignal.timeout(500));
      await expect(operation).rejects.toThrow('Connection credentials are invalid');
      expect(gateway.verifyCompatibility).not.toHaveBeenCalled();
      expect(gateway.get).not.toHaveBeenCalled();
      expect(gateway.provision).not.toHaveBeenCalled();
      expect(gateway.rotate).not.toHaveBeenCalled();
      expect(store.candidates()).toEqual([]);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  );

  it('does not create a row for a catalog template whose gateway adapter is not available', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const gateway = {
      supportsTemplate: vi.fn().mockReturnValue(false),
      provision: vi.fn(),
    };
    const service = new ConnectionsService(store, gateway as never);
    await expect(
      service.createAndProvision(
        {
          ownerId: 'operator',
          templateId: 'github-readonly',
          templateVersion: 1,
          label: 'GitHub',
          fields: {},
          desiredAccountIds: [],
        },
        { token: 'SENTINEL_GITHUB_SECRET' },
        AbortSignal.timeout(500),
      ),
    ).rejects.toThrow('Provider template is not available');
    expect(gateway.provision).not.toHaveBeenCalled();
    expect(store.list('operator')).toEqual([]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails closed when a gateway omits the template adapter contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const gateway = { provision: vi.fn() };
    const service = new ConnectionsService(store, gateway as never);
    await expect(
      service.createAndProvision(
        {
          ownerId: 'operator',
          templateId: 'jira-readonly',
          templateVersion: 1,
          label: 'Work Jira',
          fields: { email: 'person@example.test' },
          desiredAccountIds: [],
        },
        { token: 'SENTINEL_PROVIDER_SECRET' },
        AbortSignal.timeout(500),
      ),
    ).rejects.toThrow('Provider template is not available');
    expect(gateway.provision).not.toHaveBeenCalled();
    expect(store.list('operator')).toEqual([]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails closed when a gateway omits managed-provider binding validation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const created = store.create({
      ownerId: 'operator',
      templateId: 'jira-readonly',
      templateVersion: 1,
      label: 'Work Jira',
      endpoint: 'https://redhat.atlassian.net',
      gatewayProviderName: 'mitzo-conn-12345678',
      submittedEmail: 'person@example.test',
      desiredAccountIds: ['work'],
    });
    const active = store.transition(
      created.id,
      created.revision,
      {
        status: 'active',
        gatewayProviderId: 'provider-1',
        identity: 'person@example.test',
        verifiedAt: 1,
      },
      { operation: 'provision', outcome: 'success', actor: 'operator' },
    );
    const gateway = {
      supportsTemplate: vi.fn().mockReturnValue(true),
      get: vi.fn().mockResolvedValue({
        id: 'provider-1',
        name: active.gatewayProviderName,
        workspace: 'default',
        type: 'jira-readonly',
        credentialKeys: ['JIRA_API_TOKEN'],
      }),
    };
    const work = vi.fn();
    await expect(
      new ConnectionsService(store, gateway as never).withAccountRuntime(
        'work',
        work,
        AbortSignal.timeout(500),
      ),
    ).rejects.toThrow('Managed provider binding changed');
    expect(work).not.toHaveBeenCalled();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('retains a typed probe error after rotation candidate cleanup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const item = store.create({
      ownerId: 'operator',
      templateId: 'jira-readonly',
      templateVersion: 1,
      label: 'Jira',
      endpoint: 'https://redhat.atlassian.net',
      gatewayProviderName: 'mitzo-conn-12345678',
      desiredAccountIds: [],
      submittedEmail: 'person@example.test',
    });
    const active = store.transition(
      item.id,
      item.revision,
      { status: 'active', gatewayProviderId: 'p1', identity: 'account', verifiedAt: Date.now() },
      { operation: 'provision', outcome: 'success', actor: 'operator' },
    );
    const original = {
      id: 'p1',
      name: active.gatewayProviderName,
      workspace: 'default',
      type: 'jira-readonly',
      credentialKeys: ['JIRA_API_TOKEN'],
    };
    const gateway = {
      ...jiraAdapter(),
      verifyCompatibility: vi.fn(),
      provision: vi.fn(async ({ name }: { name: string }) => ({
        ...original,
        id: 'candidate',
        name,
      })),
      rotate: vi.fn(),
      get: vi.fn(async (name: string) =>
        name === active.gatewayProviderName ? original : undefined,
      ),
      list: vi.fn(),
      delete: vi.fn(),
      attachments: vi.fn().mockResolvedValue([]),
      stopSandbox: vi.fn(),
      sandboxStopped: vi.fn().mockResolvedValue(true),
      detach: vi.fn(),
      probe: vi.fn().mockRejectedValue(new ConnectionProbeError('JIRA_PERMISSION_DENIED')),
      deleteSandbox: vi.fn().mockResolvedValue(undefined),
      sandbox: vi.fn(),
      sandboxProviders: vi.fn(),
    };
    await expect(
      new ConnectionsService(store, gateway as never).rotate(
        active.id,
        active.revision,
        'token',
        AbortSignal.timeout(500),
      ),
    ).rejects.toThrow('rotation failed');
    expect(store.get(active.id)).toMatchObject({ errorCode: 'JIRA_PERMISSION_DENIED' });
    expect(store.candidates()).toEqual([]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('quarantines a typed probe failure, cleans it up, then records only its safe code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const item = store.create({
      ownerId: 'operator',
      templateId: 'jira-readonly',
      templateVersion: 1,
      label: 'Jira',
      endpoint: 'https://redhat.atlassian.net',
      gatewayProviderName: 'mitzo-conn-12345678',
      desiredAccountIds: [],
      submittedEmail: 'person@example.test',
    });
    const active = store.transition(
      item.id,
      item.revision,
      { status: 'active', gatewayProviderId: 'p1', identity: 'a', verifiedAt: Date.now() },
      { operation: 'provision', outcome: 'success', actor: 'operator' },
    );
    const gateway = {
      ...jiraAdapter(),
      verifyCompatibility: vi.fn(),
      provision: vi.fn(),
      rotate: vi.fn(),
      get: vi.fn().mockResolvedValue({
        id: 'p1',
        name: active.gatewayProviderName,
        workspace: 'default',
        type: 'jira-readonly',
        credentialKeys: ['JIRA_API_TOKEN'],
      }),
      list: vi.fn(),
      delete: vi.fn(),
      attachments: vi.fn().mockResolvedValue([]),
      stopSandbox: vi.fn(),
      sandboxStopped: vi.fn().mockResolvedValue(true),
      detach: vi.fn(),
      probe: vi.fn().mockRejectedValue(new ConnectionProbeError('JIRA_AUTH_REJECTED')),
      deleteSandbox: vi.fn().mockResolvedValue(undefined),
      sandbox: vi.fn(),
      sandboxProviders: vi.fn(),
    };
    await expect(
      new ConnectionsService(store, gateway as never).test(
        active.id,
        active.revision,
        AbortSignal.timeout(500),
      ),
    ).rejects.toThrow('verification failed');
    expect(gateway.deleteSandbox).toHaveBeenCalled();
    expect(store.get(active.id)).toMatchObject({ errorCode: 'JIRA_AUTH_REJECTED' });
    expect(store.pendingQuarantines()).toEqual([]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('finishes durable probe cleanup when the gateway authoritatively reports an absent sandbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const item = store.create({
      ownerId: 'operator',
      templateId: 'jira-readonly',
      templateVersion: 1,
      label: 'Jira',
      endpoint: 'https://redhat.atlassian.net',
      gatewayProviderName: 'mitzo-conn-12345678',
      desiredAccountIds: [],
    });
    store.startProbe(item, 'mitzo-probe-1234567890abcdef');
    const gateway = new OpenShellConnectionGateway(vi.fn().mockResolvedValue('[]'));
    await new ConnectionsService(store, gateway).reconcile(AbortSignal.timeout(500));
    expect(store.pendingProbes()).toEqual([]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('keeps cleanup pending when probe existence cannot be authoritatively read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const item = store.create({
      ownerId: 'operator',
      templateId: 'jira-readonly',
      templateVersion: 1,
      label: 'Jira',
      endpoint: 'https://redhat.atlassian.net',
      gatewayProviderName: 'mitzo-conn-12345678',
      desiredAccountIds: [],
    });
    store.startProbe(item, 'mitzo-probe-1234567890abcdef');
    const gateway = new OpenShellConnectionGateway(vi.fn().mockResolvedValue('not-json'));
    await new ConnectionsService(store, gateway).reconcile(AbortSignal.timeout(500));
    expect(store.pendingProbes()).toMatchObject([{ status: 'cleanup_pending' }]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('allows a retry after a failed provision when disposable probe cleanup sees absence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const adapter = new OpenShellConnectionGateway(vi.fn().mockResolvedValue('[]'));
    const gateway = {
      ...jiraAdapter(),
      verifyCompatibility: vi.fn(),
      provision: vi.fn().mockResolvedValue({
        id: 'provider-1',
        name: 'mitzo-conn-12345678',
        workspace: 'default',
        type: 'jira-readonly',
        credentialKeys: ['JIRA_API_TOKEN'],
      }),
      rotate: vi.fn(),
      get: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue({
          id: 'provider-1',
          name: 'mitzo-conn-12345678',
          workspace: 'default',
          type: 'jira-readonly',
          credentialKeys: ['JIRA_API_TOKEN'],
        }),
      list: vi.fn(),
      delete: vi.fn(),
      attachments: vi.fn(),
      stopSandbox: vi.fn(),
      sandboxStopped: vi.fn(),
      detach: vi.fn(),
      probe: vi
        .fn()
        .mockRejectedValueOnce(new Error('probe failed'))
        .mockResolvedValue({ identity: 'operator@example.test' }),
      deleteSandbox: adapter.deleteSandbox.bind(adapter),
      sandbox: vi.fn(),
      sandboxProviders: vi.fn(),
    };
    const service = new ConnectionsService(store, gateway);
    const input = {
      ownerId: 'operator',
      templateId: 'jira-readonly',
      templateVersion: 1,
      label: 'Jira',
      endpoint: 'https://redhat.atlassian.net',
      gatewayProviderName: 'mitzo-conn-12345678',
      desiredAccountIds: [],
      submittedEmail: 'operator@example.test',
    };
    await expect(
      service.createAndProvision(input, 'first-token', AbortSignal.timeout(500)),
    ).rejects.toThrow('provisioning failed');
    const failed = store.list('operator')[0]!;
    await expect(
      service.retry(failed.id, failed.revision, 'second-token', AbortSignal.timeout(500)),
    ).resolves.toMatchObject({ status: 'active', identity: 'operator@example.test' });
    expect(gateway.rotate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: failed.gatewayProviderName,
        templateId: 'jira-readonly',
        credentials: { token: 'second-token' },
      }),
      expect.anything(),
    );
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('does not mark failed provisioning active and retries revoke after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-service-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const item = store.create({
      ownerId: 'operator',
      templateId: 'jira-readonly',
      templateVersion: 1,
      label: 'Jira',
      endpoint: 'https://redhat.atlassian.net',
      gatewayProviderName: 'mitzo-conn-12345678',
      desiredAccountIds: [],
    });
    const gateway = {
      ...jiraAdapter(),
      verifyCompatibility: vi.fn(),
      provision: vi.fn().mockRejectedValue(new Error('untrusted CLI output')),
      rotate: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      sandbox: vi.fn(),
      sandboxProviders: vi.fn(),
      delete: vi.fn().mockRejectedValue(new Error('attached')),
      attachments: vi.fn().mockResolvedValue([]),
      stopSandbox: vi.fn(),
      sandboxStopped: vi.fn().mockResolvedValue(true),
      detach: vi.fn(),
      probe: vi.fn(),
      deleteSandbox: vi.fn(),
    };
    const service = new ConnectionsService(store, gateway);
    await expect(service.provision(item, 'SENTINEL', new AbortController().signal)).rejects.toThrow(
      'provisioning failed',
    );
    expect(store.get(item.id)?.status).toBe('needs_attention');
    const failed = store.get(item.id)!;
    gateway.get.mockResolvedValue({
      id: 'provider-1',
      name: item.gatewayProviderName,
      workspace: 'default',
      type: 'jira-readonly',
      credentialKeys: ['JIRA_API_TOKEN'],
    });
    gateway.delete.mockResolvedValue(undefined);
    await service.revoke(item.id, failed.revision, 'operator', new AbortController().signal);
    expect(store.get(item.id)?.status).toBe('revoked');
    expect(gateway.attachments).toHaveBeenCalledTimes(2);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

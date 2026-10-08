import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionStore } from '../connections-store.js';
import { ConnectionsService } from '../connections-service.js';
import { OpenShellRuntimeManager, type OpenShellRuntime } from '../openshell-runtime.js';
import { connectionTemplateRegistry } from '../connections/registry.js';
import { OpenShellConnectionGateway, renderCustomRestProfile } from '../connections-gateway.js';
import { base, fixture } from './fixtures/effective-runtime-policy.js';

const roots: string[] = [];
const stores: ConnectionStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function admissionFixture(
  templateId = 'jira-readonly',
  attachmentMode = 'automatic',
  graphql = false,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'managed-admission-')));
  roots.push(root);
  const store = new ConnectionStore(join(root, 'connections.db'));
  stores.push(store);
  const fields: Record<string, string | string[]> =
    templateId === 'jira-readonly'
      ? { email: 'reviewer@example.com' }
      : templateId === 'github-readonly'
        ? { allowedRepositories: ['example/widget'], allowedBaseBranches: ['main'] }
        : {
            endpoint: 'https://api.openai.com',
            port: '8443',
            protocol: graphql ? 'graphql' : 'rest',
            methods: graphql ? ['GRAPHQL_QUERY'] : ['GET', 'HEAD'],
            paths: graphql ? ['/graphql'] : ['/v1/**'],
            credentialStyle: 'api-token',
            credentialLocation: graphql ? 'query' : 'header',
            credentialName: graphql ? 'api_key' : 'x-api-key',
            binaries: ['curl', 'jq'],
            attachmentMode,
            dnsPin: ['1.1.1.1'],
          };
  const created = store.create({
    ownerId: 'operator',
    templateId,
    templateVersion: 1,
    label: 'Offline Jira',
    endpoint: 'https://api.atlassian.com',
    publicConfig: fields,
    gatewayProviderName: 'mitzo-conn-abcdef12',
    desiredAccountIds: ['offline'],
  });
  const connection = store.transition(
    created.id,
    created.revision,
    {
      status: 'active',
      gatewayProviderId: 'jira-physical',
      verifiedAt: 1,
      identity: 'offline',
    },
    { operation: 'offline-fixture', outcome: 'success', actor: 'operator' },
  );
  const data = fixture();
  // Independent gateway export bytes, not a profile synthesized by the attester.
  const compiled = connectionTemplateRegistry.compileProviderPolicy({
    templateId,
    templateVersion: 1,
    fields,
  });
  const profile = (
    templateId === 'custom-rest-readonly'
      ? load(renderCustomRestProfile(compiled).yaml)
      : load(
          readFileSync(
            new URL(
              templateId === 'github-readonly'
                ? '../../infra/openshell/providers/github-reviewed-profile.json'
                : '../../infra/openshell/providers/mitzo-jira-readonly.yaml',
              import.meta.url,
            ),
            'utf8',
          ),
        )
  ) as Record<string, unknown>;
  const builtin = templateId === 'github-readonly';
  profile.source = builtin ? 'builtin' : 'user';
  if (!builtin) {
    profile.scope = 'workspace';
    profile.resource_version = 3;
  }
  const jira = {
    name: connection.gatewayProviderName,
    id: connection.gatewayProviderId!,
    type: profile.id as string,
    profile,
  };
  const providers = [...data.providers, jira];
  data.observed.network_policies['_provider_mitzo_conn_abcdef12'] = {
    name: '_provider_mitzo_conn_abcdef12',
    endpoints: structuredClone(profile.endpoints) as Record<string, unknown>[],
    binaries: (profile.binaries as string[]).map((path) => ({ path })),
  };
  const conversation = 'offline-managed-admission';
  const owner = createHash('sha256').update(conversation).digest('hex').slice(0, 63);
  const runtime: OpenShellRuntime = {
    sandboxName: 'offline-sandbox',
    sandboxId: 'offline-physical',
    cli: 'offline-cli',
    workspace: 'default',
    gateway: 'offline-gateway',
    gatewayInsecure: false,
    workdir: '/sandbox/workspaces/mgmt',
    appServerCommand: '/sandbox/run-mitzo-app-server',
  };
  const verifier = new OpenShellConnectionGateway(
    async () => {
      throw new Error('Unexpected native verification command');
    },
    { workspace: 'default' },
  );
  const gateway = {
    sandbox: async () => ({ name: runtime.sandboxName }),
    sandboxProviders: async () => providers.map((provider) => provider.name),
    get: async () => ({
      ...jira,
      workspace: 'default',
      credentialKeys: [
        templateId === 'jira-readonly'
          ? 'JIRA_API_TOKEN'
          : templateId === 'github-readonly'
            ? 'GITHUB_TOKEN'
            : 'MITZO_CUSTOM_API_TOKEN',
      ],
      configKeys: [],
    }),
    validateBinding: verifier.validateBinding.bind(verifier),
    verifyCompatibility: async () => undefined,
  };
  const service = new ConnectionsService(store, gateway as never);
  const automatic = attachmentMode === 'automatic' ? [connection] : [];
  const approvals = {
    automatic: automatic.map((connection) => connection.gatewayProviderName),
    granted: attachmentMode === 'on-demand' ? [jira.name] : [],
  };
  const policyPath = new URL(
    '../../docs/spikes/openshell-codex/openshell-openai-api-policy.yaml',
    import.meta.url,
  );
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'sandbox' && args.includes('get'))
      return JSON.stringify({
        id: runtime.sandboxId,
        name: runtime.sandboxName,
        workspace: 'default',
        phase: 'Ready',
        resource_version: 1,
        policy_source: 'sandbox',
        policy: data.observed,
        labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': data.providers[0].name },
      });
    if (args[0] === 'sandbox' && args.includes('provider'))
      return (
        'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n' +
        providers.map((p) => `${p.name} ${p.type} 1 0`).join('\n')
      );
    if (args[0] === 'provider' && args.includes('list-profiles'))
      return JSON.stringify(providers.map((p) => p.profile));
    if (args[0] === 'provider' && args.includes('export'))
      return JSON.stringify(
        providers.find((p) => p.type === args[args.indexOf('export') + 1])!.profile,
      );
    if (args[0] === 'provider' && args.includes('list'))
      return JSON.stringify(
        providers.map(({ name, id, type }) => ({ name, id, type, workspace: 'default' })),
      );
    throw new Error('Unexpected offline command');
  });
  const manager = new OpenShellRuntimeManager(
    {
      ...runtime,
      image: 'offline:image',
      policy: policyPath.pathname,
      seed: root,
      seedStackManifest: {
        policy: { sha256: createHash('sha256').update(readFileSync(policyPath)).digest('hex') },
      },
      serviceProviders: approvals.automatic,
      grantableServiceProviders: attachmentMode === 'on-demand' ? [jira.name] : [],
      createDetached: true,
      sandboxIdLength: 13,
      webSearch: 'disabled',
      account: { kind: 'api', provider: data.providers[0].name, model: 'offline-model' },
      verifyConnections: (name, signal, granted) =>
        service.verifyRuntimeSandbox(name, automatic, 'offline', signal, [], granted),
      connectionRuntimePolicies: (_name, signal, granted) =>
        service.runtimePolicyContracts(automatic, 'offline', signal, granted),
    },
    run,
    undefined,
    undefined,
    {
      read: () => approvals,
      write: () => {
        throw new Error('Observation mutated approval');
      },
    },
  );
  return {
    manager,
    runtime,
    conversation,
    profile,
    store,
    connection,
    data,
    service,
    run,
    approvals,
  };
}

it('admits registry-bound managed Jira at the real observation seam and rejects policy widening', async () => {
  const f = admissionFixture();
  const proof = await f.manager.observeContract(
    f.conversation,
    f.runtime,
    new AbortController().signal,
  );
  expect(proof.attestation.basePolicy).toEqual(base);
  expect(proof.attestation.providers).toContainEqual(
    expect.objectContaining({
      name: f.connection.gatewayProviderName,
      id: 'jira-physical',
      type: 'jira-readonly',
    }),
  );
  expect(
    await f.service.runtimePolicyContracts([f.connection], 'offline', new AbortController().signal),
  ).toEqual([
    expect.objectContaining({
      policy: connectionTemplateRegistry.compileProviderPolicy({
        templateId: 'jira-readonly',
        templateVersion: 1,
        fields: f.connection.publicConfig,
      }),
    }),
  ]);
  const endpoint = (f.profile.endpoints as { rules: unknown[] }[])[0];
  endpoint.rules.push({ allow: { method: 'POST', path: '/**' } });
  f.data.observed.network_policies['_provider_mitzo_conn_abcdef12'].endpoints = structuredClone(
    f.profile.endpoints,
  ) as Record<string, unknown>[];
  await expect(
    f.manager.observeContract(f.conversation, f.runtime, new AbortController().signal),
  ).rejects.toThrow(/profile|policy/i);
  expect(
    f.run.mock.calls.every(
      ([args]) =>
        !args.some((arg) => ['attach', 'detach', 'create', 'delete', 'stop'].includes(arg)),
    ),
  ).toBe(true);
});

it('rejects a stale retained connection revision before trusting its policy', async () => {
  const f = admissionFixture();
  f.store.transition(
    f.connection.id,
    f.connection.revision,
    { status: 'revoked' },
    { operation: 'offline-revoke', outcome: 'success', actor: 'operator' },
  );
  await expect(
    f.manager.observeContract(f.conversation, f.runtime, new AbortController().signal),
  ).rejects.toThrow(/changed|revision/i);
});

it.each([
  ['github-readonly', 'automatic', false],
  ['custom-rest-readonly', 'automatic', false],
  ['custom-rest-readonly', 'on-demand', true],
])('attests %s %s through real managed authority', async (template, mode, graphql) => {
  const f = admissionFixture(template, mode, graphql);
  const proof = await f.manager.observeContract(
    f.conversation,
    f.runtime,
    new AbortController().signal,
  );
  expect(proof.attestation.providers).toContainEqual(
    expect.objectContaining({ name: f.connection.gatewayProviderName }),
  );
  f.data.observed.network_policies['_provider_mitzo_conn_abcdef12'].binaries.push({
    path: '/bin/sh',
  });
  await expect(
    f.manager.observeContract(f.conversation, f.runtime, new AbortController().signal),
  ).rejects.toThrow(/effective policy/i);
});

it('rejects attached on-demand access when its durable approval is absent', async () => {
  const f = admissionFixture('custom-rest-readonly', 'on-demand');
  f.approvals.granted = [];
  await expect(
    f.manager.observeContract(f.conversation, f.runtime, new AbortController().signal),
  ).rejects.toThrow(/attachment contract/i);
});

it('rejects a generated custom profile widened together with its effective policy', async () => {
  const f = admissionFixture('custom-rest-readonly');
  const endpoint = (f.profile.endpoints as { allowed_ips: string[] }[])[0];
  endpoint.allowed_ips.push('8.8.8.8');
  f.data.observed.network_policies['_provider_mitzo_conn_abcdef12'].endpoints = structuredClone(
    f.profile.endpoints,
  ) as Record<string, unknown>[];
  await expect(
    f.manager.observeContract(f.conversation, f.runtime, new AbortController().signal),
  ).rejects.toThrow(/profile|policy/i);
});

it('binds an approved on-demand connection to its current persisted provider identity', async () => {
  const f = admissionFixture('custom-rest-readonly', 'on-demand');
  f.store.transition(
    f.connection.id,
    f.connection.revision,
    { gatewayProviderId: 'replacement-physical' },
    { operation: 'offline-change', outcome: 'success', actor: 'operator' },
  );
  await expect(
    f.manager.observeContract(f.conversation, f.runtime, new AbortController().signal),
  ).rejects.toThrow(/binding|permissions changed/i);
});

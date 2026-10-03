import { mkdtempSync, rmSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { OpenShellRuntimeManager, type OpenShellRuntime } from '../openshell-runtime.js';
import { runtimePolicyHash } from '../openshell-runtime-policy.js';
import { base, fixture } from './fixtures/effective-runtime-policy.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function runtimeFixture(types = ['mitzo-openai-keychain-spike']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'materialized-policy-')));
  roots.push(root);
  const conversation = 'policy-fixture';
  const owner = createHash('sha256').update(conversation).digest('hex').slice(0, 63);
  const data = fixture(types);
  const approvals = {
    automatic: types.includes('github') ? ['github'] : [],
    granted: types.includes('mitzo-google-workspace-spike') ? ['google-workspace'] : [],
  };
  const runtime: OpenShellRuntime = {
    sandboxName: 'owned-sandbox',
    sandboxId: 'owned-physical',
    resourceVersion: 'r1',
    cli: 'fixture-cli',
    workspace: 'default',
    gateway: 'fixture-gateway',
    gatewayInsecure: false,
    workdir: '/sandbox/workspaces/mgmt',
    appServerCommand: '/sandbox/run-mitzo-app-server',
  };
  const config = {
    ...runtime,
    sandboxNameOverride: runtime.sandboxName,
    image: 'fixture:image',
    policy: new URL(
      '../../docs/spikes/openshell-codex/openshell-openai-api-policy.yaml',
      import.meta.url,
    ).pathname,
    seed: root,
    seedStackManifest: {
      policy: {
        sha256: createHash('sha256')
          .update(
            readFileSync(
              new URL(
                '../../docs/spikes/openshell-codex/openshell-openai-api-policy.yaml',
                import.meta.url,
              ),
            ),
          )
          .digest('hex'),
      },
    },
    serviceProviders: approvals.automatic,
    grantableServiceProviders: ['google-workspace'],
    createDetached: true,
    sandboxIdLength: 13,
    webSearch: 'disabled' as const,
    account:
      data.providers[0].type === 'openai-codex-oauth'
        ? {
            kind: 'chatgpt-subscription' as const,
            provider: data.providers[0].name,
            providerType: 'openai-codex-oauth' as const,
            providerId: data.providers[0].id,
            grantId: 'offline-grant',
            model: 'offline-model',
          }
        : { kind: 'api' as const, provider: data.providers[0].name, model: 'offline-model' },
  };
  let detailReads = 0;
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'sandbox' && args.includes('get')) {
      detailReads++;
      return JSON.stringify({
        id: runtime.sandboxId,
        name: runtime.sandboxName,
        workspace: 'default',
        phase: 'Ready',
        resource_version: 'r' + detailReads,
        policy_source: 'sandbox',
        policy: data.observed,
        labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': config.account.provider },
      });
    }
    if (args[0] === 'sandbox' && args.includes('provider'))
      return (
        'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n' +
        data.providers.map((p) => `${p.name} ${p.type} 1 0`).join('\n')
      );
    if (args[0] === 'provider' && args.includes('refresh') && args.includes('status'))
      return JSON.stringify({
        credentials: [
          {
            credential_key: 'OPENAI_CODEX_OAUTH_ACCESS_TOKEN',
            provider_name: data.providers[0].name,
            provider_id: data.providers[0].id,
            status: 'refreshed',
            refresh_generation_id: 'offline-grant',
            expires_at_ms: Date.now() + 60000,
          },
        ],
      });
    if (args[0] === 'provider' && args.includes('profile') && args.includes('list'))
      throw new Error('installed CLI rejects nested profile list');
    if (args[0] === 'provider' && args.includes('list-profiles'))
      return JSON.stringify(data.providers.map((p) => p.profile));
    if (args[0] === 'provider' && args.includes('export'))
      return JSON.stringify(
        data.providers.find((p) => p.type === args[args.indexOf('export') + 1])!.profile,
      );
    if (args[0] === 'provider' && args.includes('list'))
      return JSON.stringify(
        data.providers.map((p) => ({ name: p.name, id: p.id, type: p.type, workspace: 'default' })),
      );
    throw new Error('Unexpected native fixture command');
  });
  const manager = new OpenShellRuntimeManager(config, run, undefined, undefined, {
    read: () => approvals,
    write: () => {
      throw new Error('read-only observation wrote approval state');
    },
  });
  return { manager, runtime, conversation, run, data, approvals, config };
}
it.each([
  { types: ['mitzo-openai-keychain-spike'] },
  { types: ['mitzo-openai-keychain-spike', 'github', 'mitzo-google-workspace-spike'] },
  { types: ['openai-codex-oauth', 'github'] },
])(
  'real manager attests approved full policy and retains base/effective/provider provenance for %j',
  async ({ types }) => {
    const f = runtimeFixture(types);
    const observed = await f.manager.observeContract(
      f.conversation,
      f.runtime,
      new AbortController().signal,
    );
    expect(observed.attestation.basePolicy).toEqual(base);
    expect(observed.attestation.effectivePolicyHash).toBe(runtimePolicyHash(f.data.observed));
    expect(observed.attestation.providers.map((p) => p.id)).toEqual(
      [...f.data.providers].sort((a, b) => a.name.localeCompare(b.name)).map((p) => p.id),
    );
    expect(observed.approvedGrantableProviders).toEqual(f.approvals.granted);
    expect(
      f.run.mock.calls.every(
        ([args]) =>
          !args.some((a) =>
            ['attach', 'detach', 'create', 'start', 'stop', 'set', 'delete'].includes(a),
          ),
      ),
    ).toBe(true);
  },
);
it('real observation rejects a physically attached but unapproved GWS grant', async () => {
  const f = runtimeFixture([
    'mitzo-openai-keychain-spike',
    'github',
    'mitzo-google-workspace-spike',
  ]);
  f.approvals.granted = [];
  await expect(
    f.manager.observeContract(f.conversation, f.runtime, new AbortController().signal),
  ).rejects.toThrow('attachment contract differs');
});
it('real observation rejects profile revision race despite unchanged materialized endpoints', async () => {
  const f = runtimeFixture();
  const original = f.run.getMockImplementation()!;
  let reads = 0;
  f.run.mockImplementation(async (args) => {
    const output = await original(args);
    if (args.includes('export') && ++reads === 2) {
      const profile = JSON.parse(output);
      profile.resource_version++;
      return JSON.stringify(profile);
    }
    return output;
  });
  await expect(
    f.manager.observeContract(f.conversation, f.runtime, new AbortController().signal),
  ).rejects.toThrow('profile changed during attestation');
});
it('real observation rejects provider identity race even when names/types/policy are unchanged', async () => {
  const f = runtimeFixture();
  const original = f.run.getMockImplementation()!;
  let reads = 0;
  f.run.mockImplementation(async (args) => {
    const output = await original(args);
    if (
      args[0] === 'provider' &&
      args.includes('list') &&
      !args.includes('profile') &&
      ++reads === 2
    ) {
      const rows = JSON.parse(output);
      rows[0].id = 'replacement-id';
      return JSON.stringify(rows);
    }
    return output;
  });
  await expect(
    f.manager.observeContract(f.conversation, f.runtime, new AbortController().signal),
  ).rejects.toThrow('identity changed during attestation');
});

it('candidate ensure inherits only attested durable GWS approval and leaves source permissions intact', async () => {
  const f = runtimeFixture([
    'mitzo-openai-keychain-spike',
    'github',
    'mitzo-google-workspace-spike',
  ]);
  const source = await f.manager.observeContract(
    f.conversation,
    f.runtime,
    new AbortController().signal,
  );
  const records = new Map([[f.runtime.sandboxName, structuredClone(f.approvals)]]);
  const original = f.run.getMockImplementation()!;
  let candidate: Record<string, unknown> | undefined;
  const attached = new Set<string>();
  const run = vi.fn(async (args: readonly string[]) => {
    if (
      args[0] === 'sandbox' &&
      args.includes('get') &&
      args[args.indexOf('get') + 1] === 'migration-candidate'
    ) {
      if (!candidate) throw new Error('sandbox not found');
      return JSON.stringify(candidate);
    }
    if (args[0] === 'sandbox' && args.includes('create')) {
      const labels = Object.fromEntries(
        args.flatMap((arg, i) => (arg === '--label' ? [args[i + 1].split('=')] : [])),
      );
      candidate = {
        name: 'migration-candidate',
        id: 'candidate-id',
        phase: 'Ready',
        resource_version: 'r1',
        workspace: 'default',
        policy_source: 'sandbox',
        policy: f.data.observed,
        labels,
      };
      for (let i = 0; i < args.length; i++) if (args[i] === '--provider') attached.add(args[i + 1]);
      return JSON.stringify(candidate);
    }
    if (args[0] === 'sandbox' && args.includes('provider') && args.includes('attach')) {
      attached.add(args[args.indexOf('attach') + 2]);
      return '{}';
    }
    if (
      args[0] === 'sandbox' &&
      args.includes('provider') &&
      args.includes('list') &&
      args.at(-1) === 'migration-candidate'
    )
      return (
        'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n' +
        [...attached].map((name) => `${name} fixture 1 0`).join('\n')
      );
    return original(args);
  });
  const manager = new OpenShellRuntimeManager(f.config, run, undefined, async () => '{}', {
    read: (name) => records.get(name),
    write: (name, record) => {
      records.set(name, structuredClone(record));
    },
  }).forSandbox('migration-candidate');
  const created = await manager.ensure(
    f.conversation,
    new AbortController().signal,
    undefined,
    { seed: f.config.seed, cleanup: () => undefined },
    source.approvedGrantableProviders,
  );
  expect(created.sandboxId).toBe('candidate-id');
  expect(records.get('migration-candidate')?.granted).toEqual(['google-workspace']);
  expect(records.get(f.runtime.sandboxName)).toEqual(f.approvals);
  expect(attached.has('google-workspace')).toBe(true);
  const attested = await manager.observeContract(
    f.conversation,
    created,
    new AbortController().signal,
  );
  expect(attested.attestation.effectivePolicyHash).toBe(source.attestation.effectivePolicyHash);
  expect(attested.attestation.providers.map((p) => [p.id, p.type, p.profileHash])).toEqual(
    source.attestation.providers.map((p) => [p.id, p.type, p.profileHash]),
  );
});

it.each(['provider_id', 'refresh_generation_id'] as const)(
  'ordinary subscription observation rejects %s binding drift before accepting endpointless profile',
  async (field) => {
    const f = runtimeFixture(['openai-codex-oauth', 'github']);
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (args) => {
      const output = await original(args);
      if (args.includes('refresh')) {
        const payload = JSON.parse(output);
        payload.credentials[0][field] = 'other-identity';
        return JSON.stringify(payload);
      }
      return output;
    });
    await expect(
      f.manager.observeContract(f.conversation, f.runtime, new AbortController().signal),
    ).rejects.toThrow('ChatGPT grant');
  },
);

it('real observation rejects a different global credential schema despite equal workspace endpoints', async () => {
  const f = runtimeFixture();
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args) => {
    const output = await original(args);
    if (args.includes('list-profiles')) {
      const profiles = JSON.parse(output);
      const global = structuredClone(profiles[0]);
      global.scope = 'platform';
      global.credentials[0].header_name = 'X-Unreviewed-Credential';
      profiles.push(global);
      return JSON.stringify(profiles);
    }
    return output;
  });
  await expect(
    f.manager.observeContract(f.conversation, f.runtime, new AbortController().signal),
  ).rejects.toThrow('profile differs from reviewed');
});
it('real observation attests identical workspace and platform selectors and their separate revisions', async () => {
  const f = runtimeFixture();
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args) => {
    const output = await original(args);
    if (args.includes('list-profiles')) {
      const profiles = JSON.parse(output);
      profiles.push({ ...structuredClone(profiles[0]), scope: 'platform', resource_version: 19 });
      return JSON.stringify(profiles);
    }
    return output;
  });
  const observed = await f.manager.observeContract(
    f.conversation,
    f.runtime,
    new AbortController().signal,
  );
  expect(observed.attestation.profileCatalog?.map((p) => p.scope)).toEqual([
    'platform',
    'workspace',
  ]);
  expect(observed.attestation.profileCatalog?.[0].resourceVersion).toBe(19);
});
it.each(['truncated', 'unknown-scope', 'changed'])(
  'real observation rejects %s selector evidence',
  async (failure) => {
    const f = runtimeFixture();
    const original = f.run.getMockImplementation()!;
    let reads = 0;
    f.run.mockImplementation(async (args) => {
      const output = await original(args);
      if (args.includes('list-profiles')) {
        const profiles = JSON.parse(output);
        reads++;
        if (failure === 'truncated')
          return JSON.stringify(Array.from({ length: 100 }, () => profiles[0]));
        if (failure === 'unknown-scope') profiles.push({ ...profiles[0], scope: 'unknown' });
        if (failure === 'changed' && reads === 2) profiles[0].resource_version++;
        return JSON.stringify(profiles);
      }
      return output;
    });
    await expect(
      f.manager.observeContract(f.conversation, f.runtime, new AbortController().signal),
    ).rejects.toThrow(
      failure === 'truncated'
        ? 'catalog is incomplete'
        : failure === 'unknown-scope'
          ? 'scope is unsupported'
          : 'catalog changed during attestation',
    );
  },
);

it('authored base and sandbox co-drift cannot supersede the selected manifest pin', async () => {
  const f = runtimeFixture();
  const changed = structuredClone(base);
  changed.filesystem_policy.read_write = ['/unreviewed'];
  f.data.observed.filesystem_policy = changed.filesystem_policy;
  const policy = join(f.config.seed, 'changed-policy.json');
  writeFileSync(policy, JSON.stringify(changed));
  f.config.policy = policy;
  await expect(
    f.manager.observeContract(f.conversation, f.runtime, new AbortController().signal),
  ).rejects.toThrow('authored policy differs from selected manifest');
});
it.each(['revoked', 'replaced', 'expired'])(
  'final fence rejects a grant %s after the first refresh observation',
  async (failure) => {
    const f = runtimeFixture(['openai-codex-oauth']);
    const original = f.run.getMockImplementation()!;
    let reads = 0;
    f.run.mockImplementation(async (args) => {
      const output = await original(args);
      if (args.includes('refresh') && ++reads === 2) {
        const data = JSON.parse(output);
        if (failure === 'revoked') data.credentials[0].status = 'revoked';
        if (failure === 'replaced') data.credentials[0].refresh_generation_id = 'new-grant';
        if (failure === 'expired') data.credentials[0].expires_at_ms = Date.now() - 1;
        return JSON.stringify(data);
      }
      return output;
    });
    await expect(
      f.manager.observeContract(f.conversation, f.runtime, new AbortController().signal),
    ).rejects.toThrow('grant is expired, revoked, or requires sign-in');
  },
);
it.each(['workspace', 'policy_source'])(
  'final physical observation rejects changed %s',
  async (field) => {
    const f = runtimeFixture();
    const original = f.run.getMockImplementation()!;
    let reads = 0;
    f.run.mockImplementation(async (args) => {
      const output = await original(args);
      if (args[0] === 'sandbox' && args.includes('get') && ++reads === 3) {
        const data = JSON.parse(output);
        data[field] = 'changed';
        return JSON.stringify(data);
      }
      return output;
    });
    await expect(
      f.manager.observeContract(f.conversation, f.runtime, new AbortController().signal),
    ).rejects.toThrow('effective policy changed during attestation');
  },
);

it('final fence rejects authored file drift after initial pinned policy comparison', async () => {
  const f = runtimeFixture();
  const policy = join(f.config.seed, 'policy.yaml');
  writeFileSync(policy, readFileSync(f.config.policy));
  f.config.policy = policy;
  const original = f.run.getMockImplementation()!;
  let reads = 0;
  f.run.mockImplementation(async (args) => {
    const output = await original(args);
    if (args.includes('export') && ++reads === 2) writeFileSync(policy, '{}');
    return output;
  });
  await expect(
    f.manager.observeContract(f.conversation, f.runtime, new AbortController().signal),
  ).rejects.toThrow('authored policy differs from selected manifest');
});

it.each(['grant', 'revoke'])(
  'real source reservation blocks a queued %s and delivers it after failed migration',
  async (mutation) => {
    const f = runtimeFixture(['mitzo-openai-keychain-spike', 'mitzo-google-workspace-spike']);
    const write = vi.fn((_name, record) => Object.assign(f.approvals, structuredClone(record)));
    const manager = new OpenShellRuntimeManager(f.config, f.run, undefined, undefined, {
      read: () => f.approvals,
      write,
    });
    let pending: Promise<void> | undefined;
    const fenced = manager.withMigrationProviderPolicyFence(
      f.conversation,
      f.runtime,
      new AbortController().signal,
      async (assertUnqueued) => {
        pending =
          mutation === 'grant'
            ? manager.grantServiceProvider(
                f.conversation,
                f.runtime,
                'google-workspace',
                new AbortController().signal,
              )
            : manager.revokeServiceProvider(
                f.conversation,
                f.runtime,
                'google-workspace',
                new AbortController().signal,
              );
        await Promise.resolve();
        expect(write).not.toHaveBeenCalled();
        expect(
          f.run.mock.calls.some(([args]) => args.includes('attach') || args.includes('detach')),
        ).toBe(false);
        assertUnqueued();
      },
    );
    await expect(fenced).rejects.toThrow('source provider policy mutation is pending');
    await pending;
    expect(write).toHaveBeenCalledOnce();
    expect(f.approvals.granted).toEqual(mutation === 'grant' ? ['google-workspace'] : []);
    expect(
      f.run.mock.calls.filter(([args]) =>
        args.includes(mutation === 'grant' ? 'attach' : 'detach'),
      ),
    ).toHaveLength(1);
  },
);

it('uses installed list-profiles grammar for initial and final scoped catalog reads', async () => {
  const f = runtimeFixture();
  const proof = await f.manager.observeContract(
    f.conversation,
    f.runtime,
    new AbortController().signal,
  );
  expect(proof.attestation.effectivePolicyHash).toBe(runtimePolicyHash(f.data.observed));
  const catalogs = f.run.mock.calls.filter(([args]) => args.includes('list-profiles'));
  expect(catalogs).toHaveLength(2);
  for (const [args] of catalogs)
    expect(args).toEqual([
      'provider',
      '--gateway',
      f.config.gateway,
      '--workspace',
      f.config.workspace,
      'list-profiles',
      '--output',
      'json',
    ]);
  expect(f.run.mock.calls.some(([args]) => args.includes('profile') && args.includes('list'))).toBe(
    false,
  );
});

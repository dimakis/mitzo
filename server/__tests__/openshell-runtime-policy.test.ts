import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { connectionTemplateRegistry } from '../connections/registry.js';
import { renderCustomRestProfile } from '../connections-gateway.js';
import { supportsConnectionRuntimeTemplate } from '../connections/runtime-profiles.js';
import { expect, it } from 'vitest';
import { attestEffectiveRuntimePolicy, runtimePolicyHash } from '../openshell-runtime-policy.js';
import { base, fixture, type Profile } from './fixtures/effective-runtime-policy.js';
import type { RuntimePolicyProvider } from '../openshell-runtime-policy.js';
it('attests the actual canary serializer/profile materialization without losing base or credential inspection', () => {
  const f = fixture();
  const result = attestEffectiveRuntimePolicy(base, f.observed, f.providers);
  // Reconstructed from the credential-free actual canary observation.
  expect(runtimePolicyHash(base)).toBe(
    '365cf2bcf08f34b01cd08d4496ac9d79b28ea1ac8112f40db7d6d3762221eb09',
  );
  expect(runtimePolicyHash(f.observed)).toBe(
    '3ff6057ab97edb0c3458f84e5382ab6b231ce3b604e1b5cb2d12b20e32386561',
  );
  expect(result.basePolicy).toEqual(base);
  expect(result.providers).toHaveLength(1);
});
it('attests production OpenAI + automatic GitHub + approved GWS layers exactly', () => {
  const f = fixture(['mitzo-openai-keychain-spike', 'github', 'mitzo-google-workspace-spike']);
  expect(attestEffectiveRuntimePolicy(base, f.observed, f.providers).providers).toHaveLength(3);
});

const mutations: [string, (f: ReturnType<typeof fixture>) => void][] = [
  [
    'extra network rule',
    (f) => {
      f.observed.network_policies.extra = structuredClone(f.observed.network_policies.openai_api);
    },
  ],
  [
    'unknown provider layer',
    (f) => {
      f.observed.network_policies._provider_unknown = structuredClone(
        f.observed.network_policies.openai_api,
      );
    },
  ],
  [
    'extra provider endpoint',
    (f) => {
      f.observed.network_policies._provider_mitzo_keychain_v2.endpoints.push({
        host: 'unexpected.invalid',
        port: 443,
      });
    },
  ],
  [
    'base credential rewrite',
    (f) => {
      f.observed.network_policies.openai_api.endpoints[0].request_body_credential_rewrite = true;
    },
  ],
  [
    'inspection bypass',
    (f) => {
      f.observed.network_policies._provider_mitzo_keychain_v2.endpoints[0].allow_uninspected_credentials = true;
    },
  ],
  [
    'profile credential destination',
    (f) => {
      f.providers[0].profile.credentials[0].query_param = 'api_key';
    },
  ],
  [
    'profile credential header',
    (f) => {
      f.providers[0].profile.credentials[0].header_name = 'x-api-key';
    },
  ],
  [
    'profile extra credential',
    (f) => {
      f.providers[0].profile.credentials.push({ name: 'extra', env_vars: ['OTHER_SECRET'] });
    },
  ],
  [
    'profile process permission',
    (f) => {
      f.providers[0].profile.binaries.push('/usr/bin/unknown');
    },
  ],
  [
    'layer process permission',
    (f) => {
      f.observed.network_policies._provider_mitzo_keychain_v2.binaries.push({
        path: '/usr/bin/unknown',
      });
    },
  ],
  [
    'filesystem permission',
    (f) => {
      f.observed.filesystem_policy.read_write = ['/'];
    },
  ],
  [
    'landlock permission',
    (f) => {
      f.observed.landlock.compatibility = 'disabled';
    },
  ],
  [
    'scope drift',
    (f) => {
      f.providers[0].profile.scope = 'global';
    },
  ],
  [
    'profile source drift',
    (f) => {
      f.providers[0].profile.source = 'builtin';
    },
  ],
  [
    'unknown endpoint security field',
    (f) => {
      f.observed.network_policies.openai_api.endpoints[0].unknown_mode = 'bypass';
    },
  ],
];
it.each(mutations)(
  'rejects %s without discarding unexpected policy/profile fields',
  (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(() => attestEffectiveRuntimePolicy(base, f.observed, f.providers)).toThrow(/Runtime/);
  },
);
it('rejects drift even when mutable export and effective layer agree on extra permissions', () => {
  const f = fixture();
  f.providers[0].profile.endpoints.push({
    host: 'unexpected.invalid',
    port: 443,
    protocol: 'rest',
  });
  f.observed.network_policies._provider_mitzo_keychain_v2.endpoints = structuredClone(
    f.providers[0].profile.endpoints,
  );
  expect(() => attestEffectiveRuntimePolicy(base, f.observed, f.providers)).toThrow(
    'reviewed definition',
  );
});

it('attests the reviewed endpointless ordinary subscription provider without adding external credential traffic', () => {
  const f = fixture(['openai-codex-oauth', 'github']);
  const result = attestEffectiveRuntimePolicy(base, f.observed, f.providers);
  expect(result.providers[0].type).toBe('openai-codex-oauth');
  expect(f.observed.network_policies._provider_mitzo_keychain_v2).toEqual({
    name: '_provider_mitzo_keychain_v2',
  });
});

function managedFixture(
  type: string,
  profile: Profile,
  connectionPolicy?: ReturnType<typeof connectionTemplateRegistry.compileProviderPolicy>,
) {
  const f = fixture();
  const exported: Profile = { ...profile, resource_version: 7, source: 'user', scope: 'workspace' };
  const name = 'mitzo-conn-managed';
  const key = '_provider_mitzo_conn_managed';
  f.observed.network_policies[key] = {
    name: key,
    endpoints: structuredClone(exported.endpoints) as Record<string, unknown>[],
    binaries: (exported.binaries as string[]).map((path) => ({ path })),
  };
  const providers: (RuntimePolicyProvider & { profile: Profile })[] = [
    ...f.providers,
    { name, id: 'managed-provider-id', type, profile: exported, connectionPolicy },
  ];
  return { observed: f.observed, providers };
}
it('attests automatic Jira using the same reviewed connection compiler contract', () => {
  const profile = load(
    readFileSync(
      new URL('../../infra/openshell/providers/mitzo-jira-readonly.yaml', import.meta.url),
      'utf8',
    ),
  ) as Profile;
  const f = managedFixture('jira-readonly', profile);
  expect(attestEffectiveRuntimePolicy(base, f.observed, f.providers).providers[1]).toMatchObject({
    type: 'jira-readonly',
    source: 'user',
    scope: 'workspace',
    resourceVersion: 7,
  });
  const endpoints = f.providers[1].profile.endpoints as {
    rules: { allow: { method: string } }[];
  }[];
  endpoints[0].rules[0].allow.method = 'POST';
  f.observed.network_policies._provider_mitzo_conn_managed.endpoints = structuredClone(endpoints);
  expect(() => attestEffectiveRuntimePolicy(base, f.observed, f.providers)).toThrow();
});
it('attests generated custom connections only against independently supplied compiled policy', () => {
  const policy = connectionTemplateRegistry.compileProviderPolicy({
    templateId: 'custom-rest-readonly',
    templateVersion: 1,
    fields: {
      endpoint: 'https://api.github.com',
      port: '443',
      protocol: 'rest',
      methods: ['GET'],
      paths: ['/v1/**'],
      credentialStyle: 'api-token',
      credentialLocation: 'query',
      credentialName: 'api_key',
      binaries: ['curl'],
      attachmentMode: 'automatic',
      dnsPin: ['93.184.216.34'],
    },
  });
  const rendered = renderCustomRestProfile(policy);
  const profile = load(rendered.yaml) as Profile;
  const f = managedFixture(rendered.id, profile, policy);
  expect(attestEffectiveRuntimePolicy(base, f.observed, f.providers).providers).toHaveLength(2);
  for (const field of ['allowed_ips', 'rules', 'allow_uninspected_credentials']) {
    const drifted = managedFixture(rendered.id, structuredClone(profile), policy);
    const endpoint = (drifted.providers[1].profile.endpoints as Record<string, unknown>[])[0];
    endpoint[field] =
      field === 'allowed_ips'
        ? ['8.8.8.8']
        : field === 'rules'
          ? [{ allow: { method: 'POST', path: '/v1/**' } }]
          : true;
    drifted.observed.network_policies._provider_mitzo_conn_managed.endpoints = structuredClone(
      drifted.providers[1].profile.endpoints,
    ) as Record<string, unknown>[];
    expect(() => attestEffectiveRuntimePolicy(base, drifted.observed, drifted.providers)).toThrow();
  }
  const badPolicy = {
    ...policy,
    endpoints: policy.endpoints.map((endpoint) => ({
      ...endpoint,
      allowedBinaries: [...endpoint.allowedBinaries, '/usr/bin/unknown'],
    })),
  };
  const mismatched = managedFixture(rendered.id, profile, badPolicy);
  expect(() =>
    attestEffectiveRuntimePolicy(base, mismatched.observed, mismatched.providers),
  ).toThrow();
  delete f.providers[1].connectionPolicy;
  expect(() => attestEffectiveRuntimePolicy(base, f.observed, f.providers)).toThrow();
});

it('keeps every registered connection template bound to a reviewed runtime adapter', () => {
  for (const template of connectionTemplateRegistry.providerTemplates()) {
    expect(supportsConnectionRuntimeTemplate(template.id, template.version)).toBe(true);
    expect(supportsConnectionRuntimeTemplate(template.id, template.version + 1)).toBe(false);
  }
  expect(supportsConnectionRuntimeTemplate('unreviewed-new-template', 1)).toBe(false);
});
it('accepts only documented false Jira protobuf defaults while preserving exact layer checks', () => {
  const profile = load(
    readFileSync(
      new URL('../../infra/openshell/providers/mitzo-jira-readonly.yaml', import.meta.url),
      'utf8',
    ),
  ) as Profile;
  const endpoints = profile.endpoints as Record<string, unknown>[];
  endpoints[0].request_body_credential_rewrite = false;
  endpoints[0].allow_uninspected_credentials = false;
  const f = managedFixture('jira-readonly', profile);
  expect(attestEffectiveRuntimePolicy(base, f.observed, f.providers).providers).toHaveLength(2);
  (f.providers[1].profile.endpoints as Record<string, unknown>[])[0].allow_uninspected_credentials =
    true;
  expect(() => attestEffectiveRuntimePolicy(base, f.observed, f.providers)).toThrow();
});

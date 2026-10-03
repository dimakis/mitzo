import { expect, it } from 'vitest';
import { attestEffectiveRuntimePolicy, runtimePolicyHash } from '../openshell-runtime-policy.js';
import { base, fixture } from './fixtures/effective-runtime-policy.js';
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

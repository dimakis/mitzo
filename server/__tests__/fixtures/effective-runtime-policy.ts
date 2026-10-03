import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { reviewedRuntimeProfile } from '../../openshell-runtime-policy.js';
type Endpoint = Record<string, unknown>;
export type Profile = {
  source?: string;
  scope?: string;
  resource_version?: number;
  endpoints: Endpoint[];
  credentials: Endpoint[];
  binaries: string[];
};
type Policy = {
  network_policies: Record<
    string,
    { name?: string; endpoints: Endpoint[]; binaries: { path: string }[] }
  >;
  filesystem_policy: Record<string, unknown>;
  landlock: Record<string, unknown>;
};
export const base = load(
  readFileSync(
    new URL(
      '../../../docs/spikes/openshell-codex/openshell-openai-api-policy.yaml',
      import.meta.url,
    ),
    'utf8',
  ),
) as Policy;
export function fixture(types = ['mitzo-openai-keychain-spike']) {
  const observed = structuredClone(base);
  for (const endpoint of observed.network_policies.openai_api.endpoints) {
    delete endpoint.request_body_credential_rewrite;
    delete endpoint.allow_uninspected_credentials;
  }
  const providers = types.map((type, i) => {
    const profile = structuredClone(reviewedRuntimeProfile(type)) as Profile;
    const builtin = ['github', 'openai-codex-oauth'].includes(type);
    profile.source = builtin ? 'builtin' : 'user';
    if (!builtin) {
      profile.scope = 'workspace';
      profile.resource_version = 6;
    }
    for (const endpoint of profile.endpoints) {
      if (endpoint.request_body_credential_rewrite === false)
        delete endpoint.request_body_credential_rewrite;
      if (endpoint.allow_uninspected_credentials === false)
        delete endpoint.allow_uninspected_credentials;
    }
    for (const credential of profile.credentials) credential.query_param ??= '';
    const name = i === 0 ? 'mitzo-keychain-v2' : type === 'github' ? 'github' : 'google-workspace';
    const key = '_provider_' + name.replaceAll('-', '_');
    observed.network_policies[key] = {
      name: key,
      endpoints: structuredClone(profile.endpoints),
      binaries: profile.binaries.map((path: string) => ({ path })),
    };
    if (!profile.endpoints.length)
      delete (observed.network_policies[key] as unknown as Record<string, unknown>).endpoints;
    if (!profile.binaries.length)
      delete (observed.network_policies[key] as unknown as Record<string, unknown>).binaries;
    return { name, id: 'provider-fixture-' + i, type, profile };
  });
  return { observed, providers };
}

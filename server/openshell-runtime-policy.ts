import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { load } from 'js-yaml';
import { canonicalJsonPayload } from '../scripts/verify-openshell-production.mjs';

export interface RuntimePolicyProvider {
  name: string;
  id: string;
  type: string;
  profile: unknown;
  /** Only the complete catalog verifier supplies an alternate selector scope. */
  profileScope?: 'workspace' | 'platform';
}
export const runtimePolicyHash = (value: unknown) =>
  createHash('sha256').update(canonicalJsonPayload(value)).digest('hex');

type JsonObject = Record<string, unknown>;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function normalized(value: unknown, profile = false): unknown {
  const copy = structuredClone(value);
  if (!object(copy)) throw new Error('Runtime policy/profile is not an object');
  const rules = profile
    ? [copy]
    : object(copy.network_policies)
      ? Object.values(copy.network_policies)
      : [];
  for (const rule of rules) {
    if (!object(rule) || !Array.isArray(rule.endpoints)) continue;
    for (const endpoint of rule.endpoints) {
      if (!object(endpoint)) throw new Error('Runtime endpoint is invalid');
      // Only these documented protobuf false defaults are omitted. True and
      // every unknown field remain part of the exact comparison.
      for (const key of ['request_body_credential_rewrite', 'allow_uninspected_credentials'])
        if (endpoint[key] === false) delete endpoint[key];
    }
  }
  if (profile && Array.isArray(copy.credentials)) {
    for (const credential of copy.credentials) {
      if (!object(credential)) throw new Error('Runtime credential definition is invalid');
      if (credential.query_param === '') delete credential.query_param;
    }
  }
  return copy;
}
export interface RuntimePolicyAttestation {
  basePolicy: unknown;
  effectivePolicyHash: string;
  profileCatalog?: {
    type: string;
    profileHash: string;
    resourceVersion?: number;
    source: string;
    scope?: string;
  }[];
  providers: {
    name: string;
    id: string;
    type: string;
    profileHash: string;
    resourceVersion?: number;
    source: string;
    scope?: string;
  }[];
}
export type RuntimePolicyProvenance = Omit<RuntimePolicyAttestation, 'basePolicy'> & {
  basePolicyHash: string;
};
export function runtimePolicyProvenance(
  attestation: RuntimePolicyAttestation,
): RuntimePolicyProvenance {
  return {
    basePolicyHash: runtimePolicyHash(attestation.basePolicy),
    effectivePolicyHash: attestation.effectivePolicyHash,
    providers: attestation.providers,
    ...(attestation.profileCatalog ? { profileCatalog: attestation.profileCatalog } : {}),
  };
}
export function sameRuntimePolicyAuthority(
  a: RuntimePolicyProvenance | undefined,
  b: RuntimePolicyProvenance | undefined,
): boolean {
  if (!a || !b) return a === b;
  const authority = (v: RuntimePolicyProvenance | undefined) =>
    v && {
      ...v,
      ...(v.profileCatalog
        ? {
            profileCatalog: v.profileCatalog.map(
              ({ resourceVersion: _revision, ...profile }) => profile,
            ),
          }
        : {}),
      providers: v.providers.map(({ resourceVersion: _revision, ...provider }) => provider),
    };
  return runtimePolicyHash(authority(a)) === runtimePolicyHash(authority(b));
}
export function attestEffectiveRuntimePolicy(
  base: unknown,
  observed: unknown,
  providers: RuntimePolicyProvider[],
): RuntimePolicyAttestation {
  const expected = structuredClone(base);
  if (!object(expected) || !object(expected.network_policies))
    throw new Error('Runtime base network policy is unavailable');
  const layers = expected.network_policies;
  if (Object.keys(layers).some((key) => key.startsWith('_provider_')))
    throw new Error('Runtime authored provider rule is unsupported');
  const identities = new Set<string>();
  const provenance: RuntimePolicyAttestation['providers'] = [];
  for (const provider of providers) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(provider.name) ||
      !provider.id ||
      identities.has(provider.name)
    )
      throw new Error('Runtime provider identity is invalid');
    identities.add(provider.name);
    const reviewed = reviewedRuntimeProfile(provider.type);
    const profile = structuredClone(provider.profile);
    if (!object(reviewed) || !object(profile))
      throw new Error('Runtime provider profile is unavailable');
    const builtin = ['github', 'openai-codex-oauth'].includes(provider.type);
    const source = builtin ? 'builtin' : 'user';
    const scope = builtin ? undefined : (provider.profileScope ?? 'workspace');
    if (
      profile.source !== source ||
      profile.scope !== scope ||
      (source === 'user' &&
        (!Number.isSafeInteger(profile.resource_version) ||
          Number(profile.resource_version) <= 0)) ||
      (source === 'builtin' && profile.resource_version !== undefined)
    )
      throw new Error('Runtime provider profile provenance differs');
    const resourceVersion = profile.resource_version as number | undefined;
    delete profile.source;
    delete profile.scope;
    delete profile.resource_version;
    delete reviewed.resource_version;
    const definition = normalized(profile, true);
    if (runtimePolicyHash(definition) !== runtimePolicyHash(normalized(reviewed, true)))
      throw new Error('Runtime provider profile differs from reviewed definition');
    if (
      !Array.isArray(profile.endpoints) ||
      !Array.isArray(profile.binaries) ||
      profile.binaries.some((path) => typeof path !== 'string')
    )
      throw new Error('Runtime provider profile policy is invalid');
    const key =
      '_provider_' +
      provider.name
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/^_+|_+$/g, '');
    // Name collisions are ambiguous; never silently accept an extra suffix layer.
    if (key in layers) throw new Error('Runtime provider rule identity collides');
    layers[key] = {
      name: key,
      ...(profile.endpoints.length ? { endpoints: profile.endpoints } : {}),
      ...(profile.binaries.length ? { binaries: profile.binaries.map((path) => ({ path })) } : {}),
    };
    provenance.push({
      name: provider.name,
      id: provider.id,
      type: provider.type,
      profileHash: runtimePolicyHash(definition),
      ...(resourceVersion ? { resourceVersion } : {}),
      source,
      ...(scope ? { scope } : {}),
    });
  }
  if (runtimePolicyHash(normalized(expected)) !== runtimePolicyHash(normalized(observed)))
    throw new Error('Runtime effective policy differs');
  // The immutable checkpoint continues naming its original reviewed base bytes;
  // effective policy and exact profile/account materialization are separate proof.
  return {
    basePolicy: base,
    effectivePolicyHash: runtimePolicyHash(observed),
    providers: provenance,
  };
}

export function reviewedRuntimeProfile(type: string): unknown {
  const pins: Record<string, [string, string]> = {
    'mitzo-openai-keychain-spike': [
      '../docs/spikes/openshell-codex/openai-keychain-spike-profile.yaml',
      '332fe80a43b6f0512bdaa10ec426204dc84de3923150ba1e1abc36e0569075f7',
    ],
    'mitzo-google-workspace-spike': [
      '../docs/spikes/openshell-codex/google-workspace-spike-profile.yaml',
      '91a1f93fa405bdddecc4efa00d114d037448dd9443b33ed82522dd011cec42ce',
    ],
    'openai-codex-oauth': [
      '../infra/openshell/providers/openai-codex-oauth-reviewed-profile.json',
      '705c95d56909f8cf971afef2ea0e9d411cdb718e6d7aec197cd99f391471b0e4',
    ],
    github: [
      '../infra/openshell/providers/github-reviewed-profile.json',
      '596409689258f387f8fb819dc445ba45b9f0e1cff81c809f18594a45a027ea7a',
    ],
  };
  const pin = pins[type];
  if (!pin) throw new Error('Runtime provider profile is not reviewed');
  const path = new URL(pin[0], import.meta.url);
  const st = lstatSync(path);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    realpathSync(path) !== path.pathname ||
    st.size > 65536
  )
    throw new Error('Reviewed runtime profile is not physical');
  const bytes = readFileSync(path);
  if (createHash('sha256').update(bytes).digest('hex') !== pin[1])
    throw new Error('Reviewed runtime profile changed');
  return load(bytes.toString('utf8'));
}

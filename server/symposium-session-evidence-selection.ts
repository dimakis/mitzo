import { isDeepStrictEqual } from 'node:util';
import { SymposiumConfigSchema } from '@mitzo/protocol';
import type { AccountProfiles } from './account-profiles.js';
import { OwnedEvidenceSelection } from './symposium-owned-evidence.js';

/** Derive scope from an original current draft/catalog. No caller provider,
 * physical identity, account model or authority list is admitted. Personal
 * subscription evidence remains on its distinct private-auth capability path. */
export function selectSessionOwnedProviderEvidence(
  raw: unknown,
  profiles: AccountProfiles,
  roleScope: 'public-draft' | 'owned-draft' = 'public-draft',
) {
  const config = SymposiumConfigSchema.parse(raw);
  if (config.version !== 2 || config.state !== 'draft')
    throw new Error('Current original Symposium draft required');
  const primary = config.seats.find((seat) => seat.id === 'primary');
  const provider = primary?.accountBinding?.provider;
  if (!primary || (provider !== 'openai' && provider !== 'anthropic-vertex'))
    throw new Error('Original API or Vertex primary required');
  const roles = [...new Set(config.seats.map((seat) => seat.role))];
  if (
    !roles.length ||
    roles.some(
      (role) =>
        role !== 'coder' &&
        role !== 'reviewer' &&
        !(roleScope === 'owned-draft' && role === 'implementer'),
    )
  )
    throw new Error('Only API or Vertex coder/reviewer draft roles supported');
  const instances = config.seats.map((seat) => {
    const binding = seat.accountBinding;
    if (!binding || binding.provider !== provider || seat.model !== binding.model)
      throw new Error('Original draft accounts require one provider route');
    profiles.resume(binding);
    profiles.validateModelSelection(binding, seat.model, seat.reasoningEffort);
    if (provider === 'openai') {
      const selected = profiles.apiProfile(binding);
      return {
        name: selected.sandboxProvider,
        id: selected.sandboxProviderId,
        type: 'openai' as const,
        profileName: 'openai' as const,
      };
    }
    const selected = profiles.vertexSandboxRoute(binding);
    return {
      name: selected.provider,
      id: selected.providerId,
      type: 'google-vertex-ai' as const,
      profileName: 'google-vertex-ai' as const,
    };
  });
  if (instances.some((instance) => !isDeepStrictEqual(instance, instances[0])))
    throw new Error('One exact original provider instance required for a draft candidate');
  return OwnedEvidenceSelection.omit({ artifactVolume: true }).parse({
    providerInstances: [instances[0]],
    allowedRoles: roles,
    allowedAccountProviders: [provider],
  });
}
export function assertSessionOwnedProviderEvidence(
  raw: unknown,
  profiles: AccountProfiles,
  selection: unknown,
  roleScope: 'public-draft' | 'owned-draft' = 'public-draft',
): void {
  const selected = OwnedEvidenceSelection.omit({ artifactVolume: true }).parse(selection);
  if (!isDeepStrictEqual(selected, selectSessionOwnedProviderEvidence(raw, profiles, roleScope)))
    throw new Error('Original session evidence selection changed');
}

/** Called with the actual original gateway's retained capability receipt. This
 * comparison projects no new custody/approval authority from JSON. */
export function assertSessionOwnedVertexReceipt(
  raw: unknown,
  profiles: AccountProfiles,
  receipt: {
    principal: string;
    accountId: string;
    provider: string;
    providerId: string;
    projectId: string;
    region: string;
    model: string;
    workspace: string;
  },
  workspace: string,
): void {
  const config = SymposiumConfigSchema.parse(raw);
  selectSessionOwnedProviderEvidence(config, profiles, 'owned-draft');
  for (const seat of config.seats) {
    const binding = seat.accountBinding;
    if (!binding || binding.provider !== 'anthropic-vertex')
      throw new Error('Original Vertex draft account required');
    const route = profiles.vertexSandboxRoute(binding);
    if (
      !receipt.principal ||
      receipt.accountId !== binding.accountId ||
      receipt.provider !== route.provider ||
      receipt.providerId !== route.providerId ||
      receipt.projectId !== route.projectId ||
      receipt.region !== route.region ||
      receipt.model !== route.model ||
      receipt.workspace !== workspace
    )
      throw new Error('Original Vertex receipt differs from selected draft');
  }
}

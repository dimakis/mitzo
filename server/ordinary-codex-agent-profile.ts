import {
  AgentLibraryVersionSchema,
  PROFILE_BUILDER_ID,
  PROFILE_BUILDER_REVISION,
  type AgentLibraryVersion,
  type AgentProfileSelection,
} from '@mitzo/protocol';
import type { AgentLibraryStore } from './agent-library-store.js';
import { readBuiltinAgentLibraryProfile } from './agent-library-transport.js';
import { contextDigest } from './agent-context-compiler.js';
import type { SandboxAgentPresets } from './agent-context-sandbox.js';

/** Reuses the Library's existing namespaces; this projection cannot publish profiles. */
export function readOrdinaryCodexAgentProfile(
  library: Pick<AgentLibraryStore, 'version'>,
  selection: AgentProfileSelection,
): AgentLibraryVersion | null {
  return selection.kind === 'builtin'
    ? readBuiltinAgentLibraryProfile(selection)
    : library.version('user', selection.profileId, selection.revision);
}
export function ordinaryCodexAgentProfiles(
  versions: readonly AgentLibraryVersion[],
): AgentLibraryVersion[] {
  const builtin = readBuiltinAgentLibraryProfile({
    kind: 'builtin',
    profileId: PROFILE_BUILDER_ID,
    revision: PROFILE_BUILDER_REVISION,
  })!;
  return [
    builtin,
    ...versions.filter(
      (profile) =>
        AgentLibraryVersionSchema.safeParse(profile).success &&
        profile.contentHash === contextDigest(profile.definition) &&
        profile.kind === undefined &&
        profile.definition.contextRecipe?.source !== 'packs',
    ),
  ];
}

/** Configuration-only eligibility on existing account/target routes, never source grants. */
export function ordinaryCodexAgentProfileRouteProjection(
  profiles: readonly AgentLibraryVersion[],
  provider: string,
  location: 'local' | 'openshell',
  presets?: SandboxAgentPresets,
  policy: { contextRecipes: 'supported' | 'none' } = { contextRecipes: 'supported' },
) {
  const agentProfiles: AgentProfileSelection[] = [];
  const agentProfileRejections: {
    agent: AgentProfileSelection;
    reason:
      | 'provider_incompatible'
      | 'sandbox_context_preset_unconfigured'
      | 'native_pack_context_unavailable'
      | 'native_context_unavailable';
  }[] = [];
  for (const profile of profiles) {
    const agent = {
      profileId: profile.profileId,
      revision: profile.revision,
      ...(profile.kind ? { kind: profile.kind } : {}),
    };
    const recipe = profile.definition.contextRecipe;
    const reason =
      profile.definition.recipe &&
      !profile.definition.recipe.compatibleProviders.some((candidate) => candidate === provider)
        ? 'provider_incompatible'
        : recipe && policy.contextRecipes === 'none'
          ? 'native_context_unavailable'
          : recipe?.source === 'packs'
            ? 'native_pack_context_unavailable'
            : recipe?.source === 'contexgin' &&
                location === 'openshell' &&
                !presets?.[recipe.agentName]
              ? 'sandbox_context_preset_unconfigured'
              : undefined;
    if (reason) agentProfileRejections.push({ agent, reason });
    else agentProfiles.push(agent);
  }
  return { agentProfiles, agentProfileRejections };
}

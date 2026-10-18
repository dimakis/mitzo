import { resolveChatAgentProfile } from './agent-library-binding.js';
import {
  AgentLibraryVersionSchema,
  PROFILE_BUILDER_ID,
  PROFILE_BUILDER_REVISIONS,
  type AgentLibraryVersion,
  type AgentProfileSelection,
} from '@mitzo/protocol';
import type { AgentLibraryStore } from './agent-library-store.js';
import { readBuiltinAgentLibraryProfile } from './agent-library-transport.js';
import { contextDigest } from './agent-context-compiler.js';
import { agentToolReferenceSupportsRoute } from './agent-tool-selection.js';
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
  const builtins = PROFILE_BUILDER_REVISIONS.map((revision) =>
    readBuiltinAgentLibraryProfile({ kind: 'builtin', profileId: PROFILE_BUILDER_ID, revision })!,
  );
  return [
    ...builtins,
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
  policy: {
    contextRecipes: 'supported' | 'none';
    toolSelection?: boolean;
    toolRoute?: string;
  } = {
    contextRecipes: 'supported',
  },
) {
  const agentProfiles: AgentProfileSelection[] = [];
  const agentProfileRejections: {
    agent: AgentProfileSelection;
    reason:
      | 'provider_incompatible'
      | 'sandbox_context_preset_unconfigured'
      | 'native_pack_context_unavailable'
      | 'native_context_unavailable'
      | 'tool_selection_unavailable';
  }[] = [];
  for (const profile of profiles) {
    const agent = {
      profileId: profile.profileId,
      revision: profile.revision,
      ...(profile.kind ? { kind: profile.kind } : {}),
    };
    const recipe = profile.definition.contextRecipe;
    const reason =
      profile.definition.tools !== undefined &&
      (!policy.toolSelection ||
        location !== 'local' ||
        profile.definition.tools.some(
          (ref) => !agentToolReferenceSupportsRoute(ref, policy.toolRoute ?? 'local-api'),
        ))
        ? 'tool_selection_unavailable'
        : profile.definition.recipe &&
            !profile.definition.recipe.compatibleProviders.some(
              (candidate) => candidate === provider,
            )
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

/** Enrollment follows the authenticated execution target, independently of account provider. */
export function resolveOrdinaryCodexAgentProfile(
  input: Omit<Parameters<typeof resolveChatAgentProfile>[0], 'toolRoute'> & {
    execution: { location: 'local' | 'openshell' };
  },
) {
  const { execution, ...profile } = input;
  return resolveChatAgentProfile({
    ...profile,
    toolRoute: execution.location === 'local' ? 'codex-owned-local' : 'openshell',
  });
}

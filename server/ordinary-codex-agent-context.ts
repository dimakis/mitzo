import { isDeepStrictEqual } from 'node:util';
import {
  AgentContextSnapshotSchema,
  AgentLibraryVersionSchema,
  type AgentContextSnapshot,
  type AgentLibraryVersion,
  type OrdinaryLocalCommandAdmission,
} from '@mitzo/protocol';
import { contextDigest } from './agent-context-compiler.js';
import { assertNativeCodexContextAdmission } from './native-codex-context-admission.js';

/** A prepared snapshot binds the admitted recipe; it cannot select another source or profile. */
export function assertOrdinaryCodexContextIdentity(
  profile: AgentLibraryVersion | undefined,
  selection: OrdinaryLocalCommandAdmission['selection'],
  snapshot?: AgentContextSnapshot,
  provider?: string,
): void {
  const parsed = profile && AgentLibraryVersionSchema.parse(profile);
  if (
    !parsed ||
    parsed.contentHash !== contextDigest(parsed.definition) ||
    !isDeepStrictEqual(
      {
        profileId: parsed.profileId,
        revision: parsed.revision,
        ...(parsed.kind ? { kind: parsed.kind } : {}),
      },
      selection.agent,
    )
  )
    throw Error('Ordinary Codex agent profile changed');
  const recipe = parsed.definition.contextRecipe;
  if (
    provider &&
    parsed.definition.recipe &&
    !parsed.definition.recipe.compatibleProviders.some((candidate) => candidate === provider)
  )
    throw Error('Agent profile is not compatible with the selected provider');
  assertNativeCodexContextAdmission(recipe, snapshot);
  if (
    !isDeepStrictEqual(
      selection.context,
      recipe
        ? { source: recipe.source, revision: contextDigest(recipe) }
        : { source: 'none', revision: null },
    )
  )
    throw Error('Ordinary Codex context selection changed');
  if (!snapshot) return;
  const saved = AgentContextSnapshotSchema.parse(snapshot);
  if (
    !recipe ||
    saved.profileId !== parsed.profileId ||
    saved.revision !== parsed.revision ||
    saved.profileHash !== parsed.contentHash ||
    saved.recipeHash !== contextDigest(recipe) ||
    saved.source !== recipe.source ||
    saved.payloadHash !==
      contextDigest(
        saved.provenance ? { context: saved.context, provenance: saved.provenance } : saved.context,
      )
  )
    throw Error('Ordinary Codex context snapshot changed');
}

export function ordinaryCodexSnapshotCustody(
  profile?: AgentLibraryVersion,
  snapshot?: AgentContextSnapshot,
) {
  return {
    ...(profile ? { agentProfileSha256: contextDigest(profile) } : {}),
    ...(snapshot ? { agentContextSha256: contextDigest(snapshot) } : {}),
  };
}
/** Existing native custody distinguishes retained developer context from mutable public metadata. */
export function assertOrdinaryCodexSnapshotCustody(
  custody: { agentProfileSha256?: string; agentContextSha256?: string },
  profile?: AgentLibraryVersion,
  snapshot?: AgentContextSnapshot,
) {
  const expected = ordinaryCodexSnapshotCustody(profile, snapshot);
  if (
    (profile?.definition.contextRecipe &&
      (!custody.agentContextSha256 || !custody.agentProfileSha256)) ||
    (custody.agentProfileSha256 && custody.agentProfileSha256 !== expected.agentProfileSha256) ||
    (custody.agentContextSha256 && custody.agentContextSha256 !== expected.agentContextSha256)
  )
    throw Error('Retained native Codex context custody changed');
}

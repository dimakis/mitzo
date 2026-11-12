import { createHash } from 'node:crypto';
import {
  PROFILE_BUILDER_ID,
  profileBuilderDefinitionForRevision,
  DEFAULT_MITZO_PROFILE_ID,
  DEFAULT_MITZO_PROFILE_REVISION,
  defaultMitzoProfileDefinition,
  type AgentProfileSelection,
  SymposiumProfileDefinitionSchema,
} from '@mitzo/protocol';

/** Internal feature purpose; deliberately absent from the interactive catalog. */
export const FEATURE_TEXT_PROFILE = {
  kind: 'builtin',
  profileId: 'mitzo-feature-text',
  revision: 1,
} as const;
const featureTextDefinition = SymposiumProfileDefinitionSchema.parse({
  name: 'Feature text inference',
  descriptor: 'Isolated inference over explicitly supplied evidence',
  role: 'adviser',
  instructions:
    'Use only the supplied feature instructions and evidence. No tools or ambient context are available.',
  expectedOutput: 'The response required by the owning feature contract',
  acceptanceCriteria: ['Preserve the original account and exact supplied context'],
  modelPolicyRole: 'adviser',
  tools: [],
});

/** Code-owned identity, also retained verbatim for legacy custody verification. */
export function readBuiltinAgentLibraryProfile(selection: AgentProfileSelection) {
  if (selection.kind !== 'builtin') return null;
  const definition =
    selection.profileId === FEATURE_TEXT_PROFILE.profileId &&
    selection.revision === FEATURE_TEXT_PROFILE.revision
      ? structuredClone(featureTextDefinition)
      : selection.profileId === DEFAULT_MITZO_PROFILE_ID &&
          selection.revision === DEFAULT_MITZO_PROFILE_REVISION
        ? structuredClone(defaultMitzoProfileDefinition)
        : selection.profileId === PROFILE_BUILDER_ID
          ? profileBuilderDefinitionForRevision(selection.revision)
          : undefined;
  if (!definition) return null;
  return {
    kind: 'builtin' as const,
    profileId: selection.profileId,
    revision: selection.revision,
    definition,
    contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
  };
}

import { createHash } from 'node:crypto';
import {
  PROFILE_BUILDER_ID,
  profileBuilderDefinitionForRevision,
  DEFAULT_MITZO_PROFILE_ID,
  DEFAULT_MITZO_PROFILE_REVISION,
  defaultMitzoProfileDefinition,
  type AgentProfileSelection,
} from '@mitzo/protocol';

/** Code-owned identity, also retained verbatim for legacy custody verification. */
export function readBuiltinAgentLibraryProfile(selection: AgentProfileSelection) {
  if (selection.kind !== 'builtin') return null;
  const definition =
    selection.profileId === DEFAULT_MITZO_PROFILE_ID &&
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

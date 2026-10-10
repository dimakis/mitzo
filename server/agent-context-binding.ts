import {
  AgentContextSnapshotSchema,
  type AgentContextSnapshot,
  type AgentLibraryVersion,
} from '@mitzo/protocol';
import {
  compileAgentContext,
  verifyCompiledAgentContext,
  type AgentContextCompileOptions,
} from './agent-context-compiler.js';

/** Context selection cannot enroll another execution location or issue a source grant. */
export async function resolveChatAgentContext(input: {
  profile?: AgentLibraryVersion;
  stored?: AgentContextSnapshot;
  workspaceRoot?: string;
  packs?: AgentContextCompileOptions['packs'];
  signal: AbortSignal;
}): Promise<AgentContextSnapshot | undefined> {
  const profile = input.profile;
  const recipe = profile?.definition.contextRecipe;
  if (!recipe) {
    if (input.stored) throw Error('Saved compiled context has no matching agent recipe');
    return undefined;
  }
  if (input.stored) {
    const snapshot = AgentContextSnapshotSchema.parse(input.stored);
    const { profileId, revision, profileHash, ...compiled } = snapshot;
    if (
      profileId !== profile.profileId ||
      revision !== profile.revision ||
      profileHash !== profile.contentHash
    )
      throw Error('Saved compiled context belongs to another agent profile');
    await verifyCompiledAgentContext(compiled, recipe, input);
    return snapshot;
  }
  const compiled = await compileAgentContext(recipe, input);
  input.signal.throwIfAborted();
  return AgentContextSnapshotSchema.parse({
    ...compiled,
    profileId: profile.profileId,
    revision: profile.revision,
    profileHash: profile.contentHash,
  });
}

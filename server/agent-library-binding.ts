import { createHash } from 'node:crypto';
import {
  AgentLibraryVersionSchema,
  type AgentLibraryVersion,
  type AgentProfileSelection,
} from '@mitzo/protocol';
import { PortableProfileDefinitionSchema } from './symposium-profile-portability.js';

export async function resolveChatAgentProfile(input: {
  requested?: AgentProfileSelection;
  stored?: AgentLibraryVersion;
  resume?: boolean;
  provider?: string;
  lookup(selection: AgentProfileSelection): Promise<AgentLibraryVersion | null>;
}): Promise<AgentLibraryVersion | undefined> {
  if (
    input.resume &&
    input.requested &&
    (!input.stored ||
      input.requested.profileId !== input.stored.profileId ||
      input.requested.revision !== input.stored.revision)
  )
    throw Error('Choose a new chat to change its agent profile');
  const raw = input.stored ?? (input.requested ? await input.lookup(input.requested) : undefined);
  if (!raw) {
    if (input.requested) throw Error('Published agent profile revision not found');
    return undefined;
  }
  const snapshot = AgentLibraryVersionSchema.parse(raw);
  const definition = PortableProfileDefinitionSchema.parse(snapshot.definition);
  if (
    input.requested &&
    (snapshot.profileId !== input.requested.profileId ||
      snapshot.revision !== input.requested.revision)
  )
    throw Error('Agent profile identity mismatch');
  if (
    createHash('sha256').update(JSON.stringify(definition)).digest('hex') !== snapshot.contentHash
  )
    throw Error('Agent profile content hash mismatch');
  if (definition.recipe && !input.provider)
    throw Error('Choose an explicit account to verify agent profile provider compatibility');
  if (
    input.provider &&
    definition.recipe &&
    !definition.recipe.compatibleProviders.some((provider) => provider === input.provider)
  )
    throw Error('Agent profile is not compatible with the selected provider');
  return { ...snapshot, definition };
}

import { isDeepStrictEqual } from 'node:util';
import {
  TelosRepositoryChatSettingsSchema,
  type SessionRuntimeBindingV2,
  type TelosOrdinaryWorkRoleSetupInput,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import { TelosWorkError } from './telos-work-store.js';
import { TelosAdoptionRefusal } from './telos-existing-chat-adoption.js';
import type { TelosOrdinaryWorkSelection } from './telos-ordinary-work-role-setup.js';

/** Requalifies an existing Local Mac Claude SDK chat selected for reviewed
 * adoption. The chat keeps its account, model, agent profile, repository task
 * and history: everything is read from its retained custody, never selected
 * again, and nothing (credential, grant, permission) is copied or transferred. */
export async function resolveTelosRepositoryChatSelection(
  input: TelosOrdinaryWorkRoleSetupInput,
  signal: AbortSignal,
  deps: {
    events: EventStore;
    workspaces: RepositoryWorkspaces;
    /** Host route availability: current compatible binding for this exact chat. */
    resolveRuntime(
      settings: ReturnType<typeof TelosRepositoryChatSettingsSchema.parse>,
      continuation: { conversationId: string; workspaceId: string },
    ): Promise<SessionRuntimeBindingV2 | undefined>;
  },
): Promise<TelosOrdinaryWorkSelection> {
  signal.throwIfAborted();
  const settings = TelosRepositoryChatSettingsSchema.parse(input.settings);
  const adoption = input.adoption;
  if (
    adoption?.workspaceKind !== 'repository' ||
    adoption.workspaceId !== settings.workspace.workspaceId
  )
    throw new TelosWorkError('invalid', 'Repository settings require exact existing-chat adoption');
  const conversationId = adoption.conversationId;
  const session = deps.events.getSession(conversationId);
  const custody = deps.events.getOrdinaryLocalVertexCustody(conversationId);
  const profile = session?.agentProfile;
  if (
    !session?.accountBinding ||
    !session.cwd ||
    !profile ||
    !custody ||
    session.repositoryWorkspaceId !== settings.workspace.workspaceId ||
    profile.profileId !== settings.selection.agent.profileId ||
    profile.revision !== settings.selection.agent.revision ||
    (profile.kind ?? null) !== (settings.selection.agent.kind ?? null) ||
    session.accountBinding.accountId !== settings.binding.account.accountId ||
    session.accountBinding.provider !== settings.binding.account.provider ||
    session.accountBinding.profileRevision !== settings.binding.account.profileRevision
  )
    throw new TelosAdoptionRefusal('existing_chat_incompatible');
  const current = await deps.resolveRuntime(settings, {
    conversationId,
    workspaceId: settings.workspace.workspaceId,
  });
  signal.throwIfAborted();
  if (!current || !isDeepStrictEqual(current, settings.binding))
    throw new TelosWorkError(
      'invalid',
      'The adopted Claude chat account or Local Mac target is unavailable on this host',
    );
  const workspace = deps.workspaces.getForConversation(conversationId);
  const taskRoot = workspace?.hostReservation?.taskRoot;
  if (!workspace || workspace.id !== settings.workspace.workspaceId || !taskRoot)
    throw new TelosAdoptionRefusal('existing_chat_incompatible');
  await deps.workspaces.validateHostTask(conversationId, session.cwd);
  signal.throwIfAborted();
  return { binding: session.accountBinding, agentProfile: profile, taskRoot };
}

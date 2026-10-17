import {
  AgentLibrarySourceContentSchema,
  AgentLibrarySourceSnapshotSchema,
  PROFILE_BUILDER_ID,
  PROFILE_BUILDER_REVISION,
} from '@mitzo/protocol';
import { sha256Hex } from './browser-crypto';
import {
  createChatDraft,
  getChatDraft,
  saveChatDraft,
  chatDraftUrl,
  type ChatDraft,
} from './chat-drafts';
import { briefingCommandHandoff } from './briefing-registration';
import type { AgentLibraryEditor } from './agent-library-working-copy';

const prefix = 'mitzo-agent-builder-chat:';
function retained(
  revision: string,
): { draftId: string; sessionId?: string; pendingCommandId?: string } | null {
  const raw = localStorage.getItem(prefix + revision);
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== 'object' ||
    !('draftId' in value) ||
    typeof value.draftId !== 'string' ||
    ('sessionId' in value && typeof value.sessionId !== 'string')
  )
    throw Error('Could not read the retained Agent Builder conversation. Retry.');
  return value as { draftId: string; sessionId?: string; pendingCommandId?: string };
}
/** Save the exact reviewed Library input before entering the ordinary composer. */
export function openAgentBuilderChat(
  editor: AgentLibraryEditor,
  dirty: boolean,
  contentHash?: string,
  reviewedContext?: string,
): string {
  const content = JSON.stringify(
    AgentLibrarySourceContentSchema.parse({
      version: 1,
      source:
        !dirty && editor.publishedRevision && contentHash
          ? {
              kind: 'published',
              profileId: editor.profileId,
              revision: editor.publishedRevision,
              contentHash,
            }
          : {
              kind: 'draft',
              profileId: editor.profileId,
              baseRevision: editor.baseRevision,
              draftVersion: !dirty && editor.expectedVersion > 0 ? editor.expectedVersion : null,
              expectedVersion: editor.expectedVersion,
            },
      definition: editor.definition,
      ...(reviewedContext ? { reviewedContext } : {}),
    }),
  );
  const source = AgentLibrarySourceSnapshotSchema.parse({
    kind: 'agent-library',
    revision: sha256Hex(content),
    content,
  });
  const prior = retained(source.revision);
  if (prior?.sessionId) return `/chat/${encodeURIComponent(prior.sessionId)}`;
  const existing = prior && getChatDraft(prior.draftId);
  if (existing) return chatDraftUrl(existing);
  const draft = createChatDraft();
  if (prior) draft.id = prior.draftId;
  draft.text = editor.definition.name ? 'Help me refine this agent.' : 'Help me create an agent.';
  draft.settings.sourceSnapshots = [source];
  draft.settings.search = new URLSearchParams({
    agentProfile: PROFILE_BUILDER_ID,
    agentProfileKind: 'builtin',
    profileRevision: String(PROFILE_BUILDER_REVISION),
  }).toString();
  if (!saveChatDraft(draft))
    throw Error('Could not save the Agent Builder draft. Your profile edits were kept.');
  try {
    localStorage.setItem(prefix + source.revision, JSON.stringify({ draftId: draft.id }));
  } catch {
    throw Error('Could not retain the Agent Builder conversation. Your profile edits were kept.');
  }
  return chatDraftUrl(draft);
}
/** Only the ordinary send owner's acknowledged assignment establishes this link. */
export function markAgentBuilderAssigned(draft: ChatDraft, sessionId: string): void {
  const source = draft.settings.sourceSnapshots?.find((entry) => entry.kind === 'agent-library');
  if (!source) return;
  const prior = retained(source.revision);
  if (!prior || prior.draftId !== draft.id || (prior.sessionId && prior.sessionId !== sessionId))
    return;
  localStorage.setItem(prefix + source.revision, JSON.stringify({ draftId: draft.id, sessionId }));
}

const commandPrefix = prefix + 'command:';
/** The bootstrap owner survives composer unmount and a recreated application. */
export const agentBuilderCommandHandoff = {
  prepare(command: Record<string, unknown>): boolean {
    const payload = command.payload as { sourceSnapshots?: unknown[] } | undefined;
    const sources = command.sourceSnapshots ?? payload?.sourceSnapshots;
    if (!Array.isArray(sources) || sources[0]?.kind !== 'agent-library')
      return briefingCommandHandoff.prepare(command);
    try {
      const source = AgentLibrarySourceSnapshotSchema.parse(sources[0]);
      const prior = retained(source.revision);
      if (
        !prior ||
        prior.sessionId ||
        typeof command.clientMsgId !== 'string' ||
        (prior.pendingCommandId && prior.pendingCommandId !== command.clientMsgId)
      )
        return false;
      localStorage.setItem(commandPrefix + command.clientMsgId, source.revision);
      localStorage.setItem(
        prefix + source.revision,
        JSON.stringify({ ...prior, pendingCommandId: command.clientMsgId }),
      );
      return true;
    } catch {
      return false;
    }
  },
  assign(clientMsgId: string, sessionId: string, hint?: Record<string, unknown>): void {
    const stored = localStorage.getItem(commandPrefix + clientMsgId);
    const revision =
      stored ??
      (hint?.kind === 'agent-library' && typeof hint.revision === 'string' ? hint.revision : null);
    if (!revision) {
      briefingCommandHandoff.assign(clientMsgId, sessionId, hint);
      return;
    }
    const prior = retained(revision);
    if (
      !prior ||
      (prior.sessionId && prior.sessionId !== sessionId) ||
      (prior.pendingCommandId && prior.pendingCommandId !== clientMsgId)
    )
      throw Error(
        'Agent Builder conversation assignment changed. Keep the original command for recovery.',
      );
    localStorage.setItem(prefix + revision, JSON.stringify({ draftId: prior.draftId, sessionId }));
    localStorage.removeItem(commandPrefix + clientMsgId);
  },
  reject(clientMsgId: string): void {
    const revision = localStorage.getItem(commandPrefix + clientMsgId);
    if (!revision) {
      briefingCommandHandoff.reject(clientMsgId);
      return;
    }
    const prior = retained(revision);
    if (prior?.pendingCommandId === clientMsgId)
      localStorage.setItem(
        prefix + revision,
        JSON.stringify({
          draftId: prior.draftId,
          ...(prior.sessionId ? { sessionId: prior.sessionId } : {}),
        }),
      );
    localStorage.removeItem(commandPrefix + clientMsgId);
  },
};

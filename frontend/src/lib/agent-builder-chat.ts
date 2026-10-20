import {
  AgentLibrarySourceContentSchema,
  AgentLibrarySourceSnapshotSchema,
  PROFILE_BUILDER_ID,
  PROFILE_BUILDER_REVISION,
  profileBuilderDefinitionForRevision,
} from '@mitzo/protocol';
import { apiFetch } from './api-fetch';
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
function retained(revision: string): {
  draftId: string;
  sessionId?: string;
  pendingCommandId?: string;
  profileRevision?: number;
} | null {
  const raw = localStorage.getItem(prefix + revision);
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== 'object' ||
    !('draftId' in value) ||
    typeof value.draftId !== 'string' ||
    ('sessionId' in value && typeof value.sessionId !== 'string') ||
    ('pendingCommandId' in value && typeof value.pendingCommandId !== 'string') ||
    ('profileRevision' in value &&
      (typeof value.profileRevision !== 'number' ||
        !profileBuilderDefinitionForRevision(value.profileRevision)))
  )
    throw Error('Could not read the retained Agent Builder conversation. Retry.');
  return value as {
    draftId: string;
    sessionId?: string;
    pendingCommandId?: string;
    profileRevision?: number;
  };
}
/** Save the exact reviewed Library input before entering the ordinary composer. */
export async function openAgentBuilderChat(
  editor: AgentLibraryEditor,
  dirty: boolean,
  contentHash?: string,
  reviewedContext?: string,
): Promise<string> {
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
  let prior = retained(source.revision);
  if (prior?.sessionId) {
    let hidden: boolean;
    try {
      const response = await apiFetch(`/api/sessions/${encodeURIComponent(prior.sessionId)}/meta`);
      if (!response.ok) throw Error('Conversation visibility unavailable');
      const meta: unknown = await response.json();
      if (
        !meta ||
        typeof meta !== 'object' ||
        !('sessionId' in meta) ||
        meta.sessionId !== prior.sessionId ||
        !('isHidden' in meta) ||
        typeof meta.isHidden !== 'boolean'
      )
        throw Error('Conversation visibility missing');
      hidden = meta.isHidden;
    } catch {
      throw Error(
        'Could not verify the retained Agent Builder conversation. Its link was kept. Retry before opening another conversation.',
      );
    }
    // The read may yield to another tab or an admission receipt. Release/reuse
    // only the exact ownership record whose visibility was just observed.
    if (JSON.stringify(retained(source.revision)) !== JSON.stringify(prior))
      throw Error(
        'The retained Agent Builder conversation changed during its visibility check. Retry.',
      );
    if (!hidden) return `/chat/${encodeURIComponent(prior.sessionId)}`;
    localStorage.removeItem(prefix + source.revision);
    prior = null;
  }
  const existing = prior && getChatDraft(prior.draftId);
  if (existing) return chatDraftUrl(existing);
  const draft = createChatDraft();
  if (prior) draft.id = prior.draftId;
  draft.text = editor.definition.name ? 'Help me refine this agent.' : 'Help me create an agent.';
  draft.settings.sourceSnapshots = [source];
  const guidanceRevision = prior?.profileRevision ?? (prior ? 1 : PROFILE_BUILDER_REVISION);
  draft.settings.search = new URLSearchParams({
    agentProfile: PROFILE_BUILDER_ID,
    agentProfileKind: 'builtin',
    profileRevision: String(guidanceRevision),
  }).toString();
  if (!saveChatDraft(draft))
    throw Error('Could not save the Agent Builder draft. Your profile edits were kept.');
  try {
    localStorage.setItem(
      prefix + source.revision,
      JSON.stringify({ ...prior, draftId: draft.id, profileRevision: guidanceRevision }),
    );
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
  localStorage.setItem(
    prefix + source.revision,
    JSON.stringify({ draftId: draft.id, sessionId, profileRevision: prior.profileRevision }),
  );
}

const commandPrefix = prefix + 'command:';
type CommandReceipt = { revision: string; sessionId?: string };
function commandReceipt(clientMsgId: string): CommandReceipt | null {
  const raw = localStorage.getItem(commandPrefix + clientMsgId);
  if (!raw) return null;
  // Older pending records stored just their reviewed source hash.
  if (/^[a-f0-9]{64}$/.test(raw)) return { revision: raw };
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== 'object' ||
    !('revision' in value) ||
    typeof value.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.revision) ||
    ('sessionId' in value && (typeof value.sessionId !== 'string' || !value.sessionId))
  )
    throw Error(
      'Agent Builder command ownership is unavailable. Keep the original command for recovery.',
    );
  return value as CommandReceipt;
}
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
      const receipt = commandReceipt(command.clientMsgId);
      if (receipt && (receipt.revision !== source.revision || receipt.sessionId)) return false;
      localStorage.setItem(
        commandPrefix + command.clientMsgId,
        JSON.stringify({ revision: source.revision }),
      );
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
    const receipt = commandReceipt(clientMsgId);
    const revision =
      receipt?.revision ??
      (hint?.kind === 'agent-library' && typeof hint.revision === 'string' ? hint.revision : null);
    if (!revision) {
      briefingCommandHandoff.assign(clientMsgId, sessionId, hint);
      return;
    }
    const prior = retained(revision);
    if (receipt?.sessionId) {
      if (receipt.sessionId !== sessionId)
        throw Error(
          'Agent Builder command assignment changed. Keep the original command for recovery.',
        );
      // Complete a partial write to this command's original pending owner.
      // A later source intent must never be rebound by this historical receipt.
      if (prior?.pendingCommandId !== clientMsgId) return;
    }
    if (
      !prior ||
      (prior.sessionId && prior.sessionId !== sessionId) ||
      (prior.pendingCommandId
        ? prior.pendingCommandId !== clientMsgId
        : prior.sessionId !== sessionId)
    )
      throw Error(
        'Agent Builder conversation assignment changed. Keep the original command for recovery.',
      );
    // Write the historical receipt first. If the source write fails, its pending
    // identity remains and the exact outbox retry completes that assignment.
    localStorage.setItem(commandPrefix + clientMsgId, JSON.stringify({ revision, sessionId }));
    localStorage.setItem(
      prefix + revision,
      JSON.stringify({ draftId: prior.draftId, sessionId, profileRevision: prior.profileRevision }),
    );
  },
  reject(clientMsgId: string): void {
    const receipt = commandReceipt(clientMsgId);
    if (!receipt) {
      briefingCommandHandoff.reject(clientMsgId);
      return;
    }
    if (receipt.sessionId) return;
    const revision = receipt.revision;
    const prior = retained(revision);
    if (prior?.pendingCommandId === clientMsgId)
      localStorage.setItem(
        prefix + revision,
        JSON.stringify({
          draftId: prior.draftId,
          profileRevision: prior.profileRevision,
          ...(prior.sessionId ? { sessionId: prior.sessionId } : {}),
        }),
      );
    localStorage.removeItem(commandPrefix + clientMsgId);
  },
};

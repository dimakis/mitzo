import { chatStorage, chatStorageKeys } from './large-chat-storage';
import { z } from 'zod';
import {
  SourceSnapshotsSchema,
  SessionCollaborationIdSchema,
  CollaborationMessageInputSchema,
  SessionRuntimeBindingV1Schema,
} from '@mitzo/protocol';
import { createBrowserId } from './browser-crypto';
import { allowComposerDraftPersistence } from './composer-draft-proof';
import { getDefaultAccountModel } from './account-preference';
import {
  ChatRuntimeSelectionSchema,
  chatAgentProfileFromSearch,
  retainChatRuntimeSelection,
} from './chat-runtime-selection';

const PREFIX = 'mitzo-chat-draft:';
export function chatDraftStorageKey(id: string) {
  return PREFIX + id;
}
export function chatDraftIdFromKey(key: string): string | null {
  return key.startsWith(PREFIX) ? key.slice(PREFIX.length) : null;
}
export const CHAT_DRAFTS_CHANGED = 'mitzo-chat-drafts-changed';
export const ChatDraftSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  text: z.string(),
  images: z.array(
    z.object({
      data: z.string(),
      preview: z.string(),
      mediaType: z.string(),
      name: z.string().optional(),
    }),
  ),
  contextBlocks: z.array(z.string()),
  updatedAt: z.number(),
  settings: z.object({
    // Draft routing intent only; this never grants read or execution authority.
    collaborationResponders: z
      .object({
        collaborationId: SessionCollaborationIdSchema,
        responders: CollaborationMessageInputSchema.shape.responders,
      })
      .optional(),
    sourceSnapshots: SourceSnapshotsSchema.optional(),
    launch: z
      .object({
        prompt: z.string(),
        // Private reviewed UI evidence; never server admission or wire authority.
        reviewedRoute: z
          .strictObject({
            inventoryRevision: z.string().min(1),
            capabilityRevision: z.string().min(1),
            account: SessionRuntimeBindingV1Schema.shape.account,
            location: z.enum(['local', 'openshell']),
            targetId: z.string().min(1),
            harness: z.enum(['codex', 'responses', 'claude-sdk', 'gemini']),
          })
          .optional(),
        context: z.string(),
        contextBlocks: z.array(z.string()).optional(),
        sourceSnapshots: SourceSnapshotsSchema.optional(),
        accountSelection: z
          .object({
            accountId: z.string(),
            model: z.string(),
            reasoningEffort: z.string().nullable().optional(),
          })
          .optional(),
        briefing: z.object({ date: z.string(), revision: z.string() }).optional(),
        telosTaskId: z.string().optional(),
        agentName: z.string().optional(),
      })
      .optional(),
    // Additive intent only; old drafts keep their original version and unknown location.
    runtimeSelection: ChatRuntimeSelectionSchema.nullable().optional(),
    retainRuntimeIntent: z.boolean().optional(),
    selection: z
      .object({
        accountId: z.string().optional(),
        model: z.string(),
        reasoningEffort: z.string().nullable().optional(),
      })
      .nullable(),
    mode: z.enum(['ask', 'agent', 'auto']),
    isolation: z.boolean(),
    repositoryWorkspaceId: z.uuid().nullable().optional(),
    search: z.string(),
    summary: z
      .object({
        profile: z.string(),
        model: z.string().optional(),
        thinking: z.string().optional(),
      })
      .nullable(),
  }),
});
export type ChatDraft = z.infer<typeof ChatDraftSchema>;
export type ChatDraftContent = Pick<ChatDraft, 'text' | 'images' | 'contextBlocks'>;
export function createChatDraft(): ChatDraft {
  return {
    version: 1,
    id: createBrowserId(),
    text: '',
    images: [],
    contextBlocks: [],
    updatedAt: Date.now(),
    settings: { selection: null, mode: 'agent', isolation: true, search: '', summary: null },
  };
}
export function getChatDraft(id: string): ChatDraft | null {
  try {
    const parsed = ChatDraftSchema.safeParse(
      JSON.parse(chatStorage.getItem(PREFIX + id) || 'null'),
    );
    if (!parsed.success || parsed.data.id !== id) return null;
    const draft = parsed.data;
    if (draft.settings.runtimeSelection) {
      const params = new URLSearchParams(draft.settings.search);
      draft.settings.runtimeSelection = retainChatRuntimeSelection(
        draft.settings.runtimeSelection,
        draft.settings.selection,
        params.has('agentProfile') ||
          params.has('profileRevision') ||
          params.has('agentProfileKind')
          ? chatAgentProfileFromSearch(draft.settings.search)
          : undefined,
      );
    }
    return draft;
  } catch {
    return null;
  }
}
export function listChatDrafts(): ChatDraft[] {
  try {
    return chatStorageKeys()
      .filter((key) => key.startsWith(PREFIX))
      .flatMap((key) => {
        const draft = getChatDraft(key.slice(PREFIX.length));
        return draft ? [draft] : [];
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}
function changed() {
  window.dispatchEvent(new Event(CHAT_DRAFTS_CHANGED));
}
export function saveChatDraft(draft: ChatDraft): boolean {
  try {
    if (!allowComposerDraftPersistence(chatDraftStorageKey(draft.id))) return false;
    if (
      !draft.text.trim() &&
      !draft.images.length &&
      !draft.contextBlocks.length &&
      !draft.settings.repositoryWorkspaceId &&
      !draft.settings.launch &&
      !draft.settings.sourceSnapshots?.length &&
      !draft.settings.retainRuntimeIntent &&
      !draft.settings.collaborationResponders
    )
      chatStorage.removeItem(PREFIX + draft.id);
    else
      chatStorage.setItem(PREFIX + draft.id, JSON.stringify({ ...draft, updatedAt: Date.now() }));
    changed();
    return true;
  } catch {
    return false;
  }
}
export function deleteChatDraft(id: string, options: { preserveText?: boolean } = {}): boolean {
  try {
    if (!allowComposerDraftPersistence(chatDraftStorageKey(id))) return false;
    chatStorage.removeItem(PREFIX + id);
    if (!options.preserveText) chatStorage.removeItem(chatDraftTextKey(id));
    changed();
    return true;
  } catch {
    return false;
  }
}
export function chatDraftTextKey(id: string) {
  return `mitzo-chat-draft-text:${id}`;
}
export function consumeChatDraft(
  submitted: ChatDraft,
  options: { preserveText?: boolean } = {},
): boolean {
  const saved = getChatDraft(submitted.id);
  if (
    !saved ||
    JSON.stringify({
      text: saved.text,
      images: saved.images,
      contextBlocks: saved.contextBlocks,
      settings: saved.settings,
    }) !==
      JSON.stringify({
        text: submitted.text,
        images: submitted.images,
        contextBlocks: submitted.contextBlocks,
        settings: submitted.settings,
      })
  )
    return false;
  return deleteChatDraft(submitted.id, options);
}
export function migrateLegacyChatDraft(): void {
  try {
    const text = chatStorage.getItem('mitzo-draft-new');
    if (!text?.trim()) return;
    // Older open tabs may still write the shared key after migration. Preserve
    // each distinct message, while retries of the same content remain idempotent.
    const migrated = listChatDrafts().find(
      (draft) => draft.id.startsWith('legacy-') && draft.text === text,
    );
    if (!migrated) {
      const existing = getChatDraft('legacy-new-chat');
      const fresh = createChatDraft();
      const draft = { ...fresh, id: existing ? `legacy-${fresh.id}` : 'legacy-new-chat', text };
      draft.settings.selection = getDefaultAccountModel();
      if (!saveChatDraft(draft)) return;
    }
    chatStorage.removeItem('mitzo-draft-new');
  } catch {
    /* Keep the original if storage is unavailable. */
  }
}
export function chatDraftUrl(draft: ChatDraft): string {
  const params = new URLSearchParams(draft.settings.search);
  params.delete('prompt');
  params.set('draft', draft.id);
  return `/chat?${params}`;
}

/** Copy only unsent text; the new chat chooses its own account and runtime. */
export function newChatPathWithDraft(text: string): string {
  if (!text.trim()) return '/chat';
  const draft = createChatDraft();
  draft.text = text;
  if (!saveChatDraft(draft)) throw new Error('Could not save the new chat draft. Retry.');
  return `/chat?draft=${encodeURIComponent(draft.id)}`;
}

const DraftSessionBindingSchema = z.strictObject({
  version: z.literal(1),
  draftId: z.string().min(1),
  sessionId: z.string().min(1),
});
const sessionBindingKey = (sessionId: string) =>
  `mitzo-chat-draft-session:${encodeURIComponent(sessionId)}`;
const draftBindingKey = (draftId: string) =>
  `mitzo-chat-draft-assignment:${encodeURIComponent(draftId)}`;
function readDraftBinding(key: string) {
  const raw = chatStorage.getItem(key);
  return raw === null ? null : DraftSessionBindingSchema.parse(JSON.parse(raw));
}
/** Associate existing rich draft ownership only after an exact silent allocation receipt.
 * Both sides retain their own bytes. Any independent destination draft takes priority.
 */
export function bindChatDraftToSession(
  draftId: string,
  sessionId: string,
): 'bound' | 'existing' | 'empty' | 'failed' {
  try {
    if (chatStorage.getItem(`mitzo-draft-${sessionId}`) !== null) return 'existing';
    const draft = getChatDraft(draftId);
    if (!draft)
      return chatStorage.getItem(chatDraftStorageKey(draftId)) === null ? 'empty' : 'failed';
    const target = readDraftBinding(sessionBindingKey(sessionId));
    if (target && target.draftId !== draftId && getChatDraft(target.draftId)) return 'existing';
    const source = readDraftBinding(draftBindingKey(draftId));
    if (source && source.sessionId !== sessionId) return 'existing';
    const value = DraftSessionBindingSchema.parse({ version: 1, draftId, sessionId });
    const encoded = JSON.stringify(value);
    // Keep the source reservation first; interruption can only recover this same binding.
    chatStorage.setItem(draftBindingKey(draftId), encoded);
    chatStorage.setItem(sessionBindingKey(sessionId), encoded);
    if (
      chatStorage.getItem(draftBindingKey(draftId)) !== encoded ||
      chatStorage.getItem(sessionBindingKey(sessionId)) !== encoded
    )
      return 'failed';
    changed();
    return 'bound';
  } catch {
    return 'failed';
  }
}
/** The ordinary composer continues using the same saved rich-draft owner. */
export function getSessionChatDraft(sessionId: string): ChatDraft | null {
  try {
    if (chatStorage.getItem(`mitzo-draft-${sessionId}`) !== null) return null;
    const target = readDraftBinding(sessionBindingKey(sessionId));
    if (!target || target.sessionId !== sessionId) return null;
    const source = readDraftBinding(draftBindingKey(target.draftId));
    if (!source || source.draftId !== target.draftId || source.sessionId !== sessionId) return null;
    return getChatDraft(target.draftId);
  } catch {
    return null;
  }
}

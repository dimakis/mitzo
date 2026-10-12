import { z } from 'zod';
import { getDefaultAccountModel } from './account-preference';

const PREFIX = 'mitzo-chat-draft:';
export function chatDraftStorageKey(id: string) {
  return PREFIX + id;
}
export function chatDraftIdFromKey(key: string): string | null {
  return key.startsWith(PREFIX) ? key.slice(PREFIX.length) : null;
}
export const CHAT_DRAFTS_CHANGED = 'mitzo-chat-drafts-changed';
const schema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  text: z.string(),
  images: z.array(z.object({ data: z.string(), preview: z.string(), mediaType: z.string() })),
  contextBlocks: z.array(z.string()),
  updatedAt: z.number(),
  settings: z.object({
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
export type ChatDraft = z.infer<typeof schema>;
export type ChatDraftContent = Pick<ChatDraft, 'text' | 'images' | 'contextBlocks'>;
export function createChatDraft(): ChatDraft {
  return {
    version: 1,
    id: crypto.randomUUID(),
    text: '',
    images: [],
    contextBlocks: [],
    updatedAt: Date.now(),
    settings: { selection: null, mode: 'agent', isolation: true, search: '', summary: null },
  };
}
export function getChatDraft(id: string): ChatDraft | null {
  try {
    const parsed = schema.safeParse(JSON.parse(localStorage.getItem(PREFIX + id) || 'null'));
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  } catch {
    return null;
  }
}
export function listChatDrafts(): ChatDraft[] {
  try {
    return Object.keys(localStorage)
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
    if (!draft.text.trim() && !draft.images.length && !draft.contextBlocks.length)
      localStorage.removeItem(PREFIX + draft.id);
    else
      localStorage.setItem(PREFIX + draft.id, JSON.stringify({ ...draft, updatedAt: Date.now() }));
    changed();
    return true;
  } catch {
    return false;
  }
}
export function deleteChatDraft(id: string): boolean {
  try {
    localStorage.removeItem(PREFIX + id);
    localStorage.removeItem(chatDraftTextKey(id));
    changed();
    return true;
  } catch {
    return false;
  }
}
export function chatDraftTextKey(id: string) {
  return `mitzo-chat-draft-text:${id}`;
}
export function consumeChatDraft(submitted: ChatDraft): boolean {
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
  return deleteChatDraft(submitted.id);
}
export function migrateLegacyChatDraft(): void {
  try {
    const text = localStorage.getItem('mitzo-draft-new');
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
    localStorage.removeItem('mitzo-draft-new');
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

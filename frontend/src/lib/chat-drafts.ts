import { z } from 'zod';
import {
  SourceSnapshotsSchema,
  SessionCollaborationIdSchema,
  CollaborationMessageInputSchema,
} from '@mitzo/protocol';
import { createBrowserId } from './browser-crypto';
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
  images: z.array(z.object({ data: z.string(), preview: z.string(), mediaType: z.string() })),
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
      JSON.parse(localStorage.getItem(PREFIX + id) || 'null'),
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
      localStorage.removeItem(PREFIX + draft.id);
    else
      localStorage.setItem(PREFIX + draft.id, JSON.stringify({ ...draft, updatedAt: Date.now() }));
    changed();
    return true;
  } catch {
    return false;
  }
}
export function deleteChatDraft(id: string, options: { preserveText?: boolean } = {}): boolean {
  try {
    const source = readDraftBinding(draftBindingKey(id));
    const target = source ? readDraftBinding(sessionBindingKey(source.sessionId)) : null;
    if (
      source?.version === 2 &&
      source.state === 'upgraded' &&
      target?.version === 2 &&
      target.draftId === id &&
      target.sessionId === source.sessionId &&
      target.state === 'upgraded'
    ) {
      // Retain a known explicit deletion/consumption transition before removal.
      // Missing rich bytes alone never authorize replacement of an upgrade ID.
      const retired = JSON.stringify({ ...target, state: 'retired' });
      localStorage.setItem(sessionBindingKey(source.sessionId), retired);
      if (
        localStorage.getItem(sessionBindingKey(source.sessionId)) !== retired ||
        readDraftBinding(draftBindingKey(id))?.sessionId !== source.sessionId
      )
        return false;
    }
    localStorage.removeItem(PREFIX + id);
    if (!options.preserveText) localStorage.removeItem(chatDraftTextKey(id));
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

/** Copy only unsent text; the new chat chooses its own account and runtime. */
export function newChatPathWithDraft(text: string): string {
  if (!text.trim()) return '/chat';
  const draft = createChatDraft();
  draft.text = text;
  if (!saveChatDraft(draft)) throw new Error('Could not save the new chat draft. Retry.');
  return `/chat?draft=${encodeURIComponent(draft.id)}`;
}

const AllocationDraftSessionBindingSchema = z.strictObject({
  version: z.literal(1),
  draftId: z.string().min(1),
  sessionId: z.string().min(1),
});
// The existing session binding also journals an explicit legacy-editor upgrade.
// Legacy bytes stay retained as a shadow; they are never compare-and-deleted.
const upgradeBinding = {
  version: z.literal(2),
  draftId: z.uuid(),
  sessionId: z.string().min(1),
  legacyText: z.string().nullable(),
  legacyEdited: z.boolean(),
};
const UpgradeDraftSessionBindingSchema = z
  .discriminatedUnion('state', [
    z.strictObject({
      ...upgradeBinding,
      state: z.literal('pending_upgrade'),
      draft: ChatDraftSchema,
    }),
    z.strictObject({ ...upgradeBinding, state: z.enum(['upgraded', 'retired']) }),
  ])
  .superRefine((value, context) => {
    if (value.state === 'pending_upgrade' && value.draft.id !== value.draftId)
      context.addIssue({ code: 'custom', message: 'Draft upgrade identity conflicts' });
  });
const DraftSessionBindingSchema = z.union([
  AllocationDraftSessionBindingSchema,
  UpgradeDraftSessionBindingSchema,
]);
const sessionBindingKey = (sessionId: string) =>
  `mitzo-chat-draft-session:${encodeURIComponent(sessionId)}`;
const draftBindingKey = (draftId: string) =>
  `mitzo-chat-draft-assignment:${encodeURIComponent(draftId)}`;
function readDraftBinding(key: string) {
  const raw = localStorage.getItem(key);
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
    if (localStorage.getItem(`mitzo-draft-${sessionId}`) !== null) return 'existing';
    const draft = getChatDraft(draftId);
    if (!draft)
      return localStorage.getItem(chatDraftStorageKey(draftId)) === null ? 'empty' : 'failed';
    const target = readDraftBinding(sessionBindingKey(sessionId));
    if (target?.version === 2) return 'existing';
    if (target && target.draftId !== draftId && getChatDraft(target.draftId)) return 'existing';
    const source = readDraftBinding(draftBindingKey(draftId));
    if (source?.version === 2) return 'existing';
    if (source && source.sessionId !== sessionId) return 'existing';
    const value = DraftSessionBindingSchema.parse({ version: 1, draftId, sessionId });
    const encoded = JSON.stringify(value);
    // Keep the source reservation first; interruption can only recover this same binding.
    localStorage.setItem(draftBindingKey(draftId), encoded);
    localStorage.setItem(sessionBindingKey(sessionId), encoded);
    if (
      localStorage.getItem(draftBindingKey(draftId)) !== encoded ||
      localStorage.getItem(sessionBindingKey(sessionId)) !== encoded
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
    const target = readDraftBinding(sessionBindingKey(sessionId));
    if (!target || target.sessionId !== sessionId) return null;
    const source = readDraftBinding(draftBindingKey(target.draftId));
    if (!source || source.draftId !== target.draftId || source.sessionId !== sessionId) return null;
    const legacy = localStorage.getItem(`mitzo-draft-${sessionId}`);
    if (target.version === 2) {
      if (
        target.state !== 'upgraded' ||
        source.version !== 2 ||
        source.state !== 'upgraded' ||
        source.legacyText !== target.legacyText
      )
        return null;
    } else if (source.version !== 1 || legacy !== null) return null;
    return getChatDraft(target.draftId);
  } catch {
    return null;
  }
}

/** A consumed upgraded draft must not resurrect its retained legacy shadow.
 * A later explicit legacy edit invalidates the shadow marker, even for equal text. */
export function isRetiredLegacyChatDraft(sessionId: string): boolean {
  try {
    const target = readDraftBinding(sessionBindingKey(sessionId));
    const source = target ? readDraftBinding(draftBindingKey(target.draftId)) : null;
    return (
      target?.version === 2 &&
      target.sessionId === sessionId &&
      (target.state === 'upgraded' || target.state === 'retired') &&
      !target.legacyEdited &&
      source?.version === 2 &&
      source.state === 'upgraded' &&
      !source.legacyEdited &&
      source.sessionId === sessionId &&
      source.draftId === target.draftId &&
      source.legacyText === target.legacyText &&
      localStorage.getItem(`mitzo-draft-${sessionId}`) === target.legacyText
    );
  } catch {
    return false;
  }
}

/** Existing plain-text owner writes announce a late edit before changing bytes.
 * This invalidates upgrade attachment; neither the rich nor legacy bytes are lost. */
export function writeLegacyChatDraft(
  sessionId: string,
  text: string,
  preserveEmpty = false,
  edited = true,
): void {
  const key = `mitzo-draft-${sessionId}`;
  let target: z.infer<typeof DraftSessionBindingSchema> | null = null;
  try {
    target = readDraftBinding(sessionBindingKey(sessionId));
  } catch {
    /* Preserve corrupt metadata and the editable legacy bytes separately. */
  }
  if (edited && target?.version === 2 && !target.legacyEdited)
    localStorage.setItem(
      sessionBindingKey(sessionId),
      JSON.stringify({ ...target, legacyEdited: true }),
    );
  if (text || preserveEmpty) localStorage.setItem(key, text);
  else localStorage.removeItem(key);
  if (target?.version === 2) changed();
}

export type SessionChatDraftUpgradeResult =
  | { state: 'upgraded'; draft: ChatDraft }
  | { state: 'existing' | 'conflict' | 'failed'; draftId?: string };
const draftContent = (draft: ChatDraft) => JSON.stringify({ ...draft, updatedAt: 0 });

/** Explicit Defaults/@ action only, never an allocation. Web Locks serializes
 * upgrades in this existing owner across tabs. Missing locking refuses migration.
 * The same binding retains original ID/content before rich writes; legacy bytes
 * remain recoverable and a late legacy write invalidates attachment instead of
 * being deleted. Unknown/partial writes recover only this retained original. */
export async function upgradeSessionChatDraft(options: {
  sessionId: string;
  expectedLegacyText: string | null;
  content: ChatDraftContent;
  settings: ChatDraft['settings'];
  isCurrent(): boolean;
}): Promise<SessionChatDraftUpgradeResult> {
  const { sessionId, isCurrent } = options;
  const input = structuredClone({
    content: options.content,
    settings: options.settings,
    legacyText: options.expectedLegacyText,
  });
  let retainedId: string | undefined;
  try {
    z.string().min(1).parse(sessionId);
    if (!navigator.locks?.request) return { state: 'failed' };
    return await navigator.locks.request(
      sessionBindingKey(sessionId),
      { mode: 'exclusive' },
      () => {
        const key = sessionBindingKey(sessionId),
          legacyKey = `mitzo-draft-${sessionId}`;
        let expected = localStorage.getItem(key);
        const check = () => {
          if (!isCurrent() || localStorage.getItem(key) !== expected)
            throw new Error('Draft upgrade owner changed');
        };
        check();
        const prior =
          expected === null ? null : DraftSessionBindingSchema.parse(JSON.parse(expected));
        if (prior && prior.sessionId !== sessionId)
          return { state: 'conflict' as const, draftId: prior.draftId };
        const retired = prior?.version === 2 && prior.state === 'retired';
        if (retired && localStorage.getItem(chatDraftStorageKey(prior.draftId)) !== null)
          return { state: 'existing' as const, draftId: prior.draftId };
        if (prior && !retired && (prior.version !== 2 || prior.state !== 'pending_upgrade')) {
          const existing = getSessionChatDraft(sessionId);
          if (
            prior.version === 2 &&
            existing &&
            draftContent(existing) ===
              draftContent(
                ChatDraftSchema.parse({ ...existing, ...input.content, settings: input.settings }),
              )
          ) {
            changed();
            return { state: 'upgraded' as const, draft: existing };
          }
          return { state: 'existing' as const, draftId: prior.draftId };
        }
        let pending;
        if (prior && prior.version === 2 && prior.state === 'pending_upgrade') {
          pending = prior;
          retainedId = prior.draftId;
          const current = ChatDraftSchema.parse({
            ...prior.draft,
            ...input.content,
            settings: input.settings,
          });
          if (
            prior.sessionId !== sessionId ||
            prior.legacyEdited ||
            prior.legacyText !== input.legacyText ||
            draftContent(current) !== draftContent(prior.draft)
          )
            return { state: 'conflict' as const, draftId: prior.draftId };
        } else {
          if (localStorage.getItem(legacyKey) !== input.legacyText)
            return { state: 'conflict' as const };
          const draft = ChatDraftSchema.parse({
            ...createChatDraft(),
            ...input.content,
            settings: input.settings,
          });
          retainedId = draft.id;
          pending = UpgradeDraftSessionBindingSchema.parse({
            version: 2,
            state: 'pending_upgrade',
            sessionId,
            draftId: draft.id,
            draft,
            legacyText: input.legacyText,
            legacyEdited: false,
          });
          check();
          expected = JSON.stringify(pending);
          localStorage.setItem(key, expected);
          check();
        }
        if (pending.state !== 'pending_upgrade') throw new Error('Draft upgrade unavailable');
        const sourceKey = draftBindingKey(pending.draftId);
        const sourceRaw = localStorage.getItem(sourceKey);
        const source =
          sourceRaw === null ? null : DraftSessionBindingSchema.parse(JSON.parse(sourceRaw));
        if (
          source &&
          (source.version !== 2 ||
            source.sessionId !== sessionId ||
            source.draftId !== pending.draftId ||
            source.state !== 'upgraded' ||
            source.legacyEdited ||
            source.legacyText !== pending.legacyText)
        )
          return { state: 'conflict' as const, draftId: pending.draftId };
        const richKey = chatDraftStorageKey(pending.draftId);
        const rich = localStorage.getItem(richKey);
        if (
          rich !== null &&
          draftContent(ChatDraftSchema.parse(JSON.parse(rich))) !== draftContent(pending.draft)
        )
          return { state: 'conflict' as const, draftId: pending.draftId };
        check();
        if (localStorage.getItem(legacyKey) !== pending.legacyText)
          return { state: 'conflict' as const, draftId: pending.draftId };
        if (rich === null && !saveChatDraft(pending.draft))
          throw new Error('Draft could not be retained');
        check();
        const committed = {
          version: 2 as const,
          state: 'upgraded' as const,
          sessionId,
          draftId: pending.draftId,
          legacyText: pending.legacyText,
          legacyEdited: false,
        };
        const encoded = JSON.stringify(committed);
        if (
          localStorage.getItem(sourceKey) !== sourceRaw ||
          localStorage.getItem(legacyKey) !== pending.legacyText ||
          draftContent(ChatDraftSchema.parse(JSON.parse(localStorage.getItem(richKey)!))) !==
            draftContent(pending.draft)
        )
          return { state: 'conflict' as const, draftId: pending.draftId };
        check();
        localStorage.setItem(sourceKey, encoded);
        check();
        if (
          localStorage.getItem(sourceKey) !== encoded ||
          localStorage.getItem(legacyKey) !== pending.legacyText
        )
          return { state: 'conflict' as const, draftId: pending.draftId };
        localStorage.setItem(key, encoded);
        expected = encoded;
        check();
        const draft = getSessionChatDraft(sessionId);
        if (!draft || draft.id !== pending.draftId)
          throw new Error('Draft binding could not be checked');
        changed();
        return { state: 'upgraded' as const, draft };
      },
    );
  } catch {
    return { state: 'failed', ...(retainedId ? { draftId: retainedId } : {}) };
  }
}

/** A confirmed rich editor keeps its own identity when an older editor writes.
 * Surface the conflict without switching editors or deleting either version. */
export function hasConcurrentLegacyChatDraft(sessionId: string): boolean {
  try {
    const target = readDraftBinding(sessionBindingKey(sessionId));
    return (
      target?.version === 2 &&
      target.state === 'upgraded' &&
      (target.legacyEdited ||
        localStorage.getItem(`mitzo-draft-${sessionId}`) !== target.legacyText)
    );
  } catch {
    return true;
  }
}

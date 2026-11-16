import { ChatDraftSchema, getChatDraft, saveChatDraft, type ChatDraft } from './chat-drafts';
import { chatStorage } from './large-chat-storage';
export type RetainedConversationSend = NonNullable<ChatDraft['collaborationSend']>;
export function conversationSendRequests(
  draft: ChatDraft | null | undefined,
): RetainedConversationSend[] {
  return [
    ...(draft?.collaborationSends ?? []),
    ...(draft?.collaborationSend ? [draft.collaborationSend] : []),
  ];
}
/** Replace/remove one exact request while preserving every unrelated pending send. */
export async function retainConversationSend(
  draftId: string | undefined,
  requestId: string,
  value: RetainedConversationSend | undefined,
  fresh: () => boolean,
) {
  if (!fresh()) return;
  try {
    const draft = draftId ? getChatDraft(draftId) : undefined;
    if (!draft) throw Error('Recovery draft unavailable');
    const requests = conversationSendRequests(draft).filter((r) => r.input.requestId !== requestId);
    if (value) requests.push(ChatDraftSchema.shape.collaborationSend.unwrap().parse(value));
    const updated = {
      ...draft,
      collaborationSend: requests.at(-1),
      collaborationSends: requests.length > 1 ? requests.slice(0, -1) : undefined,
    };
    if (!saveChatDraft(updated)) throw Error('Recovery could not be saved');
    await chatStorage.flush();
    if (!fresh()) return;
    if (
      chatStorage.failed ||
      JSON.stringify(conversationSendRequests(getChatDraft(draft.id))) !== JSON.stringify(requests)
    )
      throw Error('Recovery changed before its write completed');
    return { value, requests };
  } catch (cause) {
    console.warn('Conversation recovery persistence failed', {
      code: 'collaboration_recovery_write_failed',
      stage: 'persist',
      journal: 'collaborationSend',
      requestId,
      cause: cause instanceof Error ? cause.name : typeof cause,
    });
    throw Error(
      'Could not retain recovery. Keep this window open and retry after storage is available.',
      { cause },
    );
  }
}

/** Persist recovery before effects; editor-cache acceptance is not a disk receipt. */
export async function retainConversationJournal<
  K extends 'collaborationSend' | 'collaborationForward',
>(draftId: string | undefined, key: K, value: ChatDraft[K], fresh: () => boolean) {
  if (!fresh()) return;
  try {
    const retained = ChatDraftSchema.shape[key].parse(value) as ChatDraft[K];
    const draft = draftId ? getChatDraft(draftId) : undefined;
    if (!draft || !saveChatDraft({ ...draft, [key]: retained }))
      throw Error('Recovery could not be saved');
    await chatStorage.flush();
    if (!fresh()) return;
    if (
      chatStorage.failed ||
      JSON.stringify(getChatDraft(draft.id)?.[key]) !== JSON.stringify(retained)
    )
      throw Error('Recovery changed before its write completed');
    return { value: retained };
  } catch (cause) {
    console.warn('Conversation recovery persistence failed', {
      code: 'collaboration_recovery_write_failed',
      stage: 'persist',
      journal: key,
      collaborationId: value?.collaborationId,
      cause: cause instanceof Error ? cause.name : typeof cause,
    });
    throw Error(
      'Could not retain recovery. Keep this window open and retry after storage is available.',
      { cause },
    );
  }
}

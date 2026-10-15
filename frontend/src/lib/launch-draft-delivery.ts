import { z } from 'zod';
import {
  ChatDraftSchema,
  CHAT_DRAFTS_CHANGED,
  createChatDraft,
  getChatDraft,
  saveChatDraft,
  consumeChatDraft,
  chatDraftTextKey,
} from './chat-drafts';
import { getApiBaseUrl } from './api-fetch';

const schema = z.object({
  draftId: z.string().min(1),
  clientMsgId: z.string().min(1),
  state: z.enum(['pending', 'accepted']),
  sessionId: z.string().optional(),
  submitted: ChatDraftSchema.optional(),
  settings: ChatDraftSchema.shape.settings,
  followupId: z.string().optional(),
  followupText: z.string().optional(),
});
type Receipt = z.infer<typeof schema>;
const prefix = () => `mitzo-launch-delivery:${encodeURIComponent(getApiBaseUrl())}:`;
const key = (id: string) => prefix() + encodeURIComponent(id);
function read(id: string): Receipt | null {
  const raw = localStorage.getItem(key(id));
  if (!raw) return null;
  const record = schema.parse(JSON.parse(raw));
  if (record.draftId !== id) throw new Error('Launch owner changed');
  return record;
}
function notify() {
  window.dispatchEvent(new Event(CHAT_DRAFTS_CHANGED));
}
function write(record: Receipt) {
  localStorage.setItem(key(record.draftId), JSON.stringify(record));
  notify();
}
function find(command: string) {
  for (const stored of Object.keys(localStorage)) {
    if (!stored.startsWith(prefix())) continue;
    try {
      const record = read(decodeURIComponent(stored.slice(prefix().length)));
      if (record?.clientMsgId === command) return record;
    } catch {
      // A corrupt draft remains locked, but cannot block unrelated receipts.
    }
  }
  return null;
}
function preserveText(record: Receipt, text: string) {
  if (!text.trim() || record.followupText === text) return;
  const existing = record.followupId ? getChatDraft(record.followupId) : null;
  // A separately edited follow-up belongs to its editor; never replace it.
  const draft = existing && existing.text === record.followupText ? existing : createChatDraft();
  const settings = { ...record.settings };
  delete settings.launch;
  delete settings.repositoryWorkspaceId;
  delete settings.runtimeSelection;
  delete settings.retainRuntimeIntent;
  if (!saveChatDraft({ ...draft, text, settings })) throw new Error('Could not preserve follow-up');
  record.followupId = draft.id;
  record.followupText = text;
}
/** Late debounced composer writes remain independently recoverable after acceptance. */
export function preserveAcceptedLaunchText(id: string, text: string) {
  const record = read(id);
  if (record?.state !== 'accepted') return;
  preserveText(record, text);
  write(record);
}
export function launchDeliveryState(id: string | null | undefined) {
  if (!id) return null;
  try {
    return read(id)?.state ?? null;
  } catch {
    return 'pending' as const;
  }
}
export function launchDraftSnapshot(id: string | null | undefined) {
  return JSON.stringify({
    state: launchDeliveryState(id),
    selection: id ? getChatDraft(id)?.settings.selection : null,
  });
}
export function subscribeLaunchDrafts(listener: () => void) {
  window.addEventListener(CHAT_DRAFTS_CHANGED, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(CHAT_DRAFTS_CHANGED, listener);
    window.removeEventListener('storage', listener);
  };
}
/** Durable command association is independent of a mounted composer or store instance. */
export const launchDraftDelivery = {
  pending(id: string) {
    return !!launchDeliveryState(id);
  },
  prepare(id: string, command: Record<string, unknown>): boolean {
    try {
      if (read(id)) return false;
      const submitted = getChatDraft(id);
      const launch = submitted?.settings.launch;
      if (
        !submitted ||
        !launch ||
        launch.prompt !== command.prompt ||
        typeof command.clientMsgId !== 'string'
      )
        return false;
      if (
        JSON.stringify(launch.sourceSnapshots ?? []) !==
        JSON.stringify(command.sourceSnapshots ?? [])
      )
        return false;
      const selection = submitted.settings.selection;
      if (
        selection &&
        (selection.accountId !== command.accountId || selection.model !== command.model)
      )
        return false;
      write({
        draftId: id,
        clientMsgId: command.clientMsgId,
        state: 'pending',
        submitted,
        settings: submitted.settings,
      });
      return true;
    } catch {
      return false;
    }
  },
  assign(command: string, sessionId: string) {
    const record = find(command);
    if (!record) return;
    if (record.sessionId && record.sessionId !== sessionId)
      throw new Error('Launch assignment changed');
    write({ ...record, sessionId });
  },
  settle(command: string, state: 'accepted' | 'failed' | 'uncertain'): string | undefined {
    const record = find(command);
    if (!record) return;
    if (state === 'failed' && record.state === 'accepted') return record.draftId;
    if (state === 'failed') {
      localStorage.removeItem(key(record.draftId));
      notify();
      return record.draftId;
    }
    if (state === 'uncertain') return record.draftId;
    record.state = 'accepted';
    // Write the terminal lock before retiring a draft or preserving its independent text.
    write(record);
    preserveText(record, localStorage.getItem(chatDraftTextKey(record.draftId)) ?? '');
    if (
      record.submitted &&
      (!getChatDraft(record.draftId) || consumeChatDraft(record.submitted, { preserveText: true }))
    ) {
      record.submitted = undefined;
      const settings = { ...record.settings };
      delete settings.launch;
      record.settings = settings;
    }
    write(record);
    return record.draftId;
  },
};

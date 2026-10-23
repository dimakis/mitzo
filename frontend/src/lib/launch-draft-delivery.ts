import { OrdinaryRuntimeFirstCommandSchema } from '@mitzo/protocol';
import { z } from 'zod';
import {
  ChatDraftSchema,
  CHAT_DRAFTS_CHANGED,
  createChatDraft,
  getChatDraft,
  saveChatDraft,
  consumeChatDraft,
  chatDraftTextKey,
  chatDraftStorageKey,
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
  const draft = id ? getChatDraft(id) : null;
  return JSON.stringify({
    state: launchDeliveryState(id),
    draft: draft?.settings.launch ? draft : null,
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
/** Inspect the retained source before permissive historical schemas strip unknown metadata. */
export function briefingLaunchUnsupportedReason(
  id?: string | null,
  pending?: unknown,
  search = '',
): string | undefined {
  try {
    const stored = id ? JSON.parse(localStorage.getItem(chatDraftStorageKey(id)) || 'null') : null;
    const launch = stored?.settings?.launch ?? pending;
    if (!launch?.briefing) return;
    const unsupported = ['contextBlocks', 'telosTaskId', 'agentName', 'extraTools'];
    if (
      unsupported.some((field) => Object.hasOwn(launch, field)) ||
      Object.hasOwn(stored?.settings ?? {}, 'extraTools') ||
      new URLSearchParams(stored?.settings?.search).has('extraTools') ||
      new URLSearchParams(search).has('extraTools') ||
      stored?.contextBlocks?.length
    ) {
      return 'This saved briefing carries unsupported launch metadata. Its original draft was kept; open a new explicitly configured conversation.';
    }
  } catch {
    return 'Could not verify this saved briefing. Its original draft was kept; restore it before sending.';
  }
}

function normalizeOwnedBriefingCommand(
  submitted: z.infer<typeof ChatDraftSchema> | null | undefined,
  command: unknown,
) {
  const parsed = OrdinaryRuntimeFirstCommandSchema.safeParse(command);
  const runtime = submitted?.settings.runtimeSelection;
  const launch = submitted?.settings.launch;
  if (!parsed.success || !runtime || !launch?.briefing) return null;
  const request = parsed.data;
  if (
    JSON.stringify(request.runtime.account) !== JSON.stringify(runtime.accountReference) ||
    request.runOn !== runtime.execution.location ||
    request.runtime.targetId !== runtime.execution.targetId ||
    request.capabilityRevision !== runtime.capabilityRevision ||
    JSON.stringify(request.selection.agent) !== JSON.stringify(runtime.agentProfile) ||
    request.selection.model !== runtime.account?.model ||
    request.selection.thinking !== (runtime.account?.reasoningEffort ?? null) ||
    request.runtime.mode !== submitted!.settings.mode ||
    request.payload.text !== launch.prompt ||
    JSON.stringify(request.payload.sourceSnapshots ?? []) !==
      JSON.stringify(launch.sourceSnapshots ?? []) ||
    request.runtime.account.accountId !== launch.accountSelection?.accountId ||
    request.selection.model !== launch.accountSelection?.model ||
    !request.payload.sourceSnapshots?.some(
      (source) =>
        source.kind === 'briefing' &&
        source.date === launch.briefing!.date &&
        source.revision === launch.briefing!.revision,
    )
  )
    return null;
  return {
    clientMsgId: request.clientMsgId,
    prompt: request.payload.text,
    accountId: request.runtime.account.accountId,
    model: request.selection.model,
    sourceSnapshots: request.payload.sourceSnapshots,
  };
}
/** ACK authority is the original submitted receipt, never the currently edited draft. */
export function validateOwnedBriefingAssignment(
  draftId: unknown,
  command: unknown,
  sessionId?: string,
): boolean {
  try {
    if (typeof draftId !== 'string') return false;
    const receipt = read(draftId);
    const normalized = normalizeOwnedBriefingCommand(receipt?.submitted, command);
    return (
      !!receipt &&
      !!normalized &&
      receipt.clientMsgId === normalized.clientMsgId &&
      (!sessionId || !receipt.sessionId || receipt.sessionId === sessionId)
    );
  } catch {
    return false;
  }
}

/** Durable command association is independent of a mounted composer or store instance. */
export const launchDraftDelivery = {
  matches(draftId: string, command: Record<string, unknown>) {
    return validateOwnedBriefingAssignment(draftId, command);
  },
  pending(id: string) {
    return !!launchDeliveryState(id);
  },
  prepare(id: string, command: Record<string, unknown>): boolean {
    try {
      if (read(id)) return false;
      const submitted = getChatDraft(id);
      const launch = submitted?.settings.launch;
      if (command.payload !== undefined || command.runOn !== undefined) {
        if (briefingLaunchUnsupportedReason(id)) return false;
        const normalized = normalizeOwnedBriefingCommand(submitted, command);
        if (!normalized) return false;
        command = normalized;
      }
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
      if (
        launch.briefing &&
        !launch.sourceSnapshots?.some(
          (source) =>
            source.kind === 'briefing' &&
            source.date === launch.briefing!.date &&
            source.revision === launch.briefing!.revision,
        )
      )
        return false;
      const selection = launch.briefing ? launch.accountSelection : submitted.settings.selection;
      if (
        selection &&
        (selection.accountId !== command.accountId || selection.model !== command.model)
      )
        return false;
      if (find(command.clientMsgId)) return false;
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
    if (record.submitted?.settings.launch?.briefing && record.submitted.settings.runtimeSelection)
      return { context: record.submitted.settings.launch.context };
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
      // Owned briefing proof remains available until its consumed outbox entry
      // has been durably removed. Generic launch cleanup keeps its old timing.
      if (
        !record.submitted.settings.launch?.briefing ||
        !record.submitted.settings.runtimeSelection
      )
        record.submitted = undefined;
      const settings = { ...record.settings };
      delete settings.launch;
      record.settings = settings;
    }
    write(record);
    return record.draftId;
  },
  finalize(command: string) {
    const record = find(command);
    if (
      record?.state !== 'accepted' ||
      !record.sessionId ||
      !record.submitted?.settings.launch?.briefing ||
      !record.submitted.settings.runtimeSelection
    )
      return;
    record.submitted = undefined;
    const settings = { ...record.settings };
    delete settings.launch;
    record.settings = settings;
    write(record);
  },
};

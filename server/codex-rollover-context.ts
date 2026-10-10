import { SourceSnapshotsSchema, type SourceSnapshot } from '@mitzo/protocol';
import { assembleSourceSnapshots } from './source-snapshot-context.js';
import type { EventStore } from './event-store.js';

export interface ConversationHistoryEntry {
  role: 'user' | 'assistant';
  text: string;
}

/** Build a role-preserving transcript from the public durable text projection.
 * A trailing user message has not received a completed assistant response and
 * may be the command about to be dispatched, so it is deliberately excluded. */
export function codexRolloverHistory(
  store: EventStore,
  conversationId: string,
): ConversationHistoryEntry[] {
  const events = store.getRecentConversationText(conversationId);
  const completedAssistants = new Set(
    events.filter((event) => event.kind === 'assistant_end').map((event) => event.messageId),
  );
  const entries: Array<ConversationHistoryEntry & { messageId: string }> = [];
  const initialPrompt = store.getSession(conversationId)?.initialPrompt?.trim();
  if (initialPrompt) entries.push({ role: 'user', text: initialPrompt, messageId: 'initial' });

  for (const event of events) {
    if (event.kind === 'user') {
      const text = event.text.trim();
      if (!text) continue;
      if (entries.length === 1 && entries[0].messageId === 'initial' && entries[0].text === text)
        continue;
      entries.push({ role: 'user', text, messageId: event.messageId });
      continue;
    }
    if (event.kind !== 'assistant_delta' || !completedAssistants.has(event.messageId)) continue;
    const previous = entries.at(-1);
    if (previous?.role === 'assistant' && previous.messageId === event.messageId)
      previous.text += event.text;
    else entries.push({ role: 'assistant', text: event.text, messageId: event.messageId });
  }

  while (entries.at(-1)?.role === 'user') entries.pop();
  return entries
    .filter((entry) => entry.text.trim())
    .map(({ role, text }) => ({ role, text: text.trim() }));
}

/** Keep exact references separate from the bounded recent-dialogue transcript. */
export function codexRolloverSources(store: EventStore, conversationId: string): SourceSnapshot[] {
  const sources = new Map<string, SourceSnapshot>();
  let bytes = 0;
  for (const value of store.getConversationSourceSnapshots(conversationId)) {
    for (const source of SourceSnapshotsSchema.parse(value)) {
      assembleSourceSnapshots('', [source]);
      const key = `${source.kind}:${source.date}:${source.revision}`;
      if (sources.has(key)) continue;
      bytes += Buffer.byteLength(source.content, 'utf8');
      if (bytes > 2 * 1024 * 1024) throw new Error('Saved source snapshots exceed 2 MiB');
      sources.set(key, source);
    }
  }
  return [...sources.values()];
}

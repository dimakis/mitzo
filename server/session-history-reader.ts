import type { EventStore, StoredEvent } from './event-store.js';

export const HISTORY_SCAN_LIMIT = 8192;
export const HISTORY_OUTPUT_BYTES = 32768;
export const UNSUPPORTED_HISTORY =
  'Session history format is unsupported for this bounded read; no page or continuation cursor was delivered.';
const BLOCK_TYPES = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use']);

export interface HistoryEntry {
  seq: number;
  endSeq?: number;
  kind: 'user' | 'assistant';
  text: string;
  excerpt?: true;
}
interface Group extends HistoryEntry {
  messageId?: string;
  blockId?: unknown;
  bytes: number;
}
export class UnsupportedHistoryError extends Error {
  constructor(readonly scannedEvents: number) {
    super(UNSUPPORTED_HISTORY);
  }
}
export interface MessagePage {
  entries: HistoryEntry[];
  nextAfterSeq: number | null;
  nextBeforeSeq?: number | null;
  scannedEvents: number;
  blockedEvent?: { seq: number; reason: 'event_exceeds_output_bound' };
}
export type HistoryReaderStore = Partial<
  Pick<EventStore, 'getHistoryEventPage' | 'getHistoryMessagePrefix'>
>;

/** Only the original caller authorizes a target and captures its immutable
 * highwater. This shared projection never opens files or recovers a provider. */
export function readHistoryMessages(options: {
  store: HistoryReaderStore;
  conversationId: string;
  afterSeq: number;
  throughSeq: number;
  beforeSeq?: number;
  recent?: boolean;
  query?: string;
  limit: number;
  scanLimit?: number;
  project(text: string): string;
}): MessagePage {
  const { store, conversationId, afterSeq, throughSeq, recent, query, limit, project } = options;
  const scanLimit = options.scanLimit ?? HISTORY_SCAN_LIMIT;
  if (!Number.isSafeInteger(scanLimit) || scanLimit < 1 || scanLimit > HISTORY_SCAN_LIMIT)
    throw Error('Invalid history scan bound');
  const beforeSeq = options.beforeSeq;
  const contextLimit =
    query && query.length > 1 && (recent || afterSeq > 0)
      ? Math.min(256, query.length, scanLimit - 1)
      : 0;
  if (!store.getHistoryEventPage) throw Error('Bounded history projection unavailable');
  const { events: rows, hasMore: more } = store.getHistoryEventPage(
    conversationId,
    afterSeq,
    throughSeq,
    scanLimit - contextLimit,
    beforeSeq,
    recent,
  );
  if (rows.length > scanLimit - contextLimit || typeof more !== 'boolean' || (more && !rows.length))
    throw Error('Invalid history event bound');
  let previous = recent ? Infinity : afterSeq;
  for (const row of rows) {
    if (
      row.sessionId !== conversationId ||
      !Number.isSafeInteger(row.seq) ||
      row.seq < 1 ||
      (recent
        ? row.seq >= previous ||
          row.seq > throughSeq ||
          (beforeSeq !== undefined && row.seq >= beforeSeq)
        : row.seq <= previous)
    )
      throw Error('Invalid history event identity/order');
    previous = row.seq;
  }
  const page = rows.filter((row) => row.seq <= throughSeq);
  if (recent) page.reverse();
  // Validate the bounded page before projecting any text. Unknown native and
  // seat-qualified formats need their own audience owner, never a guessed role.
  if (page.some(isUnsupportedHistoryEvent)) throw new UnsupportedHistoryError(page.length);
  const groups: Group[] = [];
  let active: Group | undefined;
  for (const row of page) {
    const value =
      row.type === 'user_message'
        ? row.payload.text
        : row.type === 'block_delta' && row.payload.blockType === 'text'
          ? row.payload.delta
          : undefined;
    if (typeof value !== 'string') {
      if (row.type === 'message_start' || row.type === 'message_end') active = undefined;
      continue;
    }
    const kind = row.type === 'user_message' ? 'user' : 'assistant';
    const messageId = typeof row.payload.messageId === 'string' ? row.payload.messageId : undefined;
    const separator = active && active.blockId !== row.payload.blockId ? '\n\n' : '';
    const bytes = Buffer.byteLength(JSON.stringify(value)) - 2;
    // A partial long answer continues at a durable event boundary. Reserving
    // envelope space also bounds JSON escaping and multibyte text, not just chars.
    if (
      kind === 'assistant' &&
      messageId &&
      active?.kind === 'assistant' &&
      active.messageId === messageId &&
      active.bytes + bytes + separator.length * 2 < HISTORY_OUTPUT_BYTES - 2048
    ) {
      active.text += separator + value;
      active.endSeq = row.seq;
      active.blockId = row.payload.blockId;
      active.bytes += bytes + separator.length * 2;
    } else {
      active = { seq: row.seq, kind, text: value, messageId, blockId: row.payload.blockId, bytes };
      groups.push(active);
    }
    if (kind === 'user') active = undefined;
  }
  const entries: HistoryEntry[] = [];
  let prefix: { text: string; messageId?: string; blockId?: unknown; seq: number } | undefined;
  let contextEvents = 0;
  if (contextLimit && groups[0]?.kind === 'assistant' && groups[0].messageId) {
    if (!store.getHistoryMessagePrefix) throw Error('Bounded query context unavailable');
    const first = groups[0];
    const context = store.getHistoryMessagePrefix(
      conversationId,
      first.messageId!,
      first.seq,
      contextLimit,
    );
    if (context.length > contextLimit) throw Error('Invalid history context bound');
    let previous = 0;
    for (const row of context) {
      if (
        row.sessionId !== conversationId ||
        row.seq <= previous ||
        row.seq >= first.seq ||
        row.payload.messageId !== first.messageId
      )
        throw Error('Invalid history context identity/order');
      previous = row.seq;
    }
    contextEvents = context.length;
    if (context.some(isUnsupportedHistoryEvent))
      throw new UnsupportedHistoryError(page.length + contextEvents);
    const parts: string[] = [];
    for (const row of [...context].reverse()) {
      if (row.payload.blockId !== first.blockId) break;
      if (typeof row.payload.delta === 'string') parts.unshift(row.payload.delta);
    }
    const text = parts.join('');
    const last = context[context.length - 1];
    if (last && last.payload.blockId === first.blockId)
      prefix = { text, messageId: first.messageId, blockId: first.blockId, seq: context[0].seq };
  }
  let consumed = afterSeq;
  let consumedBefore = beforeSeq;
  let stopped = false;
  let blockedEvent: MessagePage['blockedEvent'];
  let bytes = 0;
  // Project and match in chronological order, so an overlap is always from
  // the same preceding message/block, even when delivery is newest-first.
  const projected = groups.map((group) => {
    const overlap =
      query &&
      query.length > 1 &&
      prefix?.messageId &&
      prefix.messageId === group.messageId &&
      prefix.blockId === group.blockId
        ? prefix.text.slice(-(query.length - 1))
        : '';
    const text = project(overlap + group.text);
    if (typeof text !== 'string') throw Error('Invalid public history text');
    const position = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : 0;
    const entryText =
      query && position >= 0
        ? text.slice(Math.max(0, position - 80), position + query.length + 160)
        : text;
    const entry: HistoryEntry = {
      seq: overlap ? prefix!.seq : group.seq,
      ...(group.endSeq || overlap ? { endSeq: group.endSeq ?? group.seq } : {}),
      kind: group.kind,
      text: entryText,
      ...(entryText !== text ? { excerpt: true as const } : {}),
    };
    prefix = {
      text: group.text,
      messageId: group.messageId,
      blockId: group.blockId,
      seq: group.seq,
    };
    return { group, entry, matches: position >= 0 };
  });
  for (const { group, entry, matches } of recent ? projected.reverse() : projected) {
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (
      (query && group.bytes > HISTORY_OUTPUT_BYTES - 1024) ||
      (matches && size > HISTORY_OUTPUT_BYTES - 1024)
    ) {
      blockedEvent = { seq: group.seq, reason: 'event_exceeds_output_bound' };
      stopped = true;
      break;
    }
    if (matches && (entries.length >= limit || bytes + size > HISTORY_OUTPUT_BYTES - 1024)) {
      stopped = true;
      break;
    }
    consumed = group.endSeq ?? group.seq;
    consumedBefore = group.seq;
    if (matches) {
      if (recent) entries.unshift(entry);
      else entries.push(entry);
      bytes += size;
    }
  }
  if (!stopped && page.length) {
    consumed = page[page.length - 1].seq;
    consumedBefore = page[0].seq;
  }
  return {
    entries,
    nextAfterSeq: !recent && !blockedEvent && (stopped || more) ? consumed : null,
    ...(recent
      ? { nextBeforeSeq: !blockedEvent && (stopped || more) ? (consumedBefore ?? null) : null }
      : {}),
    scannedEvents: page.length + contextEvents,
    ...(blockedEvent ? { blockedEvent } : {}),
  };
}

export function isUnsupportedHistoryEvent(event: StoredEvent) {
  return (
    event.seatId != null ||
    event.symposiumProvenance != null ||
    (event.type === 'block_delta' &&
      (typeof event.payload.blockType !== 'string' || !BLOCK_TYPES.has(event.payload.blockType)))
  );
}

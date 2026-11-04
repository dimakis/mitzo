import type { SessionMeta, StoredEvent } from '@mitzo/protocol';
import {
  extractRecentPrompts,
  generateSessionNameFallback,
  isGenericSessionName,
} from '@mitzo/harness';
import { replayEventsToMessages } from './conversation-transcript.js';

/** Use public conversation text only; tools, thinking and other seats are not naming context. */
export function sessionNamingPrompts(
  events: StoredEvent[],
  initialPrompt?: string | null,
): string[] {
  let closeout = false;
  const ordinary = events.filter((event) => {
    if (
      event.seatId ||
      event.symposiumProvenance ||
      event.payload.seatId ||
      event.payload.symposiumProvenance
    )
      return false;
    if (event.type === 'user_message') {
      closeout =
        event.payload.source === 'closeout' ||
        /^closeout-[a-f0-9]{64}$/.test(String(event.payload.messageId ?? ''));
    }
    return !closeout;
  });
  const prompts = extractRecentPrompts(ordinary);
  if (initialPrompt && !prompts.includes(initialPrompt)) prompts.unshift(initialPrompt);
  const requests = prompts.filter((prompt) => generateSessionNameFallback([prompt]));
  if (requests.length) return requests;

  // A follow-up such as "Merge it" often has its subject in the assistant's reply.
  // Prefer explicit PR subjects, then topic headings, then concrete action sentences.
  const replies = replayEventsToMessages(ordinary)
    .filter((message) => message.role === 'assistant')
    .flatMap((message) =>
      message.blocks
        .filter((block) => block.blockType === 'text')
        .map((block) => block.content.replace(/```[\s\S]*?```/g, '\n')),
    );
  for (const reply of replies) {
    for (const match of reply.matchAll(
      /\[([^\]]+)\]\(https:\/\/github\.com\/[^/\s]+\/([^/\s]+)\/pull\/(\d+)(?:[?#][^)]*)?\)/g,
    )) {
      const label = generateSessionNameFallback([match[1]]);
      if (label) return [`${match[2]} #${match[3]}: ${label}`];
    }
  }
  for (const reply of replies) {
    for (const match of reply.matchAll(/^#{1,6}\s+(.+)$/gm)) {
      const title = generateSessionNameFallback([match[1]]);
      if (title && !/^(?:summary|changes|validation|tests|status|next steps|done)$/i.test(title))
        return [title];
    }
  }
  for (const reply of replies) {
    for (const line of reply.split('\n')) {
      const action = line.trim().replace(/^I(?:['’]ll| will)\s+/i, '');
      if (
        !/^(?:fix|repair|debug|investigate|add|update|restore|implement|remove|resolve|merge|review|compare|improve)\b/i.test(
          action,
        )
      )
        continue;
      const title = generateSessionNameFallback([action]);
      if (title) return [title];
    }
  }
  return [];
}

type NamingMeta = Pick<SessionMeta, 'sessionId'> &
  Partial<Pick<SessionMeta, 'summary' | 'initialPrompt' | 'manuallyRenamed'>>;

/** Read-only repair: preserves manual names and list ordering without a model call. */
export function sessionDisplayName(
  meta: NamingMeta,
  events: StoredEvent[] | (() => StoredEvent[]),
): string {
  if (meta.manuallyRenamed || !isGenericSessionName(meta.summary ?? '')) return meta.summary ?? '';
  const initial = generateSessionNameFallback(meta.initialPrompt ? [meta.initialPrompt] : []);
  if (initial) return initial;
  return (
    generateSessionNameFallback(
      sessionNamingPrompts(typeof events === 'function' ? events() : events),
    ) || `Chat ${meta.sessionId.slice(-8)}`
  );
}

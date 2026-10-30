import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ConversationTextEvent } from './conversation-replay-store.js';

export const MemoryCandidateSchema = z.strictObject({
  requestId: z.uuid(),
  summary: z.string().trim().min(1).max(4000),
  quotes: z.array(z.string().trim().min(1).max(4000)).min(1).max(8),
});

/** A candidate is private session evidence, never an accepted MGMT update. */
export function recordMemoryCandidate(
  db: Database.Database,
  sessionId: string,
  accountId: string,
  input: unknown,
  readText: () => ConversationTextEvent[],
  append: (payload: Record<string, unknown>) => number,
) {
  const request = MemoryCandidateSchema.parse(input);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([accountId, request]))
    .digest('hex');
  return db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT seq,payload FROM events WHERE session_id=? AND type='memory_candidate'
       AND json_extract(payload,'$.requestId')=? LIMIT 1`,
      )
      .get(sessionId, request.requestId) as { seq: number; payload: string } | undefined;
    const receipt = (seq: number) => ({
      status: 'captured' as const,
      seq,
      requestId: request.requestId,
      accepted: false,
    });
    if (existing) {
      if (JSON.parse(existing.payload).fingerprint !== fingerprint)
        throw Error('Memory request ID already belongs to another candidate');
      return receipt(existing.seq);
    }
    const messages = new Map<string, { seq: number; role: 'user' | 'assistant'; text: string }>();
    for (const event of readText()) {
      if (event.kind === 'assistant_end') continue;
      const prior = messages.get(event.messageId);
      if (prior) prior.text += event.text;
      else
        messages.set(event.messageId, {
          seq: event.seq,
          role: event.kind === 'user' ? 'user' : 'assistant',
          text: event.text,
        });
    }
    const evidence = request.quotes.map((quote) => {
      const match = [...messages.values()].find((message) => message.text.includes(quote));
      if (!match) throw Error('Memory quote is absent from this conversation');
      return { seq: match.seq, role: match.role, quote };
    });
    return receipt(
      append({
        requestId: request.requestId,
        summary: request.summary,
        evidence,
        fingerprint,
        accountId,
      }),
    );
  })();
}

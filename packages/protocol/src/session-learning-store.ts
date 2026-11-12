import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { SessionMeta } from './types.js';
import {
  MemoryCandidateInputSchema,
  SessionLearningModeSchema,
  type SessionLearningMode,
  type SessionLearningPolicy,
  type MemoryCandidateReceipt,
} from './session-learning.js';

interface Owner {
  database(): Database.Database;
  getSession(id: string): SessionMeta | null;
}
type Source = {
  sessionId: string;
  accountId: string | null;
  workspace: string | null;
  scope: 'unclassified';
};
type Candidate = ReturnType<typeof MemoryCandidateInputSchema.parse> & { source: Source };

/** Borrows the controller event DB; never selects an external source or model. */
export class SessionLearningStore {
  constructor(private readonly owner: Owner) {}
  private get db() {
    return this.owner.database();
  }
  private session(id: string) {
    const session = this.owner.getSession(id);
    if (
      !session ||
      session.isHidden ||
      session.sessionType === 'symposium' ||
      session.symposiumConfig
    )
      throw Error('learning_session_unavailable');
    return session;
  }
  policy(id: string): SessionLearningPolicy {
    return this.session(id).learningPolicy!;
  }
  private watermark(id: string): number {
    return (
      this.db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM events WHERE session_id=?').get(id) as {
        seq: number;
      }
    ).seq;
  }
  private source(id: string): Source {
    const s = this.session(id);
    return {
      sessionId: id,
      accountId: s.accountBinding?.accountId ?? null,
      workspace: s.cwd,
      scope: 'unclassified',
    };
  }
  setMode(id: string, input: SessionLearningMode, expectedRevision: number): SessionLearningPolicy {
    const mode = SessionLearningModeSchema.parse(input);
    return this.db
      .transaction(() => {
        const previous = this.policy(id);
        if (previous.revision !== expectedRevision) throw Error('learning_revision_conflict');
        if (previous.mode === mode) return previous;
        const watermark = this.watermark(id);
        const excludedThroughSeq =
          mode === 'off' || previous.mode === 'off'
            ? Math.max(previous.excludedThroughSeq, watermark)
            : previous.excludedThroughSeq;
        const policy: SessionLearningPolicy = {
          version: 1,
          mode,
          revision: previous.revision + 1,
          excludedThroughSeq,
          ...(mode === 'deep'
            ? {
                historyRequest: {
                  afterSeq: excludedThroughSeq,
                  throughSeq: watermark,
                  status: 'pending_worker' as const,
                },
              }
            : previous.historyRequest
              ? { historyRequest: { ...previous.historyRequest, status: 'cancelled' as const } }
              : {}),
        };
        this.db
          .prepare(
            "UPDATE sessions SET learning_policy=?,updated_at=unixepoch('now','subsec')*1000 WHERE session_id=?",
          )
          .run(JSON.stringify(policy), id);
        this.event(id, 'session_learning_policy_changed', policy);
        return policy;
      })
      .immediate();
  }
  private event(id: string, type: string, payload: object): number {
    return Number(
      this.db
        .prepare('INSERT INTO events(session_id,type,payload) VALUES(?,?,?)')
        .run(id, type, JSON.stringify(payload)).lastInsertRowid,
    );
  }
  private sourceRow(id: string, seq: number) {
    return this.db
      .prepare(
        `SELECT seq,created_at,type,json_extract(payload,'$.messageId') messageId FROM events
      WHERE session_id=? AND seq=? AND seat_id IS NULL AND symposium_provenance IS NULL
      AND json_extract(payload,'$.seatId') IS NULL AND json_extract(payload,'$.symposiumProvenance') IS NULL
      AND ((type='user_message' AND json_type(payload,'$.text')='text') OR
        (type='message_end' AND EXISTS (SELECT 1 FROM events text WHERE text.session_id=events.session_id
          AND text.seq<events.seq AND text.type='block_delta' AND text.seat_id IS NULL AND text.symposium_provenance IS NULL
          AND json_extract(text.payload,'$.messageId')=json_extract(events.payload,'$.messageId')
          AND json_extract(text.payload,'$.blockType')='text' AND json_type(text.payload,'$.delta')='text'
          AND json_extract(text.payload,'$.seatId') IS NULL AND json_extract(text.payload,'$.symposiumProvenance') IS NULL)))`,
      )
      .get(id, seq) as
      { seq: number; created_at: number; type: string; messageId: string } | undefined;
  }
  private messageExcluded(id: string, messageId: string, throughSeq: number): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM events WHERE session_id=? AND seq<=?
      AND type IN ('user_message','message_start','block_start','block_delta','block_end','message_end')
      AND json_extract(payload,'$.messageId')=? LIMIT 1`,
        )
        .get(id, throughSeq, messageId),
    );
  }
  sources(id: string, beforeSeq?: number) {
    const policy = this.policy(id);
    if (policy.mode === 'off') return [];
    const rows = this.db
      .prepare(
        `SELECT seq FROM events WHERE session_id=? AND seq>? AND seq<?
      AND type IN ('user_message','message_end') ORDER BY seq DESC LIMIT 100`,
      )
      .all(id, policy.excludedThroughSeq, beforeSeq ?? Number.MAX_SAFE_INTEGER) as {
      seq: number;
    }[];
    return rows.flatMap(({ seq }) => {
      const row = this.sourceRow(id, seq);
      return row &&
        typeof row.messageId === 'string' &&
        !this.messageExcluded(id, row.messageId, policy.excludedThroughSeq)
        ? [
            {
              messageId: row.messageId,
              eventSeq: seq,
              observedAt: row.created_at,
              role: row.type === 'user_message' ? 'user' : 'assistant',
            },
          ]
        : [];
    });
  }
  private eligible(id: string, candidate: Candidate) {
    const policy = this.policy(id);
    if (policy.mode === 'off') return { eligible: false, reason: 'learning_off' };
    if (JSON.stringify(this.source(id)) !== JSON.stringify(candidate.source))
      return { eligible: false, reason: 'source_changed' };
    for (const citation of candidate.sources) {
      if (
        citation.eventSeq <= policy.excludedThroughSeq ||
        this.messageExcluded(id, citation.messageId, policy.excludedThroughSeq)
      )
        return { eligible: false, reason: 'source_excluded' };
      const row = this.sourceRow(id, citation.eventSeq);
      if (!row || row.messageId !== citation.messageId)
        return { eligible: false, reason: 'source_ineligible' };
    }
    return { eligible: true };
  }
  eligibility(id: string, requestId: string) {
    this.session(id);
    const row = this.db
      .prepare(
        `SELECT e.payload FROM session_learning_captures c JOIN events e ON e.seq=c.event_seq
      WHERE c.session_id=? AND c.request_id=?`,
      )
      .get(id, requestId) as { payload: string } | undefined;
    return row
      ? this.eligible(id, JSON.parse(row.payload) as Candidate)
      : { eligible: false, reason: 'capture_not_found' };
  }
  capture(id: string, input: unknown): MemoryCandidateReceipt {
    const parsed = MemoryCandidateInputSchema.parse(input);
    const hash = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
    return this.db
      .transaction(() => {
        const policy = this.policy(id);
        const saved = this.db
          .prepare(
            'SELECT payload_hash,receipt FROM session_learning_captures WHERE session_id=? AND request_id=?',
          )
          .get(id, parsed.requestId) as { payload_hash: string; receipt: string } | undefined;
        const candidate = {
          ...parsed,
          source: this.source(id),
          status: 'provisional' as const,
          policyRevision: policy.revision,
        };
        const eligibility = saved
          ? this.eligibility(id, parsed.requestId)
          : this.eligible(id, candidate);
        if (!eligibility.eligible) throw Error(eligibility.reason);
        const currentEligibility = saved ? this.eligible(id, candidate) : eligibility;
        if (!currentEligibility.eligible) throw Error(currentEligibility.reason);
        if (saved && saved.payload_hash !== hash) throw Error('learning_request_conflict');
        if (saved) return JSON.parse(saved.receipt) as MemoryCandidateReceipt;
        const eventSeq = this.event(id, 'memory_candidate', candidate);
        const receipt: MemoryCandidateReceipt = {
          version: 1,
          requestId: parsed.requestId,
          sessionId: id,
          eventSeq,
          status: 'stored',
          knowledgeStatus: 'provisional',
          policyRevision: policy.revision,
        };
        this.db
          .prepare(
            'INSERT INTO session_learning_captures(session_id,request_id,payload_hash,event_seq,receipt) VALUES(?,?,?,?,?)',
          )
          .run(id, parsed.requestId, hash, eventSeq, JSON.stringify(receipt));
        return receipt;
      })
      .immediate();
  }
}

import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import type { CodexNativeTurnTarget } from './codex-conversation-store.js';

/** Historical settlement facts only. This never authorizes control, changes an
 * original tool receipt, or treats a generic recovery acknowledgement as proof. */
export class CodexEffectSettlements {
  private readonly available: boolean;
  constructor(
    private readonly db: Database.Database,
    initialize: boolean,
  ) {
    if (initialize)
      db.exec(`CREATE TABLE IF NOT EXISTS codex_effect_settlements (
      conversation_id TEXT NOT NULL, command_id TEXT NOT NULL, attempt INTEGER NOT NULL,
      target TEXT NOT NULL, receipt_digest TEXT NOT NULL, policy_revision TEXT,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY(conversation_id,command_id,attempt))`);
    this.available = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_effect_settlements'")
      .get();
  }
  private get(id: string, target: CodexNativeTurnTarget) {
    return this.available
      ? (this.db
          .prepare(
            'SELECT target,receipt_digest FROM codex_effect_settlements WHERE conversation_id=? AND command_id=? AND attempt=?',
          )
          .get(id, target.commandId, target.attempt) as
          { target: string; receipt_digest: string } | undefined)
      : undefined;
  }
  matches(id: string, target: CodexNativeTurnTarget, digest: string) {
    const row = this.get(id, target);
    return (
      !!row && row.receipt_digest === digest && isDeepStrictEqual(JSON.parse(row.target), target)
    );
  }
  /** Caller has just checked opaque fresh native evidence and original host
   * receipts under current authority inside its existing write transaction. */
  remember(id: string, target: CodexNativeTurnTarget, digest: string, policyRevision?: string) {
    if (!this.available) throw Error('Readonly legacy settlement evidence unavailable');
    const previous = this.get(id, target);
    if (previous) {
      if (
        previous.receipt_digest !== digest ||
        !isDeepStrictEqual(JSON.parse(previous.target), target)
      )
        throw Error('Original effect settlement evidence changed');
      return;
    }
    this.db
      .prepare('INSERT INTO codex_effect_settlements VALUES(?,?,?,?,?,?,?)')
      .run(
        id,
        target.commandId,
        target.attempt,
        JSON.stringify(target),
        digest,
        policyRevision ?? null,
        Date.now(),
      );
  }
}

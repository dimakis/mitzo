import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { PrMonitorSubscription } from './pr-monitor.js';

// Collection has a 20s deadline. The extra 10s permits abort/cleanup, without
// heartbeats or another scheduler. This is same-host SQLite custody, not auth.
export const PR_MONITOR_CLAIM_TTL_MS = 30000;
export type PrMonitorClaim = Readonly<{
  operatorId: string;
  conversationId: string;
  subscriptionId: string;
  revision: number;
  ownerToken: string;
  generation: number;
  expiresAt: number;
}>;
type LeaseRow = {
  operator_id: string;
  conversation_id: string;
  subscription_id: string;
  revision: number;
  owner_token: string | null;
  generation: number;
  acquired_at: number;
  expires_at: number;
  last_seen_at: number;
};
class ClaimLost extends Error {
  constructor(readonly observedAt?: number) {
    super('observation_claim_lost');
  }
}
const lost = (observedAt?: number) => new ClaimLost(observedAt);
function validClock(now: number) {
  return (
    Number.isSafeInteger(now) && now >= 0 && Number.isSafeInteger(now + PR_MONITOR_CLAIM_TTL_MS)
  );
}

/** Borrows the existing EventStore DB. One row per retained subscription keeps
 * fencing generations and the clock high-water mark across release/restart.
 * No request/authority/quota ledger is pruned or reused here. */
export class PrMonitorLeases {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS pr_monitor_leases (
      subscription_id TEXT PRIMARY KEY REFERENCES pr_monitor_subscriptions(id) ON DELETE CASCADE,
      operator_id TEXT NOT NULL, conversation_id TEXT NOT NULL, revision INTEGER NOT NULL,
      owner_token TEXT, generation INTEGER NOT NULL, acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    )`);
  }
  private row(id: string) {
    return this.db.prepare('SELECT * FROM pr_monitor_leases WHERE subscription_id=?').get(id) as
      LeaseRow | undefined;
  }
  private current(s: {
    operatorId: string;
    conversationId: string;
    subscriptionId: string;
    revision: number;
  }) {
    return this.db
      .prepare(
        `SELECT 1 FROM pr_monitor_subscriptions
      WHERE id=? AND operator_id=? AND conversation_id=? AND json_extract(data,'$.subscription.revision')=?`,
      )
      .get(s.subscriptionId, s.operatorId, s.conversationId, s.revision);
  }
  acquire(s: PrMonitorSubscription, now: number): PrMonitorClaim | null {
    if (!validClock(now)) throw Error('invalid_observation_clock');
    return this.db
      .transaction(() => {
        const scope = {
          operatorId: s.operatorId,
          conversationId: s.conversationId,
          subscriptionId: s.id,
          revision: s.revision,
        };
        if (!this.current(scope)) return null;
        const prior = this.row(s.id);
        if (prior && now < prior.last_seen_at) {
          this.invalidate(s.id);
          return null;
        }
        if (prior?.owner_token && prior.revision === s.revision && now < prior.expires_at) {
          this.db
            .prepare('UPDATE pr_monitor_leases SET last_seen_at=? WHERE subscription_id=?')
            .run(now, s.id);
          return null;
        }
        const generation = (prior?.generation ?? 0) + 1;
        if (!Number.isSafeInteger(generation)) throw Error('observation_generation_exhausted');
        const claim: PrMonitorClaim = {
          ...scope,
          ownerToken: randomUUID(),
          generation,
          expiresAt: now + PR_MONITOR_CLAIM_TTL_MS,
        };
        this.db
          .prepare(
            `INSERT INTO pr_monitor_leases VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(subscription_id) DO UPDATE SET operator_id=excluded.operator_id,
        conversation_id=excluded.conversation_id, revision=excluded.revision, owner_token=excluded.owner_token,
        generation=excluded.generation, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at, last_seen_at=excluded.last_seen_at`,
          )
          .run(
            s.id,
            s.operatorId,
            s.conversationId,
            s.revision,
            claim.ownerToken,
            generation,
            now,
            claim.expiresAt,
            now,
          );
        return claim;
      })
      .immediate();
  }
  private matches(row: LeaseRow | undefined, claim: PrMonitorClaim): row is LeaseRow {
    return (
      !!row &&
      row.operator_id === claim.operatorId &&
      row.conversation_id === claim.conversationId &&
      row.subscription_id === claim.subscriptionId &&
      row.revision === claim.revision &&
      row.owner_token === claim.ownerToken &&
      row.generation === claim.generation &&
      row.expires_at === claim.expiresAt
    );
  }
  /** The failed check commits token invalidation before throwing, so a clock
   * returning forward cannot revive an observed expired/backward-clock token. */
  assert(claim: PrMonitorClaim, now: number): void {
    let observedAt = now;
    const valid = this.db
      .transaction(() => {
        const row = this.row(claim.subscriptionId);
        if (!this.matches(row, claim)) return false;
        observedAt = validClock(now) ? Math.max(now, row.last_seen_at) : row.last_seen_at;
        if (
          !validClock(now) ||
          now < row.last_seen_at ||
          now < row.acquired_at ||
          now >= row.expires_at ||
          !this.current(claim)
        ) {
          this.retire(claim, observedAt);
          return false;
        }
        this.db
          .prepare('UPDATE pr_monitor_leases SET last_seen_at=? WHERE subscription_id=?')
          .run(now, claim.subscriptionId);
        return true;
      })
      .immediate();
    if (!valid) throw lost(observedAt);
  }
  private retire(claim: PrMonitorClaim, observedAt?: number) {
    this.db
      .transaction(() => {
        if (this.release(claim) && observedAt !== undefined && validClock(observedAt))
          this.db
            .prepare(
              'UPDATE pr_monitor_leases SET last_seen_at=MAX(last_seen_at,?) WHERE subscription_id=?',
            )
            .run(observedAt, claim.subscriptionId);
      })
      .immediate();
  }
  /** Compare-token cleanup never deletes fencing history or another owner. */
  release(claim: PrMonitorClaim): boolean {
    return (
      this.db
        .prepare(
          `UPDATE pr_monitor_leases SET owner_token=NULL WHERE subscription_id=?
      AND operator_id=? AND conversation_id=? AND revision=? AND owner_token=? AND generation=?`,
        )
        .run(
          claim.subscriptionId,
          claim.operatorId,
          claim.conversationId,
          claim.revision,
          claim.ownerToken,
          claim.generation,
        ).changes === 1
    );
  }
  /** Called only within the owner's revocation/lifecycle mutation transaction. */
  invalidate(subscriptionId: string) {
    this.db
      .prepare('UPDATE pr_monitor_leases SET owner_token=NULL WHERE subscription_id=?')
      .run(subscriptionId);
  }
  withClaim<T>(
    input: {
      claim: PrMonitorClaim;
      operatorId: string;
      conversationId: string;
      subscriptionId: string;
      expectedRevision: number;
      now(): number;
    },
    operation: () => T,
  ): T {
    const { claim } = input;
    if (
      claim.operatorId !== input.operatorId ||
      claim.conversationId !== input.conversationId ||
      claim.subscriptionId !== input.subscriptionId ||
      claim.revision !== input.expectedRevision
    )
      throw lost();
    try {
      return this.db
        .transaction(() => {
          this.assert(claim, input.now());
          const result = operation();
          this.assert(claim, input.now());
          return result;
        })
        .immediate();
    } catch (error) {
      // A failed final check rolls back the observation AND its nested poison
      // write. Retire that exact token outside the rolled-back transaction.
      if (error instanceof ClaimLost) {
        try {
          this.retire(claim, error.observedAt);
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'observation_claim_cleanup_failed', {
            cause: cleanup,
          });
        }
      }
      throw error;
    }
  }
}

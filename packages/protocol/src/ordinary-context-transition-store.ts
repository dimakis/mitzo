import type Database from 'better-sqlite3';
import { z } from 'zod';

const reference = z.string().min(1).max(200).regex(/^\S+$/);
const epoch = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const Intent = z.strictObject({
  sessionId: reference,
  operationId: reference,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expectedEpoch: epoch,
});
const Receipt = Intent.extend({
  epoch,
  phase: z.enum(['held', 'released']),
  outcome: z.enum(['committed', 'aborted']).nullable(),
}).refine(
  (value) =>
    value.epoch === value.expectedEpoch + 1 &&
    (value.phase === 'held' ? value.outcome === null : value.outcome !== null),
);
const Command = z.strictObject({
  sessionId: reference,
  commandId: reference,
  requestFingerprint: z.string().min(1).max(1000),
});
const CommandStamp = Command.extend({ epoch });
export type OrdinaryContextTransitionIntent = z.infer<typeof Intent>;
export type OrdinaryContextTransitionReceipt = z.infer<typeof Receipt>;
type CommandIdentity = z.infer<typeof Command>;
const columns = `session_id AS sessionId, operation_id AS operationId, fingerprint,
  expected_epoch AS expectedEpoch, epoch, phase, outcome`;

/** Internal deny-only owner, sharing the event database's writer transaction.
 * Acquisition invalidates old preparations permanently, even when adoption aborts.
 * This epoch is not the role-context generation or permission to change a role.
 * Callers must separately prove ownership, quiescence and reviewed settlement.
 * Admission/claim assertions must run inside their owning writer transaction;
 * a prior read is not a permit for a later queue claim or provider dispatch.
 * Neither process loss nor age releases a pending fence. */
export class OrdinaryContextTransitionStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS ordinary_context_transitions (
      operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, expected_epoch INTEGER NOT NULL,
      epoch INTEGER NOT NULL, phase TEXT NOT NULL, outcome TEXT,
      UNIQUE(session_id, epoch)
    );
    CREATE TABLE IF NOT EXISTS ordinary_command_context_epochs (
      command_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL, epoch INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ordinary_context_retirements (
      operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL
    );`);
  }
  hasRetirement(raw: OrdinaryContextTransitionIntent): boolean {
    const input = Intent.parse(raw),
      receipt = this.read(input.operationId);
    if (!receipt) return false;
    this.assertIdentity(receipt, input);
    const row = this.db
      .prepare('SELECT fingerprint FROM ordinary_context_retirements WHERE operation_id=?')
      .get(input.operationId) as { fingerprint: string } | undefined;
    if (row && row.fingerprint !== input.fingerprint) throw Error('Retirement identity changed');
    return !!row;
  }
  /** Only the host that awaited the exact owner may retain resource-drain proof. */
  retainRetirement(raw: OrdinaryContextTransitionIntent, assertDrained: () => void): void {
    const input = Intent.parse(raw);
    this.db
      .transaction(() => {
        const receipt = this.read(input.operationId);
        if (!receipt || receipt.phase !== 'held') throw Error('Original held transition required');
        this.assertIdentity(receipt, input);
        const result: unknown = assertDrained();
        if (result !== undefined) throw Error('Synchronous retirement proof required');
        this.db
          .prepare(
            'INSERT OR IGNORE INTO ordinary_context_retirements(operation_id,fingerprint) VALUES(?,?)',
          )
          .run(input.operationId, input.fingerprint);
      })
      .immediate();
  }
  read(operationId: string): OrdinaryContextTransitionReceipt | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM ordinary_context_transitions WHERE operation_id=?`)
      .get(reference.parse(operationId));
    return row === undefined ? undefined : Receipt.parse(row);
  }
  private latest(sessionId: string) {
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM ordinary_context_transitions WHERE session_id=? ORDER BY epoch DESC LIMIT 1`,
      )
      .get(reference.parse(sessionId));
    return row === undefined ? undefined : Receipt.parse(row);
  }
  /** Observation permits recovery/settlement, never admission. */
  observe(sessionId: string): { epoch: number; held: boolean } {
    const current = this.latest(sessionId);
    return { epoch: current?.epoch ?? 0, held: current?.phase === 'held' };
  }
  /** Host-only synchronous serialization against a concurrent transition.
   * Acquire before the native writer; this is not a cross-database transaction.
   * Callers still check the exact command immediately before its native write.
   * Keep awaits and post-submission observers outside this lock. A synchronous
   * provider submission must retain its marker even on a synchronous throw;
   * return the ACK promise as data and await it only after commit. */
  withAdmissionLock<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }
  capture(sessionId: string): number {
    const current = this.observe(sessionId);
    if (current.held) throw Error('Conversation context transition requires reconciliation');
    return current.epoch;
  }
  assertAdmission(sessionId: string, expectedEpoch: number): void {
    if (this.capture(sessionId) !== epoch.parse(expectedEpoch))
      throw Error('Conversation context preparation is stale');
  }
  begin(raw: OrdinaryContextTransitionIntent): OrdinaryContextTransitionReceipt {
    const input = Intent.parse(raw);
    return this.db
      .transaction(() => {
        const previous = this.read(input.operationId);
        if (previous) {
          this.assertIdentity(previous, input);
          return previous;
        }
        this.assertAdmission(input.sessionId, input.expectedEpoch);
        const next = epoch.parse(input.expectedEpoch + 1);
        this.db
          .prepare(
            `INSERT INTO ordinary_context_transitions
        (operation_id,session_id,fingerprint,expected_epoch,epoch,phase,outcome)
        VALUES(?,?,?,?,?,'held',NULL)`,
          )
          .run(input.operationId, input.sessionId, input.fingerprint, input.expectedEpoch, next);
        return this.read(input.operationId)!;
      })
      .immediate();
  }
  /** The trusted host supplies synchronous proof of the exact adoption outcome.
   * A thrown/async proof leaves the same enduring fence for recovery. */
  release(
    raw: OrdinaryContextTransitionIntent,
    outcome: 'committed' | 'aborted',
    assertSettled: () => undefined,
  ): OrdinaryContextTransitionReceipt {
    const input = Intent.parse(raw);
    const selectedOutcome = z.enum(['committed', 'aborted']).parse(outcome);
    return this.db
      .transaction(() => {
        const previous = this.read(input.operationId);
        if (!previous) throw Error('Original context transition identity required');
        this.assertIdentity(previous, input);
        if (previous.phase === 'released') {
          if (previous.outcome !== selectedOutcome)
            throw Error('Context transition outcome identity changed');
          return previous;
        }
        const result: unknown = assertSettled();
        if (result !== undefined) {
          // Invalid async proof is never authority; observe rejection solely to avoid
          // an unhandled promise after rejecting this transaction synchronously.
          void Promise.resolve(result).catch(() => {});
          throw Error('Context transition requires synchronous settlement proof');
        }
        if (
          this.db
            .prepare(
              `UPDATE ordinary_context_transitions SET phase='released',outcome=?
        WHERE operation_id=? AND phase='held' AND fingerprint=?`,
            )
            .run(selectedOutcome, input.operationId, input.fingerprint).changes !== 1
        )
          throw Error('Context transition changed before settlement');
        return this.read(input.operationId)!;
      })
      .immediate();
  }
  private assertIdentity(
    receipt: OrdinaryContextTransitionReceipt,
    input: OrdinaryContextTransitionIntent,
  ) {
    if (
      receipt.sessionId !== input.sessionId ||
      receipt.operationId !== input.operationId ||
      receipt.fingerprint !== input.fingerprint ||
      receipt.expectedEpoch !== input.expectedEpoch
    )
      throw Error('Context transition identity changed');
  }
  readCommand(commandId: string): z.infer<typeof CommandStamp> | undefined {
    const row = this.db
      .prepare(
        `SELECT command_id AS commandId,session_id AS sessionId,
      request_fingerprint AS requestFingerprint,epoch FROM ordinary_command_context_epochs WHERE command_id=?`,
      )
      .get(reference.parse(commandId));
    return row === undefined ? undefined : CommandStamp.parse(row);
  }
  retainCommand(raw: CommandIdentity, expectedEpoch: number): void {
    const input = Command.parse(raw);
    epoch.parse(expectedEpoch);
    this.db
      .transaction(() => {
        const previous = this.readCommand(input.commandId);
        if (
          previous &&
          (previous.sessionId !== input.sessionId ||
            previous.requestFingerprint !== input.requestFingerprint ||
            previous.epoch !== expectedEpoch)
        )
          throw Error('Command context identity changed');
        this.assertAdmission(input.sessionId, expectedEpoch);
        if (!previous)
          this.db
            .prepare(
              `INSERT INTO ordinary_command_context_epochs
        (command_id,session_id,request_fingerprint,epoch) VALUES(?,?,?,?)`,
            )
            .run(input.commandId, input.sessionId, input.requestFingerprint, expectedEpoch);
      })
      .immediate();
  }
  assertCommand(raw: CommandIdentity): void {
    const input = Command.parse(raw);
    const previous = this.readCommand(input.commandId);
    if (
      previous &&
      (previous.sessionId !== input.sessionId ||
        previous.requestFingerprint !== input.requestFingerprint)
    )
      throw Error('Command context identity changed');
    // Legacy receipts cannot silently acquire a post-transition epoch.
    this.assertAdmission(input.sessionId, previous?.epoch ?? 0);
  }
}

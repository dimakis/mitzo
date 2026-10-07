import { createHash } from 'node:crypto';
import { TurnInputWriteSchema, type TurnInputWrite } from './codex-turn-input-receipt.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  AccountBindingSchema,
  SymposiumProvenanceSchema,
  type SymposiumProvenance,
} from '@mitzo/protocol';
const id = z.string().min(1);
const turnInputReceiptSchema = TurnInputWriteSchema.safeExtend({
  claimToken: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  seatId: z.string().min(1).max(256),
  eligibilityIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
});
/** Exactly the source history qualifier: capture time and config revision are excluded. */
function eligibilityIdentitySha256(provenance: SymposiumProvenance) {
  const identity = { ...provenance } as Record<string, unknown>;
  delete identity.capturedAt;
  delete identity.configRevision;
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
const identitySchema = z
  .strictObject({
    claimToken: id,
    sessionId: id,
    seatId: id,
    membershipGeneration: z.number().int().nonnegative(),
    accountBinding: AccountBindingSchema,
    provenance: SymposiumProvenanceSchema,
    providerThreadId: id,
    providerTurnId: id,
  })
  .refine(
    (value) =>
      value.provenance.seatId === value.seatId &&
      value.provenance.membershipGeneration === value.membershipGeneration &&
      value.provenance.accountProfileRevision === value.accountBinding.profileRevision,
    'Native observation provenance differs from accepted identity',
  );
export type NativeObservationIdentity = z.infer<typeof identitySchema>;
const terminalSchema = z.strictObject({
  claimToken: id,
  providerThreadId: id,
  providerTurnId: id,
  status: z.enum(['completed', 'interrupted', 'failed']),
});
export interface NativeTurnObservation {
  identity: NativeObservationIdentity;
  status: 'accepted' | 'completed' | 'interrupted' | 'failed';
  acceptedAt: number;
  terminalAt: number | null;
  terminalConflict: boolean;
  usageStatus: 'unknown';
  observedUsage: null;
}
/** Host-only observations, independent of controller cleanup and review admission.
 * No final usage, hard cap, artifact identity, or enforcement proof is inferred. */
export class SymposiumNativeObservations {
  constructor(
    private readonly db: Database.Database,
    private readonly reserved: (
      claim: string,
      session: string,
      provenance: SymposiumProvenance,
    ) => void,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS symposium_native_observations (
      claim_token TEXT PRIMARY KEY,
      identity_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('accepted', 'completed', 'interrupted', 'failed')),
      accepted_at INTEGER NOT NULL,
      terminal_at INTEGER,
      usage_status TEXT NOT NULL DEFAULT 'unknown' CHECK(usage_status = 'unknown'),
      observed_usage TEXT CHECK(observed_usage IS NULL)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS symposium_native_turn_inputs (
      claim_token TEXT PRIMARY KEY,
      receipt_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    db.exec(
      `CREATE TABLE IF NOT EXISTS symposium_native_terminal_conflicts (claim_token TEXT PRIMARY KEY, observed_status TEXT NOT NULL, observed_at INTEGER NOT NULL)`,
    );
  }
  /** Private host write facts only; no provider reception or consumption is inferred. */
  recordTurnInput(
    claimToken: string,
    sessionId: string,
    provenance: SymposiumProvenance,
    input: TurnInputWrite,
  ): void {
    const metadata = TurnInputWriteSchema.parse(input);
    if (metadata.commandId !== claimToken) throw new Error('Native input command identity changed');
    const receipt = turnInputReceiptSchema.parse({
      ...metadata,
      claimToken,
      sessionId,
      seatId: provenance.seatId,
      eligibilityIdentitySha256: eligibilityIdentitySha256(provenance),
    });
    this.db.transaction(() => {
      this.reserved(claimToken, sessionId, provenance);
      const previous = this.getTurnInput(claimToken);
      const { boundary, ...facts } = receipt;
      if (previous) {
        const { boundary: previousBoundary, ...previousFacts } = previous;
        if (JSON.stringify(facts) !== JSON.stringify(previousFacts))
          throw new Error('Native input receipt identity changed');
        if (boundary === previousBoundary) return;
        if (
          !(
            previousBoundary === 'prepared' && ['write_queued', 'write_failed'].includes(boundary)
          ) &&
          !(
            previousBoundary === 'write_queued' &&
            ['write_completed', 'write_failed'].includes(boundary)
          )
        )
          throw new Error('Native input receipt boundary changed');
        this.db
          .prepare(
            'UPDATE symposium_native_turn_inputs SET receipt_json = ?, updated_at = ? WHERE claim_token = ?',
          )
          .run(JSON.stringify(receipt), Date.now(), claimToken);
      } else {
        if (boundary !== 'prepared') throw new Error('Native input receipt was not prepared');
        this.db
          .prepare(
            'INSERT INTO symposium_native_turn_inputs (claim_token, receipt_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
          )
          .run(claimToken, JSON.stringify(receipt), Date.now(), Date.now());
      }
    })();
  }
  getTurnInput(claimToken: string): z.infer<typeof turnInputReceiptSchema> | undefined {
    const row = this.db
      .prepare('SELECT receipt_json FROM symposium_native_turn_inputs WHERE claim_token = ?')
      .get(claimToken) as { receipt_json: string } | undefined;
    return row ? turnInputReceiptSchema.parse(JSON.parse(row.receipt_json)) : undefined;
  }
  accept(input: NativeObservationIdentity): void {
    const identity = identitySchema.parse(input);
    const turnInput = this.getTurnInput(identity.claimToken);
    if (
      turnInput &&
      (turnInput.threadId !== identity.providerThreadId ||
        turnInput.eligibilityIdentitySha256 !== eligibilityIdentitySha256(input.provenance))
    )
      throw new Error('Native accepted input identity changed');
    const encoded = JSON.stringify(identity);
    this.db.transaction(() => {
      this.reserved(identity.claimToken, identity.sessionId, identity.provenance);
      const previous = this.get(identity.claimToken);
      if (previous) {
        if (JSON.stringify(previous.identity) !== encoded)
          throw new Error('Native observation identity changed');
        return;
      }
      this.db
        .prepare(
          `INSERT INTO symposium_native_observations
        (claim_token, identity_json, status, accepted_at) VALUES (?, ?, 'accepted', ?)`,
        )
        .run(identity.claimToken, encoded, Date.now());
    })();
  }
  terminal(input: z.infer<typeof terminalSchema>): void {
    const terminal = terminalSchema.parse(input);
    const existing = this.get(terminal.claimToken);
    if (
      existing &&
      existing.identity.providerThreadId === terminal.providerThreadId &&
      existing.identity.providerTurnId === terminal.providerTurnId &&
      existing.status !== 'accepted' &&
      existing.status !== terminal.status
    ) {
      this.conflict(terminal);
      throw new Error('Native terminal observation changed');
    }
    this.db.transaction(() => {
      const previous = this.get(terminal.claimToken);
      if (
        !previous ||
        previous.identity.providerThreadId !== terminal.providerThreadId ||
        previous.identity.providerTurnId !== terminal.providerTurnId
      )
        throw new Error('Native terminal identity is not accepted');
      if (previous.status !== 'accepted') {
        if (previous.status !== terminal.status)
          throw new Error('Native terminal observation changed');
        return;
      }
      this.db
        .prepare(
          'UPDATE symposium_native_observations SET status = ?, terminal_at = ? WHERE claim_token = ?',
        )
        .run(terminal.status, Date.now(), terminal.claimToken);
    })();
  }
  conflict(
    input: z.infer<typeof terminalSchema> & {
      previousStatus?: 'completed' | 'interrupted' | 'failed';
    },
  ): void {
    const { previousStatus, ...value } = input;
    const terminal = terminalSchema.parse(value);
    const previous = this.get(terminal.claimToken);
    if (
      !previous ||
      previous.identity.providerThreadId !== terminal.providerThreadId ||
      previous.identity.providerTurnId !== terminal.providerTurnId ||
      (previous.status === 'accepted' && !previousStatus) ||
      (previousStatus ?? previous.status) === terminal.status
    )
      throw new Error('Native terminal conflict does not match accepted terminal identity');
    this.db
      .prepare(
        'INSERT OR IGNORE INTO symposium_native_terminal_conflicts (claim_token, observed_status, observed_at) VALUES (?, ?, ?)',
      )
      .run(
        terminal.claimToken,
        JSON.stringify([previousStatus ?? previous.status, terminal.status]),
        Date.now(),
      );
  }
  get(claimToken: string): NativeTurnObservation | undefined {
    const row = this.db
      .prepare(
        `SELECT identity_json AS identity, status,
      accepted_at AS acceptedAt, terminal_at AS terminalAt, usage_status AS usageStatus, observed_usage AS observedUsage FROM symposium_native_observations WHERE claim_token = ?`,
      )
      .get(claimToken) as
      | {
          identity: string;
          status: NativeTurnObservation['status'];
          acceptedAt: number;
          terminalAt: number | null;
          usageStatus: 'unknown';
          observedUsage: null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      ...row,
      terminalConflict: !!this.db
        .prepare('SELECT 1 FROM symposium_native_terminal_conflicts WHERE claim_token = ?')
        .get(claimToken),
      identity: identitySchema.parse(JSON.parse(row.identity)),
      usageStatus: 'unknown',
      observedUsage: null,
    };
  }
}

import type Database from 'better-sqlite3';
import { z } from 'zod';
import { AccountBindingSchema, SymposiumProvenanceSchema } from '@mitzo/protocol';
const id = z.string().min(1);
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
  usageStatus: 'unknown';
  observedUsage: null;
}
/** Host-only observations, independent of controller cleanup and review admission.
 * No final usage, hard cap, artifact identity, or enforcement proof is inferred. */
export class SymposiumNativeObservations {
  constructor(
    private readonly db: Database.Database,
    private readonly reserved: (claim: string, session: string) => void,
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
  }
  accept(input: NativeObservationIdentity): void {
    const identity = identitySchema.parse(input);
    const encoded = JSON.stringify(identity);
    this.db.transaction(() => {
      this.reserved(identity.claimToken, identity.sessionId);
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
      identity: identitySchema.parse(JSON.parse(row.identity)),
      usageStatus: 'unknown',
      observedUsage: null,
    };
  }
}

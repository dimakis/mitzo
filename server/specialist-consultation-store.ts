import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  SpecialistPolicyInputSchema,
  SpecialistPolicySchema,
  ConsultationInputSchema,
  ConsultationRecordSchema,
  type SpecialistPolicy,
  type ConsultationRecord,
} from './specialist-consultation-contract.js';

/** Operation receipts in the existing events database. Execution and replies
 * remain exclusively with the shared-conversation and ordinary command owners. */
export class SpecialistConsultationStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS specialist_consultation_policies (
        lead_id TEXT NOT NULL, policy_id TEXT NOT NULL, input TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(lead_id, policy_id)
      );
      CREATE TABLE IF NOT EXISTS specialist_consultations (
        lead_id TEXT NOT NULL, request_id TEXT NOT NULL, policy_id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(lead_id, request_id)
      );
    `);
  }
  close() {
    this.db.close();
  }
  findPolicy(lead: string, policyId: string): SpecialistPolicy | undefined {
    const row = this.db
      .prepare('SELECT body FROM specialist_consultation_policies WHERE lead_id=? AND policy_id=?')
      .get(lead, policyId) as { body: string } | undefined;
    return row ? SpecialistPolicySchema.parse(JSON.parse(row.body)) : undefined;
  }
  policy(lead: string, policyId: string): SpecialistPolicy {
    const policy = this.findPolicy(lead, policyId);
    if (!policy) throw Error('Consultation policy not found');
    return policy;
  }
  policies(lead: string) {
    return (
      this.db
        .prepare(
          'SELECT body FROM specialist_consultation_policies WHERE lead_id=? ORDER BY rowid DESC LIMIT 20',
        )
        .all(lead) as { body: string }[]
    ).map((row) => SpecialistPolicySchema.parse(JSON.parse(row.body)));
  }
  assertPolicy(lead: string, login: string, policyId: string) {
    const policy = this.policy(lead, policyId);
    if (policy.revoked || policy.expiresAt <= Date.now())
      throw Error('Consultation policy expired or revoked');
    if (policy.authSessionId !== login) throw Error('Original consultation authorization required');
    return policy;
  }
  authorize(lead: string, login: string, raw: unknown, collaborationId?: string) {
    const input = SpecialistPolicyInputSchema.parse(raw);
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare(
            'SELECT input, body FROM specialist_consultation_policies WHERE lead_id=? AND policy_id=?',
          )
          .get(lead, input.requestId) as { input: string; body: string } | undefined;
        if (row) {
          const policy = SpecialistPolicySchema.parse(JSON.parse(row.body));
          if (policy.authSessionId !== login || !isDeepStrictEqual(JSON.parse(row.input), input))
            throw Error('Consultation policy request conflict');
          return policy;
        }
        const policy = SpecialistPolicySchema.parse({
          ...input,
          policyId: input.requestId,
          collaborationId: collaborationId ?? randomUUID(),
          leadSessionId: lead,
          authSessionId: login,
          revoked: false,
        });
        this.db
          .prepare('INSERT INTO specialist_consultation_policies VALUES(?,?,?,?)')
          .run(lead, policy.policyId, JSON.stringify(input), JSON.stringify(policy));
        return policy;
      })
      .immediate();
  }
  revoke(lead: string, policyId: string) {
    const policy = { ...this.policy(lead, policyId), revoked: true };
    this.db
      .prepare('UPDATE specialist_consultation_policies SET body=? WHERE lead_id=? AND policy_id=?')
      .run(JSON.stringify(policy), lead, policyId);
    return policy;
  }
  find(lead: string, requestId: string) {
    const row = this.db
      .prepare('SELECT body FROM specialist_consultations WHERE lead_id=? AND request_id=?')
      .get(lead, requestId) as { body: string } | undefined;
    return row ? ConsultationRecordSchema.parse(JSON.parse(row.body)) : undefined;
  }
  read(lead: string, requestId: string) {
    const record = this.find(lead, requestId);
    if (!record) throw Error('Consultation request not found');
    return record;
  }
  reserve(
    lead: string,
    login: string,
    policyId: string,
    raw: unknown,
    boundary: ConsultationRecord['boundary'],
    selectedRoute?: ConsultationRecord['route'],
  ) {
    const input = ConsultationInputSchema.parse(raw);
    return this.db
      .transaction(() => {
        const policy = this.assertPolicy(lead, login, policyId);
        const previous = this.find(lead, input.requestId);
        if (previous) {
          if (previous.policyId !== policyId || !isDeepStrictEqual(previous.input, input))
            throw Error('Consultation request conflict');
          return previous;
        }
        const count = this.db
          .prepare(
            'SELECT COUNT(*) AS count FROM specialist_consultations WHERE lead_id=? AND policy_id=?',
          )
          .get(lead, policyId) as { count: number };
        if (count.count >= policy.maxConsultations)
          throw Error('Consultation call budget exhausted');
        const record = ConsultationRecordSchema.parse({
          requestId: input.requestId,
          policyId,
          leadSessionId: lead,
          revision: 0,
          attemptOrdinal: count.count,
          input,
          route: selectedRoute ?? policy.routes.find((route) => route.role === input.role),
          boundary,
          workspaceId: randomUUID(),
          reviewRequestId: randomUUID(),
          joinRequestId: randomUUID(),
          sendRequestId: randomUUID(),
          state: 'reserved',
          sessionId: null,
          joinId: null,
          diagnostic: null,
        });
        this.db
          .prepare('INSERT INTO specialist_consultations VALUES(?,?,?,?)')
          .run(lead, record.requestId, policyId, JSON.stringify(record));
        return record;
      })
      .immediate();
  }
  update(
    lead: string,
    requestId: string,
    expectedRevision: number,
    patch: Partial<
      Pick<
        ConsultationRecord,
        'state' | 'sessionId' | 'joinId' | 'review' | 'messageInput' | 'diagnostic' | 'routingAudit'
      >
    >,
  ) {
    return this.db
      .transaction(() => {
        const record = this.read(lead, requestId);
        if (record.revision !== expectedRevision) throw Error('Consultation revision conflict');
        const next = ConsultationRecordSchema.parse({
          ...record,
          ...patch,
          revision: record.revision + 1,
        });
        this.db
          .prepare('UPDATE specialist_consultations SET body=? WHERE lead_id=? AND request_id=?')
          .run(JSON.stringify(next), lead, requestId);
        return next;
      })
      .immediate();
  }
}

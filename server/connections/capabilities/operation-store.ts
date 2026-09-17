import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { JsonValue } from '../types.js';
import type { CapabilityGrant, CapabilityOperation, CapabilityOperationStatus } from './types.js';

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string'))
    throw new Error('Stored capability state is invalid');
  return parsed;
}
function parseJsonValue(value: string | null): JsonValue | null {
  if (value === null) return null;
  return JSON.parse(value) as JsonValue;
}
function operation(row: Record<string, unknown>): CapabilityOperation {
  return {
    id: row.id as string,
    connectionId: row.connection_id as string,
    connectionRevision: row.connection_revision as number,
    capabilityId: row.capability_id as string,
    capabilityVersion: row.capability_version as number,
    grantId: row.grant_id as string,
    accountId: row.account_id as string,
    conversationId: row.conversation_id as string,
    turnId: row.turn_id as string,
    idempotencyKey: row.idempotency_key as string,
    inputHash: row.input_hash as string,
    status: row.status as CapabilityOperationStatus,
    externalResultId: row.external_result_id as string | null,
    result: parseJsonValue(row.result_json as string | null),
    failureCode: row.failure_code as string | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
function grant(row: Record<string, unknown>): CapabilityGrant {
  return {
    id: row.id as string,
    connectionId: row.connection_id as string,
    connectionRevision: row.connection_revision as number,
    capabilityId: row.capability_id as string,
    capabilityVersion: row.capability_version as number,
    accountIds: parseStringArray(row.account_ids as string),
    status: row.status as 'active' | 'revoked',
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

/** Durable capability grant, operation, and redacted audit store. */
export class CapabilityOperationStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS capability_grants (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, connection_revision INTEGER NOT NULL CHECK(connection_revision > 0),
      capability_id TEXT NOT NULL, capability_version INTEGER NOT NULL CHECK(capability_version > 0), account_ids TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','revoked')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(connection_id, connection_revision, capability_id, capability_version)
    );
    CREATE TABLE IF NOT EXISTS capability_operations (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, connection_revision INTEGER NOT NULL, capability_id TEXT NOT NULL,
      capability_version INTEGER NOT NULL, grant_id TEXT NOT NULL REFERENCES capability_grants(id), account_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending_approval','running','verification_pending','succeeded','denied','cancelled','failed')),
      external_result_id TEXT, result_json TEXT, failure_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(connection_id, capability_id, capability_version, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS capability_operation_audit (
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES capability_operations(id), event TEXT NOT NULL, outcome TEXT NOT NULL,
      failure_code TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_capability_operations_subject ON capability_operations(account_id, conversation_id, created_at);`);
  }
  close() {
    this.db.close();
  }
  upsertGrant(
    input: Omit<CapabilityGrant, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  ): CapabilityGrant {
    const accountIds = [...new Set(input.accountIds)].sort();
    if (
      !input.connectionId ||
      !input.capabilityId ||
      !accountIds.length ||
      accountIds.some((id) => !id)
    )
      throw new Error('Invalid capability grant');
    const now = Date.now();
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(
          'SELECT * FROM capability_grants WHERE connection_id=? AND connection_revision=? AND capability_id=? AND capability_version=?',
        )
        .get(
          input.connectionId,
          input.connectionRevision,
          input.capabilityId,
          input.capabilityVersion,
        ) as Record<string, unknown> | undefined;
      if (existing) {
        this.db
          .prepare('UPDATE capability_grants SET account_ids=?, status=?, updated_at=? WHERE id=?')
          .run(JSON.stringify(accountIds), input.status, now, existing.id);
        return grant(
          this.db.prepare('SELECT * FROM capability_grants WHERE id=?').get(existing.id) as Record<
            string,
            unknown
          >,
        );
      }
      const id = input.id ?? randomUUID();
      this.db
        .prepare('INSERT INTO capability_grants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          id,
          input.connectionId,
          input.connectionRevision,
          input.capabilityId,
          input.capabilityVersion,
          JSON.stringify(accountIds),
          input.status,
          now,
          now,
        );
      return grant(
        this.db.prepare('SELECT * FROM capability_grants WHERE id=?').get(id) as Record<
          string,
          unknown
        >,
      );
    })();
  }
  getGrant(
    connectionId: string,
    revision: number,
    capabilityId: string,
    version: number,
  ): CapabilityGrant | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM capability_grants WHERE connection_id=? AND connection_revision=? AND capability_id=? AND capability_version=?',
      )
      .get(connectionId, revision, capabilityId, version) as Record<string, unknown> | undefined;
    return row ? grant(row) : undefined;
  }
  grants(connectionId: string): CapabilityGrant[] {
    return (
      this.db
        .prepare('SELECT * FROM capability_grants WHERE connection_id=? ORDER BY created_at')
        .all(connectionId) as Record<string, unknown>[]
    ).map(grant);
  }
  begin(
    input: Omit<
      CapabilityOperation,
      'id' | 'status' | 'externalResultId' | 'result' | 'failureCode' | 'createdAt' | 'updatedAt'
    >,
  ): { operation: CapabilityOperation; created: boolean } {
    if (!input.idempotencyKey || input.idempotencyKey.length > 256)
      throw new Error('Invalid idempotency key');
    const now = Date.now();
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(
          'SELECT * FROM capability_operations WHERE connection_id=? AND capability_id=? AND capability_version=? AND idempotency_key=?',
        )
        .get(
          input.connectionId,
          input.capabilityId,
          input.capabilityVersion,
          input.idempotencyKey,
        ) as Record<string, unknown> | undefined;
      if (existing) {
        const item = operation(existing);
        if (
          item.connectionRevision !== input.connectionRevision ||
          item.grantId !== input.grantId ||
          item.accountId !== input.accountId ||
          item.conversationId !== input.conversationId ||
          item.inputHash !== input.inputHash
        )
          throw new Error('Idempotency key is already bound to another request');
        return { operation: item, created: false };
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO capability_operations (
        id, connection_id, connection_revision, capability_id, capability_version, grant_id,
        account_id, conversation_id, turn_id, idempotency_key, input_hash, status,
        external_result_id, result_json, failure_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          id,
          input.connectionId,
          input.connectionRevision,
          input.capabilityId,
          input.capabilityVersion,
          input.grantId,
          input.accountId,
          input.conversationId,
          input.turnId,
          input.idempotencyKey,
          input.inputHash,
          'pending_approval',
          now,
          now,
        );
      this.audit(id, 'requested', 'pending', null, now);
      return {
        operation: operation(
          this.db.prepare('SELECT * FROM capability_operations WHERE id=?').get(id) as Record<
            string,
            unknown
          >,
        ),
        created: true,
      };
    })();
  }
  get(id: string): CapabilityOperation | undefined {
    const row = this.db.prepare('SELECT * FROM capability_operations WHERE id=?').get(id) as
      Record<string, unknown> | undefined;
    return row ? operation(row) : undefined;
  }
  pendingRecovery(): CapabilityOperation[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM capability_operations WHERE status='verification_pending' ORDER BY created_at",
        )
        .all() as Record<string, unknown>[]
    ).map(operation);
  }
  transition(
    id: string,
    expected: CapabilityOperationStatus,
    next: CapabilityOperationStatus,
    fields: { result?: JsonValue; externalResultId?: string; failureCode?: string } = {},
  ): CapabilityOperation {
    const now = Date.now();
    return this.db.transaction(() => {
      const changed = this.db
        .prepare(
          'UPDATE capability_operations SET status=?, result_json=?, external_result_id=?, failure_code=?, updated_at=? WHERE id=? AND status=?',
        )
        .run(
          next,
          fields.result === undefined ? null : JSON.stringify(fields.result),
          fields.externalResultId ?? null,
          fields.failureCode ?? null,
          now,
          id,
          expected,
        );
      if (changed.changes !== 1) throw new Error('Capability operation state changed');
      this.audit(id, next, next === 'failed' ? 'error' : 'ok', fields.failureCode ?? null, now);
      return this.get(id)!;
    })();
  }
  private audit(
    operationId: string,
    event: string,
    outcome: string,
    failureCode: string | null,
    now: number,
  ) {
    this.db
      .prepare('INSERT INTO capability_operation_audit VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), operationId, event, outcome, failureCode, now);
  }
}

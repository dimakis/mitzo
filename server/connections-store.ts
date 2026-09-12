import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type ConnectionStatus =
  'provisioning' | 'needs_attention' | 'active' | 'rotating' | 'revoking' | 'revoked';
export interface Connection {
  id: string;
  ownerId: string;
  templateId: string;
  templateVersion: number;
  label: string;
  endpoint: string;
  gatewayProviderName: string;
  gatewayProviderId: string | null;
  gateway: string;
  workspace: string;
  submittedEmail: string;
  status: ConnectionStatus;
  revision: number;
  desiredAccountIds: string[];
  identity: string | null;
  verifiedAt: number | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface AuditEntry {
  id: string;
  connectionId: string;
  revision: number;
  operation: string;
  outcome: string;
  actor: string;
  affectedRefs: string[];
  createdAt: number;
}
export interface ProbeOperation {
  id: string;
  connectionId: string;
  providerName: string;
  sandboxName: string;
  gateway: string;
  workspace: string;
  status: 'pending' | 'cleanup_pending';
}
export class RevisionConflictError extends Error {
  constructor() {
    super('Connection changed; refresh and try again.');
  }
}

const statuses = new Set<ConnectionStatus>([
  'provisioning',
  'needs_attention',
  'active',
  'rotating',
  'revoking',
  'revoked',
]);
function row(row: Record<string, unknown>): Connection {
  return {
    id: row.id as string,
    ownerId: row.owner_id as string,
    templateId: row.template_id as string,
    templateVersion: row.template_version as number,
    label: row.label as string,
    endpoint: row.endpoint as string,
    gatewayProviderName: row.gateway_provider_name as string,
    gatewayProviderId: row.gateway_provider_id as string | null,
    gateway: row.gateway as string,
    workspace: row.workspace as string,
    submittedEmail: row.submitted_email as string,
    status: row.status as ConnectionStatus,
    revision: row.revision as number,
    desiredAccountIds: JSON.parse(row.desired_account_ids as string),
    identity: row.identity as string | null,
    verifiedAt: row.verified_at as number | null,
    errorCode: row.error_code as string | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export class ConnectionStore {
  private db: Database.Database | null;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, template_id TEXT NOT NULL, template_version INTEGER NOT NULL, label TEXT NOT NULL, endpoint TEXT NOT NULL, gateway_provider_name TEXT NOT NULL UNIQUE, gateway_provider_id TEXT, gateway TEXT NOT NULL DEFAULT 'openshell', workspace TEXT NOT NULL DEFAULT 'default', submitted_email TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), desired_account_ids TEXT NOT NULL, identity TEXT, verified_at INTEGER, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connection_audit (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id), revision INTEGER NOT NULL, operation TEXT NOT NULL, outcome TEXT NOT NULL, actor TEXT NOT NULL, affected_refs TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connection_probe_operations (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id), provider_name TEXT NOT NULL, sandbox_name TEXT NOT NULL UNIQUE, gateway TEXT NOT NULL, workspace TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connection_assignment_operations (connection_id TEXT PRIMARY KEY REFERENCES connections(id), account_ids TEXT NOT NULL, removed_ids TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connection_candidates (name TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id), provider_id TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_connection_audit_connection ON connection_audit(connection_id, created_at);`);
    for (const statement of [
      "ALTER TABLE connections ADD COLUMN gateway TEXT NOT NULL DEFAULT 'openshell'",
      "ALTER TABLE connections ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE connections ADD COLUMN submitted_email TEXT NOT NULL DEFAULT ''",
    ])
      try {
        this.db.exec(statement);
      } catch {
        /* existing schema */
      }
  }
  startAssignment(connection: Connection, accountIds: string[], removedIds: string[]) {
    return this.database().transaction(() => {
      this.database()
        .prepare('INSERT INTO connection_assignment_operations VALUES (?, ?, ?)')
        .run(connection.id, JSON.stringify(accountIds), JSON.stringify(removedIds));
      return this.transition(
        connection.id,
        connection.revision,
        { status: 'needs_attention', errorCode: 'ASSIGNMENT_PENDING' },
        {
          operation: 'assign',
          outcome: 'started',
          actor: connection.ownerId,
          affectedRefs: removedIds,
        },
      );
    })();
  }
  pendingAssignments() {
    return (
      this.database().prepare('SELECT * FROM connection_assignment_operations').all() as Array<{
        connection_id: string;
        account_ids: string;
        removed_ids: string;
      }>
    ).map((r) => ({
      connectionId: r.connection_id,
      accountIds: JSON.parse(r.account_ids) as string[],
      removedIds: JSON.parse(r.removed_ids) as string[],
    }));
  }
  finishAssignment(id: string) {
    this.database()
      .prepare('DELETE FROM connection_assignment_operations WHERE connection_id=?')
      .run(id);
  }
  startCandidate(connectionId: string, name: string) {
    this.database()
      .prepare('INSERT INTO connection_candidates VALUES (?, ?, NULL, ?)')
      .run(name, connectionId, Date.now());
  }
  bindCandidate(name: string, providerId: string) {
    this.database()
      .prepare('UPDATE connection_candidates SET provider_id=? WHERE name=?')
      .run(providerId, name);
  }
  candidates() {
    return this.database()
      .prepare(
        'SELECT name, connection_id AS connectionId, provider_id AS providerId FROM connection_candidates',
      )
      .all() as Array<{ name: string; connectionId: string; providerId: string | null }>;
  }
  finishCandidate(name: string) {
    this.database().prepare('DELETE FROM connection_candidates WHERE name=?').run(name);
  }
  startProbe(connection: Connection, sandboxName: string): ProbeOperation {
    const id = randomUUID();
    this.database()
      .prepare('INSERT INTO connection_probe_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        connection.id,
        connection.gatewayProviderName,
        sandboxName,
        connection.gateway,
        connection.workspace,
        'pending',
        Date.now(),
      );
    return {
      id,
      connectionId: connection.id,
      providerName: connection.gatewayProviderName,
      sandboxName,
      gateway: connection.gateway,
      workspace: connection.workspace,
      status: 'pending',
    };
  }
  pendingProbes(): ProbeOperation[] {
    return this.database()
      .prepare(
        "SELECT * FROM connection_probe_operations WHERE status IN ('pending','cleanup_pending')",
      )
      .all()
      .map((value) => {
        const r = value as Record<string, string>;
        return {
          id: r.id,
          connectionId: r.connection_id,
          providerName: r.provider_name,
          sandboxName: r.sandbox_name,
          gateway: r.gateway,
          workspace: r.workspace,
          status: r.status as ProbeOperation['status'],
        };
      });
  }
  finishProbe(id: string) {
    this.database().prepare('DELETE FROM connection_probe_operations WHERE id=?').run(id);
  }
  probeCleanupPending(id: string) {
    this.database()
      .prepare("UPDATE connection_probe_operations SET status='cleanup_pending' WHERE id=?")
      .run(id);
  }
  close() {
    this.db?.close();
    this.db = null;
  }
  private database() {
    if (!this.db) throw new Error('ConnectionStore is closed');
    return this.db;
  }
  create(
    input: Pick<
      Connection,
      | 'ownerId'
      | 'templateId'
      | 'templateVersion'
      | 'label'
      | 'endpoint'
      | 'gatewayProviderName'
      | 'desiredAccountIds'
    > &
      Partial<Pick<Connection, 'gateway' | 'workspace' | 'submittedEmail'>>,
  ): Connection {
    const now = Date.now();
    const id = randomUUID();
    const db = this.database();
    const transaction = db.transaction(() => {
      db.prepare(
        'INSERT INTO connections (id, owner_id, template_id, template_version, label, endpoint, gateway_provider_name, gateway_provider_id, gateway, workspace, submitted_email, status, revision, desired_account_ids, identity, verified_at, error_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1, ?, NULL, NULL, NULL, ?, ?)',
      ).run(
        id,
        input.ownerId,
        input.templateId,
        input.templateVersion,
        input.label,
        input.endpoint,
        input.gatewayProviderName,
        input.gateway ?? 'openshell',
        input.workspace ?? 'default',
        input.submittedEmail ?? '',
        'provisioning',
        JSON.stringify(input.desiredAccountIds),
        now,
        now,
      );
      db.prepare('INSERT INTO connection_audit VALUES (?, ?, 1, ?, ?, ?, ?, ?)').run(
        randomUUID(),
        id,
        'provision',
        'started',
        input.ownerId,
        '[]',
        now,
      );
    });
    transaction();
    return this.get(id)!;
  }
  get(id: string) {
    const result = this.database().prepare('SELECT * FROM connections WHERE id=?').get(id) as
      Record<string, unknown> | undefined;
    return result ? row(result) : null;
  }
  list(ownerId: string) {
    return (
      this.database()
        .prepare('SELECT * FROM connections WHERE owner_id=? ORDER BY created_at DESC')
        .all(ownerId) as Record<string, unknown>[]
    ).map(row);
  }
  incomplete() {
    return (
      this.database()
        .prepare(
          "SELECT * FROM connections WHERE status IN ('provisioning','rotating','revoking') ORDER BY created_at",
        )
        .all() as Record<string, unknown>[]
    ).map(row);
  }
  transition(
    id: string,
    revision: number,
    changes: Partial<
      Pick<
        Connection,
        | 'status'
        | 'gatewayProviderId'
        | 'desiredAccountIds'
        | 'identity'
        | 'verifiedAt'
        | 'errorCode'
      >
    >,
    audit: Omit<AuditEntry, 'id' | 'connectionId' | 'revision' | 'createdAt' | 'affectedRefs'> & {
      affectedRefs?: string[];
    },
  ): Connection {
    if (changes.status && !statuses.has(changes.status))
      throw new Error('Invalid connection status');
    const db = this.database();
    const transaction = db.transaction(() => {
      const current = this.get(id);
      if (!current) throw new Error('Connection not found');
      if (current.revision !== revision) throw new RevisionConflictError();
      const next = {
        ...current,
        ...changes,
        revision: current.revision + 1,
        updatedAt: Date.now(),
      };
      if (next.status === 'active')
        this.assertNoAssignmentCollision(id, next.templateId, next.desiredAccountIds);
      db.prepare(
        'UPDATE connections SET gateway_provider_id=?, status=?, revision=?, desired_account_ids=?, identity=?, verified_at=?, error_code=?, updated_at=? WHERE id=?',
      ).run(
        next.gatewayProviderId,
        next.status,
        next.revision,
        JSON.stringify(next.desiredAccountIds),
        next.identity,
        next.verifiedAt,
        next.errorCode,
        next.updatedAt,
        id,
      );
      db.prepare('INSERT INTO connection_audit VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        randomUUID(),
        id,
        next.revision,
        audit.operation,
        audit.outcome,
        audit.actor,
        JSON.stringify(audit.affectedRefs ?? []),
        next.updatedAt,
      );
      return this.get(id)!;
    });
    return transaction();
  }
  private assertNoAssignmentCollision(id: string, templateId: string, accountIds: string[]) {
    const duplicate = new Set(accountIds);
    if (duplicate.size !== accountIds.length) throw new Error('Duplicate account assignment');
    const active = this.database()
      .prepare(
        "SELECT id, desired_account_ids FROM connections WHERE id != ? AND template_id = ? AND status IN ('active','rotating','revoking','needs_attention')",
      )
      .all(id, templateId) as Array<{ id: string; desired_account_ids: string }>;
    if (
      active.some((item) =>
        JSON.parse(item.desired_account_ids).some((account: string) => duplicate.has(account)),
      )
    )
      throw new Error('An account is already assigned to this connection type');
  }
  setAssignments(id: string, revision: number, accountIds: string[], actor: string) {
    const current = this.get(id);
    if (!current) throw new Error('Connection not found');
    this.assertNoAssignmentCollision(id, current.templateId, accountIds);
    return this.transition(
      id,
      revision,
      { desiredAccountIds: accountIds },
      { operation: 'assign', outcome: 'success', actor, affectedRefs: accountIds },
    );
  }
  audit(connectionId: string): AuditEntry[] {
    return (
      this.database()
        .prepare('SELECT * FROM connection_audit WHERE connection_id=? ORDER BY created_at')
        .all(connectionId) as Array<Record<string, unknown>>
    ).map((entry) => ({
      id: entry.id as string,
      connectionId: entry.connection_id as string,
      revision: entry.revision as number,
      operation: entry.operation as string,
      outcome: entry.outcome as string,
      actor: entry.actor as string,
      affectedRefs: JSON.parse(entry.affected_refs as string),
      createdAt: entry.created_at as number,
    }));
  }
}

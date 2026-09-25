import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { AccountBindingSchema, type AccountBinding } from '@mitzo/protocol';

export type ChildStatus =
  | 'allocated'
  | 'starting'
  | 'running'
  | 'recovery_required'
  | 'cancel_requested'
  | 'cancelled'
  | 'completed';

export interface ChildCreateRequest {
  parentConversationId: string;
  idempotencyKey: string;
  inputHash: string;
  prompt: string;
  taskRootId?: string;
  taskNodeId?: string;
  planRevision?: string;
  grantId: string;
  accountBinding: AccountBinding;
  isolation: 'independent' | 'symposium_shared';
}

/** Constructed by the host after authenticating the caller and resolving its
 * current grant. Never construct this from model-supplied tool arguments. */
export interface ChildAuthority {
  parentConversationId: string;
  allowedGrantIds: readonly string[];
  maxChildren: number;
  maxConcurrent: number;
  maxDepth: number;
  maxSpawnsPerMinute: number;
  allowSymposiumSharing?: boolean;
}

export interface ChildLink extends ChildCreateRequest {
  conversationId: string;
  depth: number;
  status: ChildStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ChildRuntime {
  /** `absent` must be an authoritative observation; uncertainty is `unknown`. */
  inspect(conversationId: string): Promise<'absent' | 'running' | 'completed' | 'unknown'>;
  /** Resolve after runtime has accepted this exact conversation ID, not after the turn. */
  start(child: ChildLink): Promise<void>;
  stop(conversationId: string): Promise<'confirmed' | 'unknown'>;
}

interface ChildRow {
  conversation_id: string;
  parent_conversation_id: string;
  idempotency_key: string;
  request_hash: string;
  request_json: string;
  depth: number;
  status: ChildStatus;
  created_at: number;
  updated_at: number;
  dispatch_owner: string | null;
  dispatch_lease_until: number | null;
}

interface MailRow {
  seq: number;
  child_id: string;
  type: string;
  payload: string;
  created_at: number;
}

const ACTIVE = "('allocated','starting','running','recovery_required','cancel_requested')";

function requireId(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
}

function validateRequest(request: ChildCreateRequest): void {
  for (const [name, value] of Object.entries({
    parentConversationId: request.parentConversationId,
    idempotencyKey: request.idempotencyKey,
    prompt: request.prompt,
    grantId: request.grantId,
  }))
    requireId(value, name);
  if (!/^[0-9a-f]{64}$/i.test(request.inputHash)) throw new Error('Invalid input hash');
  if (request.taskNodeId && !request.taskRootId) throw new Error('Task node needs a task root');
  AccountBindingSchema.parse(request.accountBinding);
  if (!['independent', 'symposium_shared'].includes(request.isolation))
    throw new Error('Invalid isolation');
}

function requestFingerprint(request: ChildCreateRequest): string {
  // Fixed field order makes omission and optional-undefined behavior explicit.
  const normalized = {
    parentConversationId: request.parentConversationId,
    idempotencyKey: request.idempotencyKey,
    inputHash: request.inputHash,
    prompt: request.prompt,
    taskRootId: request.taskRootId ?? null,
    taskNodeId: request.taskNodeId ?? null,
    planRevision: request.planRevision ?? null,
    grantId: request.grantId,
    accountBinding: AccountBindingSchema.parse(request.accountBinding),
    isolation: request.isolation,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function childFromRow(row: ChildRow): ChildLink {
  return {
    ...(JSON.parse(row.request_json) as ChildCreateRequest),
    conversationId: row.conversation_id,
    depth: row.depth,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Host-owned allocation and start outbox. The canonical conversation row stays
 * in EventStore's `sessions`; this table only owns parentage and start intent. */
export class SessionService {
  private db: Database.Database;
  private readonly ownerId = randomUUID();
  constructor(
    dbPath: string,
    private runtime: ChildRuntime,
  ) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS child_allocations (
        conversation_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
        parent_conversation_id TEXT NOT NULL REFERENCES sessions(session_id),
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        depth INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN
          ('allocated','starting','running','recovery_required','cancel_requested','cancelled','completed')),
        dispatch_owner TEXT,
        dispatch_lease_until INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(parent_conversation_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_child_parent_status
        ON child_allocations(parent_conversation_id, status);
      CREATE TABLE IF NOT EXISTS child_mailbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        child_id TEXT NOT NULL REFERENCES child_allocations(conversation_id),
        type TEXT NOT NULL CHECK(type IN ('result','event')),
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_child_mailbox ON child_mailbox(child_id, seq);
    `);
  }

  close(): void {
    this.db.close();
  }

  getChild(conversationId: string): ChildLink | null {
    const row = this.db
      .prepare('SELECT * FROM child_allocations WHERE conversation_id = ?')
      .get(conversationId) as ChildRow | undefined;
    return row ? childFromRow(row) : null;
  }

  listChildren(parentConversationId: string): ChildLink[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM child_allocations WHERE parent_conversation_id = ? ORDER BY created_at, conversation_id',
        )
        .all(parentConversationId) as ChildRow[]
    ).map(childFromRow);
  }

  createChild(request: ChildCreateRequest, authority: ChildAuthority): ChildLink {
    validateRequest(request);
    requireId(authority.parentConversationId, 'trusted parent');
    if (request.parentConversationId !== authority.parentConversationId)
      throw new Error('Parent authority mismatch');
    if (!authority.allowedGrantIds.includes(request.grantId)) throw new Error('Grant denied');
    if (request.isolation === 'symposium_shared' && !authority.allowSymposiumSharing)
      throw new Error('Symposium sharing requires explicit host authorization');
    for (const value of [
      authority.maxChildren,
      authority.maxConcurrent,
      authority.maxDepth,
      authority.maxSpawnsPerMinute,
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid child budget');
    }
    const fingerprint = requestFingerprint(request);
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare(
            'SELECT * FROM child_allocations WHERE parent_conversation_id = ? AND idempotency_key = ?',
          )
          .get(request.parentConversationId, request.idempotencyKey) as ChildRow | undefined;
        if (existing) {
          if (existing.request_hash !== fingerprint) throw new Error('Idempotency conflict');
          return childFromRow(existing);
        }
        const parent = this.db
          .prepare('SELECT session_id FROM sessions WHERE session_id = ?')
          .get(request.parentConversationId);
        if (!parent) throw new Error('Parent conversation does not exist');
        const parentAllocation = this.db
          .prepare(
            'SELECT depth, status, request_json FROM child_allocations WHERE conversation_id = ?',
          )
          .get(request.parentConversationId) as
          { depth: number; status: ChildStatus; request_json: string } | undefined;
        if (parentAllocation) {
          if (parentAllocation.status !== 'running') throw new Error('Parent is not active');
          const inherited = JSON.parse(parentAllocation.request_json) as ChildCreateRequest;
          if (inherited.grantId !== request.grantId) throw new Error('Grant exceeds parent scope');
        }
        const depth = (parentAllocation?.depth ?? 0) + 1;
        if (depth > authority.maxDepth) throw new Error('Child depth budget exceeded');
        const total = this.db
          .prepare('SELECT COUNT(*) AS n FROM child_allocations WHERE parent_conversation_id = ?')
          .get(request.parentConversationId) as { n: number };
        if (total.n >= authority.maxChildren) throw new Error('Child count budget exceeded');
        const active = this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM child_allocations WHERE parent_conversation_id = ? AND status IN ${ACTIVE}`,
          )
          .get(request.parentConversationId) as { n: number };
        if (active.n >= authority.maxConcurrent)
          throw new Error('Concurrent child budget exceeded');
        const now = Date.now();
        const recent = this.db
          .prepare(
            'SELECT COUNT(*) AS n FROM child_allocations WHERE parent_conversation_id = ? AND created_at > ?',
          )
          .get(request.parentConversationId, now - 60_000) as { n: number };
        if (recent.n >= authority.maxSpawnsPerMinute) throw new Error('Spawn rate budget exceeded');
        const conversationId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO sessions
        (session_id, mode, account_binding, selected_model, initial_prompt, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            conversationId,
            'agent',
            JSON.stringify(request.accountBinding),
            request.accountBinding.model,
            request.prompt,
            now,
            now,
          );
        this.db
          .prepare(
            `INSERT INTO child_allocations
        (conversation_id,parent_conversation_id,idempotency_key,request_hash,request_json,depth,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            conversationId,
            request.parentConversationId,
            request.idempotencyKey,
            fingerprint,
            JSON.stringify(request),
            depth,
            'allocated',
            now,
            now,
          );
        return this.getChild(conversationId)!;
      })
      .immediate();
  }

  private setStatus(id: string, status: ChildStatus): void {
    this.db
      .prepare('UPDATE child_allocations SET status = ?, updated_at = ? WHERE conversation_id = ?')
      .run(status, Date.now(), id);
  }

  /** Inspect before dispatching the pending start. An uncertain observation is
   * fenced; it never mints another provider attempt. */
  async reconcile(conversationId: string): Promise<ChildLink> {
    let child = this.getChild(conversationId);
    if (!child) throw new Error('Unknown child');
    if (child.status === 'cancel_requested') {
      const stopped = await this.runtime.stop(conversationId);
      this.setStatus(conversationId, stopped === 'confirmed' ? 'cancelled' : 'recovery_required');
      return this.getChild(conversationId)!;
    }
    if (
      child.status === 'cancelled' ||
      child.status === 'completed' ||
      child.status === 'recovery_required'
    )
      return child;
    const observed = await this.runtime.inspect(conversationId);
    child = this.getChild(conversationId)!;
    if (child.status === 'cancel_requested' || child.status === 'cancelled')
      return this.reconcile(conversationId);
    if (observed === 'unknown') this.setStatus(conversationId, 'recovery_required');
    else if (observed === 'completed') this.setStatus(conversationId, 'completed');
    else if (observed === 'running') this.setStatus(conversationId, 'running');
    else if (child.status === 'running') this.setStatus(conversationId, 'recovery_required');
    else {
      const now = Date.now();
      const claimed = this.db
        .prepare(
          `UPDATE child_allocations
        SET status = 'starting', dispatch_owner = ?, dispatch_lease_until = ?, updated_at = ?
        WHERE conversation_id = ? AND (status = 'allocated' OR
          (status = 'starting' AND dispatch_lease_until < ?))`,
        )
        .run(this.ownerId, now + 30_000, now, conversationId, now);
      if (claimed.changes !== 1) return this.getChild(conversationId)!;
      try {
        await this.runtime.start(this.getChild(conversationId)!);
      } catch {
        this.setStatus(conversationId, 'recovery_required');
        return this.getChild(conversationId)!;
      }
      const after = this.getChild(conversationId)!;
      if (after.status === 'cancel_requested' || after.status === 'cancelled') {
        // A stop may have raced ahead of a late runtime attachment. Repeat
        // cleanup after start resolves; an unknown stop remains fenced.
        const stopped = await this.runtime.stop(conversationId);
        this.setStatus(conversationId, stopped === 'confirmed' ? 'cancelled' : 'recovery_required');
        return this.getChild(conversationId)!;
      }
      this.db
        .prepare(
          `UPDATE child_allocations SET status = 'running', updated_at = ?
        WHERE conversation_id = ? AND status = 'starting' AND dispatch_owner = ?`,
        )
        .run(Date.now(), conversationId, this.ownerId);
    }
    return this.getChild(conversationId)!;
  }

  async cancelChild(conversationId: string, actorConversationId: string): Promise<ChildLink> {
    const child = this.getChild(conversationId);
    if (!child) throw new Error('Unknown child');
    if (actorConversationId !== child.parentConversationId)
      throw new Error('Child cancellation authority denied');
    if (child.status === 'completed' || child.status === 'cancelled') return child;
    this.setStatus(conversationId, child.status === 'allocated' ? 'cancelled' : 'cancel_requested');
    if (child.status !== 'allocated') return this.reconcile(conversationId);
    return this.getChild(conversationId)!;
  }

  submitResult(conversationId: string, actorConversationId: string, payload: string): void {
    const child = this.getChild(conversationId);
    if (!child) throw new Error('Unknown child');
    if (actorConversationId !== conversationId) throw new Error('Result authority denied');
    if (child.status !== 'running') throw new Error('Child is cancelled or not running');
    this.db
      .transaction(() => {
        this.db
          .prepare('INSERT INTO child_mailbox(child_id,type,payload,created_at) VALUES (?,?,?,?)')
          .run(conversationId, 'result', payload, Date.now());
        this.setStatus(conversationId, 'completed');
      })
      .immediate();
  }

  readMailbox(
    conversationId: string,
    actorConversationId: string,
  ): Array<{ seq: number; type: string; payload: string; createdAt: number }> {
    const child = this.getChild(conversationId);
    if (!child) throw new Error('Unknown child');
    if (
      actorConversationId !== child.parentConversationId &&
      actorConversationId !== conversationId
    )
      throw new Error('Mailbox authority denied');
    return (
      this.db
        .prepare('SELECT * FROM child_mailbox WHERE child_id = ? ORDER BY seq')
        .all(conversationId) as MailRow[]
    ).map((row) => ({
      seq: row.seq,
      type: row.type,
      payload: row.payload,
      createdAt: row.created_at,
    }));
  }
}

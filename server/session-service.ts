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
  grantRevision: number;
  accountBinding: AccountBinding;
  reasoningEffort: string | null;
  scope: { files: string[]; capabilities: string[] };
  isolation: 'independent' | 'symposium_shared';
}

/** Constructed by the host after authenticating the caller and resolving its
 * current grant. Never construct this from model-supplied tool arguments. */
export interface ChildAuthority {
  parentConversationId: string;
  parentActive: boolean;
  grantId: string;
  grantRevision: number;
  accountBinding: AccountBinding;
  reasoningEffort: string | null;
  taskRootId: string;
  taskNodeId?: string;
  planRevision?: string;
  allowedFiles: readonly string[];
  allowedCapabilities: readonly string[];
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
  generation: number;
  cancellationRequested: boolean;
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
  authority_json: string;
  depth: number;
  status: ChildStatus;
  generation: number;
  cancel_requested_at: number | null;
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
  if (request.inputHash !== childInputHash(request)) throw new Error('Child input hash mismatch');
  if (request.taskNodeId && !request.taskRootId) throw new Error('Task node needs a task root');
  if (!Number.isSafeInteger(request.grantRevision) || request.grantRevision < 1)
    throw new Error('Invalid grant revision');
  if (
    !request.scope ||
    !Array.isArray(request.scope.files) ||
    !Array.isArray(request.scope.capabilities)
  )
    throw new Error('Invalid child scope');
  AccountBindingSchema.parse(request.accountBinding);
  if (!['independent', 'symposium_shared'].includes(request.isolation))
    throw new Error('Invalid isolation');
}

export function childInputHash(request: Omit<ChildCreateRequest, 'inputHash'>): string {
  const input = {
    parentConversationId: request.parentConversationId,
    prompt: request.prompt,
    taskRootId: request.taskRootId ?? null,
    taskNodeId: request.taskNodeId ?? null,
    planRevision: request.planRevision ?? null,
    grantId: request.grantId,
    grantRevision: request.grantRevision,
    accountBinding: AccountBindingSchema.parse(request.accountBinding),
    reasoningEffort: request.reasoningEffort,
    scope: request.scope,
    isolation: request.isolation,
  };
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
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
    grantRevision: request.grantRevision,
    accountBinding: AccountBindingSchema.parse(request.accountBinding),
    reasoningEffort: request.reasoningEffort,
    scope: request.scope,
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
    generation: row.generation,
    cancellationRequested: row.cancel_requested_at !== null,
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
    private resolveCurrentAuthority: (child: ChildLink) => Promise<ChildAuthority | null>,
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
        authority_json TEXT NOT NULL,
        depth INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN
          ('allocated','starting','running','recovery_required','cancel_requested','cancelled','completed')),
        generation INTEGER NOT NULL DEFAULT 1,
        cancel_requested_at INTEGER,
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
    if (!authority.parentActive) throw new Error('Parent is not active');
    if (request.grantId !== authority.grantId || request.grantRevision !== authority.grantRevision)
      throw new Error('Grant denied');
    if (
      JSON.stringify(request.accountBinding) !== JSON.stringify(authority.accountBinding) ||
      request.reasoningEffort !== authority.reasoningEffort
    )
      throw new Error('Account binding or reasoning effort exceeds parent authority');
    if (
      request.taskRootId !== authority.taskRootId ||
      (authority.taskNodeId && request.taskNodeId !== authority.taskNodeId) ||
      request.planRevision !== authority.planRevision
    )
      throw new Error('Task scope exceeds parent authority');
    if (
      request.scope.files.some((file) => !authority.allowedFiles.includes(file)) ||
      request.scope.capabilities.some(
        (capability) => !authority.allowedCapabilities.includes(capability),
      )
    )
      throw new Error('Child scope exceeds parent authority');
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
          if (
            inherited.grantId !== request.grantId ||
            inherited.grantRevision !== request.grantRevision
          )
            throw new Error('Grant exceeds parent scope');
          if (
            request.scope.files.some((file) => !inherited.scope.files.includes(file)) ||
            request.scope.capabilities.some(
              (capability) => !inherited.scope.capabilities.includes(capability),
            )
          )
            throw new Error('Child scope exceeds parent scope');
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
        (session_id, mode, account_binding, selected_model, reasoning_effort,
         initial_prompt, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            conversationId,
            'agent',
            JSON.stringify(request.accountBinding),
            request.accountBinding.model,
            request.reasoningEffort,
            request.prompt,
            now,
            now,
          );
        this.db
          .prepare(
            `INSERT INTO child_allocations
        (conversation_id,parent_conversation_id,idempotency_key,request_hash,request_json,authority_json,
         depth,status,generation,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            conversationId,
            request.parentConversationId,
            request.idempotencyKey,
            fingerprint,
            JSON.stringify(request),
            JSON.stringify(authority),
            depth,
            'allocated',
            1,
            now,
            now,
          );
        return this.getChild(conversationId)!;
      })
      .immediate();
  }

  private casStatus(
    id: string,
    generation: number,
    from: readonly ChildStatus[],
    to: ChildStatus,
    cancellation: 'none' | 'required' = 'none',
  ): boolean {
    const statuses = from.map(() => '?').join(',');
    const condition =
      cancellation === 'none' ? 'cancel_requested_at IS NULL' : 'cancel_requested_at IS NOT NULL';
    return (
      this.db
        .prepare(
          `UPDATE child_allocations SET status = ?, updated_at = ?
      WHERE conversation_id = ? AND generation = ? AND status IN (${statuses}) AND ${condition}`,
        )
        .run(to, Date.now(), id, generation, ...from).changes === 1
    );
  }

  private requestCancellation(conversationId: string, actorConversationId: string): ChildLink {
    return this.db
      .transaction(() => {
        const child = this.getChild(conversationId);
        if (!child) throw new Error('Unknown child');
        if (actorConversationId !== child.parentConversationId)
          throw new Error('Child cancellation authority denied');
        if (
          child.status === 'completed' ||
          child.status === 'cancelled' ||
          child.cancellationRequested
        )
          return child;
        this.db
          .prepare(
            `UPDATE child_allocations SET
        status = CASE WHEN status = 'allocated' THEN 'cancelled' ELSE 'cancel_requested' END,
        cancel_requested_at = ?, generation = generation + 1, updated_at = ?
        WHERE conversation_id = ? AND generation = ? AND cancel_requested_at IS NULL`,
          )
          .run(Date.now(), Date.now(), conversationId, child.generation);
        return this.getChild(conversationId)!;
      })
      .immediate();
  }

  private async authorityStillCurrent(child: ChildLink): Promise<boolean> {
    const snapshot = this.db
      .prepare('SELECT authority_json FROM child_allocations WHERE conversation_id = ?')
      .get(child.conversationId) as { authority_json: string };
    const current = await this.resolveCurrentAuthority(child);
    return Boolean(current?.parentActive && JSON.stringify(current) === snapshot.authority_json);
  }

  /** Inspect before dispatching the pending start. An uncertain observation is
   * fenced; it never mints another provider attempt. */
  async reconcile(conversationId: string): Promise<ChildLink> {
    let child = this.getChild(conversationId);
    if (!child) throw new Error('Unknown child');
    if (child.cancellationRequested && child.status !== 'cancelled') {
      const stopped = await this.runtime.stop(conversationId);
      this.casStatus(
        conversationId,
        child.generation,
        ['cancel_requested', 'recovery_required', 'starting', 'running'],
        stopped === 'confirmed' ? 'cancelled' : 'recovery_required',
        'required',
      );
      return this.getChild(conversationId)!;
    }
    if (
      child.status === 'cancelled' ||
      child.status === 'completed' ||
      child.status === 'recovery_required'
    )
      return child;
    if (!(await this.authorityStillCurrent(child))) {
      child = this.requestCancellation(conversationId, child.parentConversationId);
      return child.status === 'cancelled' ? child : this.reconcile(conversationId);
    }
    const observed = await this.runtime.inspect(conversationId);
    const latest = this.getChild(conversationId)!;
    if (latest.cancellationRequested && latest.status !== 'cancelled')
      return this.reconcile(conversationId);
    if (
      latest.generation !== child.generation ||
      latest.status === 'cancelled' ||
      latest.status === 'completed' ||
      latest.status === 'recovery_required'
    )
      return latest;
    if (!(await this.authorityStillCurrent(latest))) {
      child = this.requestCancellation(conversationId, latest.parentConversationId);
      return child.status === 'cancelled' ? child : this.reconcile(conversationId);
    }
    if (observed === 'unknown')
      this.casStatus(
        conversationId,
        child.generation,
        ['allocated', 'starting', 'running'],
        'recovery_required',
      );
    else if (observed === 'completed')
      this.casStatus(
        conversationId,
        child.generation,
        ['allocated', 'starting', 'running'],
        'completed',
      );
    else if (observed === 'running')
      this.casStatus(
        conversationId,
        child.generation,
        ['allocated', 'starting', 'running'],
        'running',
      );
    else if (latest.status === 'running')
      this.casStatus(conversationId, child.generation, ['running'], 'recovery_required');
    else if (latest.status === 'starting') {
      const lease = this.db
        .prepare('SELECT dispatch_lease_until FROM child_allocations WHERE conversation_id = ?')
        .get(conversationId) as { dispatch_lease_until: number | null };
      if (lease.dispatch_lease_until !== null && lease.dispatch_lease_until < Date.now())
        this.casStatus(conversationId, child.generation, ['starting'], 'recovery_required');
    } else {
      const now = Date.now();
      const claimed = this.db
        .prepare(
          `UPDATE child_allocations
        SET status = 'starting', dispatch_owner = ?, dispatch_lease_until = ?, updated_at = ?
        WHERE conversation_id = ? AND generation = ? AND status = 'allocated'
          AND cancel_requested_at IS NULL`,
        )
        .run(this.ownerId, now + 30_000, now, conversationId, child.generation);
      if (claimed.changes !== 1) return this.getChild(conversationId)!;
      try {
        await this.runtime.start(this.getChild(conversationId)!);
      } catch {
        this.casStatus(conversationId, child.generation, ['starting'], 'recovery_required');
        return this.getChild(conversationId)!;
      }
      const after = this.getChild(conversationId)!;
      if (after.cancellationRequested) {
        // A stop may have raced ahead of a late runtime attachment. Repeat
        // cleanup after start resolves; an unknown stop remains fenced.
        const stopped = await this.runtime.stop(conversationId);
        this.casStatus(
          conversationId,
          after.generation,
          ['cancel_requested', 'recovery_required', 'cancelled'],
          stopped === 'confirmed' ? 'cancelled' : 'recovery_required',
          'required',
        );
        return this.getChild(conversationId)!;
      }
      if (!(await this.authorityStillCurrent(after))) {
        this.requestCancellation(conversationId, after.parentConversationId);
        return this.reconcile(conversationId);
      }
      this.db
        .prepare(
          `UPDATE child_allocations SET status = 'running', updated_at = ?
        WHERE conversation_id = ? AND generation = ? AND status = 'starting'
          AND dispatch_owner = ? AND cancel_requested_at IS NULL`,
        )
        .run(Date.now(), conversationId, child.generation, this.ownerId);
    }
    return this.getChild(conversationId)!;
  }

  async cancelChild(conversationId: string, actorConversationId: string): Promise<ChildLink> {
    const child = this.requestCancellation(conversationId, actorConversationId);
    return child.status === 'cancelled' || child.status === 'completed'
      ? child
      : this.reconcile(conversationId);
  }

  submitResult(
    conversationId: string,
    actorConversationId: string,
    expectedGeneration: number,
    payload: string,
  ): void {
    this.db
      .transaction(() => {
        const child = this.getChild(conversationId);
        if (!child) throw new Error('Unknown child');
        if (actorConversationId !== conversationId) throw new Error('Result authority denied');
        if (
          child.generation !== expectedGeneration ||
          child.cancellationRequested ||
          child.status !== 'running'
        )
          throw new Error('Child is cancelled or fenced');
        this.db
          .prepare('INSERT INTO child_mailbox(child_id,type,payload,created_at) VALUES (?,?,?,?)')
          .run(conversationId, 'result', payload, Date.now());
        if (!this.casStatus(conversationId, expectedGeneration, ['running'], 'completed'))
          throw new Error('Child result fence changed');
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

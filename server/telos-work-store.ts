import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  TelosWorkCommandSchema,
  TelosSourceConversationReferenceSchema,
  TelosWorkAttemptSchema,
  TelosWorkViewSchema,
  type TelosWorkCommand,
  type TelosWorkCommandReceipt,
  type TelosWorkView,
  type TelosWorkSessionLink,
  type TelosWorkAssignment,
  type TelosWorkSourceSnapshot,
  type TelosWorkAttempt,
  type TelosWorkItem,
} from '@mitzo/protocol';
import { initializeTelosWorkSchema } from './telos-work-schema.js';
import { projectTelosWorkRecord } from './telos-work-record.js';

/** Authority is supplied by host middleware, never accepted in command JSON.
 * Conversations can read only items to which they are explicitly linked. S4/S5
 * will bind scoped delegation capabilities; linking itself grants no mutation.
 */
export type TelosWorkActor = { kind: 'operator' | 'conversation'; id: string };
type Conversation = TelosWorkSessionLink['conversation'];
interface Item {
  id: string;
  parent_id: string | null;
  [key: string]: unknown;
}
interface JsonRow {
  data: string;
}
export class TelosWorkError extends Error {
  constructor(
    readonly code: 'not_found' | 'unauthorized' | 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = (message: string): never => {
  throw new TelosWorkError('conflict', message);
};
const invalid = (message: string): never => {
  throw new TelosWorkError('invalid', message);
};

/** Extends the canonical Telos database, not session allocation or composition.
 * parent_id stays on items. No event/session/task store write occurs here.
 * Command results and allocation intents commit in the same SQLite transaction.
 */
export class TelosWorkStore {
  private db: Database.Database;
  constructor(
    path: string,
    private readonly policy: { ordinaryConversation(id: string): boolean },
  ) {
    this.db = new Database(path, { fileMustExist: true });
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    try {
      this.db.prepare('SELECT id,parent_id,updated_at FROM items LIMIT 1').get();
      initializeTelosWorkSchema(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    if (this.db.open) this.db.close();
  }
  private item(id: string): Item {
    const item = this.db.prepare('SELECT * FROM items WHERE id=?').get(id) as Item | undefined;
    if (!item) throw new TelosWorkError('not_found', 'Telos work item not found');
    return item;
  }
  private operator(actor: TelosWorkActor) {
    if (actor.kind !== 'operator' || !actor.id.trim())
      throw new TelosWorkError(
        'unauthorized',
        'Operator authority required; conversation is not authorized',
      );
  }
  private authorizeRead(itemId: string, actor: TelosWorkActor) {
    if (actor.kind === 'operator' && actor.id.trim()) return;
    if (
      actor.kind === 'conversation' &&
      this.policy.ordinaryConversation(actor.id) &&
      this.db
        .prepare(
          "SELECT 1 FROM telos_work_links WHERE item_id=? AND namespace='mitzo' AND conversation_id=?",
        )
        .get(itemId, actor.id)
    )
      return;
    throw new TelosWorkError('unauthorized', 'Conversation is not authorized for this work item');
  }
  private json<T>(sql: string, ...args: unknown[]): T[] {
    return (this.db.prepare(sql).all(...args) as JsonRow[]).map((row) => JSON.parse(row.data) as T);
  }
  private currentAvailability(link: TelosWorkSessionLink): TelosWorkSessionLink {
    return {
      ...link,
      availability:
        link.conversation.namespace === 'mitzo'
          ? this.policy.ordinaryConversation(link.conversation.conversationId)
            ? 'available'
            : 'unavailable'
          : link.availability,
    };
  }
  private snapshot(itemId: string): TelosWorkView {
    const row = this.item(itemId);
    const kind =
      (
        this.db.prepare('SELECT kind FROM telos_work_kinds WHERE item_id=?').get(itemId) as
          { kind: TelosWorkView['kind'] } | undefined
      )?.kind ?? null;
    const links = this.json<TelosWorkSessionLink>(
      'SELECT data FROM telos_work_links WHERE item_id=? ORDER BY seq',
      itemId,
    ).map((link) => this.currentAvailability(link));
    const assignments = this.json<TelosWorkAssignment>(
      'SELECT data FROM telos_work_assignments WHERE item_id=? ORDER BY role',
      itemId,
    );
    const sources = this.json<TelosWorkSourceSnapshot>(
      'SELECT data FROM telos_work_sources WHERE item_id=? ORDER BY seq',
      itemId,
    );
    const attempts = this.json<TelosWorkAttempt>(
      'SELECT data FROM telos_work_attempts WHERE item_id=? ORDER BY seq',
      itemId,
    );
    const facts = { itemId, kind, parentId: row.parent_id, links, assignments, sources, attempts };
    return TelosWorkViewSchema.parse({ ...facts, revision: hash([row, facts]) });
  }
  read(itemId: string, actor: TelosWorkActor): TelosWorkView {
    return this.db.transaction(() => {
      this.authorizeRead(itemId, actor);
      return this.snapshot(itemId);
    })();
  }
  /** The original brief and evidence stay in the canonical tables. This read
   * shares the relationship store's exact-item authority and transaction.
   */
  readRecord(itemId: string, actor: TelosWorkActor): TelosWorkItem {
    return this.db.transaction(() => {
      this.authorizeRead(itemId, actor);
      const item = this.item(itemId);
      const kind = this.db
        .prepare('SELECT kind FROM telos_work_kinds WHERE item_id=?')
        .get(itemId) as { kind: TelosWorkItem['kind'] } | undefined;
      const rows = (table: 'sources' | 'links') =>
        this.db
          .prepare(`SELECT * FROM ${table} WHERE item_id=? ORDER BY rowid`)
          .all(itemId) as Record<string, unknown>[];
      try {
        return projectTelosWorkRecord(item, rows('sources'), rows('links'), kind?.kind ?? null);
      } catch (cause) {
        // Invalid stored data is an unavailable read, not invalid operator input.
        throw new Error('Stored Telos record unavailable', { cause });
      }
    })();
  }
  forConversation(input: unknown, actor: TelosWorkActor): TelosWorkSessionLink[] {
    const ref = TelosSourceConversationReferenceSchema.parse(input);
    if (
      actor.kind !== 'operator' &&
      (ref.namespace !== 'mitzo' ||
        actor.id !== ref.conversationId ||
        !this.policy.ordinaryConversation(actor.id))
    )
      throw new TelosWorkError('unauthorized', 'Conversation is not authorized');
    return this.json<TelosWorkSessionLink>(
      'SELECT data FROM telos_work_links WHERE namespace=? AND conversation_id=? ORDER BY seq',
      ref.namespace,
      ref.conversationId,
    ).map((link) => this.currentAvailability(link));
  }
  assignmentHistory(itemId: string, actor: TelosWorkActor): TelosWorkAssignment[] {
    this.authorizeRead(itemId, actor);
    return this.json(
      'SELECT data FROM telos_work_assignment_history WHERE item_id=? ORDER BY seq',
      itemId,
    );
  }
  execute(raw: unknown, actor: TelosWorkActor): TelosWorkCommandReceipt {
    this.operator(actor);
    const input = TelosWorkCommandSchema.parse(raw);
    return this.db
      .transaction(() => {
        const actorId = `${actor.kind}:${actor.id}`,
          fingerprint = hash(input);
        const saved = this.db
          .prepare(
            'SELECT fingerprint,receipt FROM telos_work_commands WHERE actor_id=? AND request_id=?',
          )
          .get(actorId, input.requestId) as { fingerprint: string; receipt: string } | undefined;
        if (saved) {
          if (saved.fingerprint !== fingerprint)
            conflict('Command identity reused with different input');
          return JSON.parse(saved.receipt) as TelosWorkCommandReceipt;
        }
        if (this.snapshot(input.itemId).revision !== input.expectedRevision)
          conflict('Work revision conflict; read current work before retrying');
        this.apply(input, actorId);
        const result = { commandId: randomUUID(), actorId, work: this.snapshot(input.itemId) };
        this.db
          .prepare(
            'INSERT INTO telos_work_commands(actor_id,request_id,fingerprint,receipt) VALUES(?,?,?,?)',
          )
          .run(actorId, input.requestId, fingerprint, JSON.stringify(result));
        return result;
      })
      .immediate();
  }
  private addLink(
    itemId: string,
    role: TelosWorkSessionLink['role'],
    conversation: Conversation,
    actorId: string,
    attemptId: string | null = null,
  ) {
    if (
      role !== 'origin' &&
      (conversation.namespace !== 'mitzo' ||
        !this.policy.ordinaryConversation(conversation.conversationId))
    )
      invalid('A registered ordinary Mitzo conversation is required');
    const existing = this.db
      .prepare(
        'SELECT data FROM telos_work_links WHERE item_id=? AND role=? AND namespace=? AND conversation_id=?',
      )
      .get(itemId, role, conversation.namespace, conversation.conversationId) as
      JsonRow | undefined;
    if (existing) return;
    const link = {
      version: 1,
      linkId: randomUUID(),
      itemId,
      role,
      conversation,
      linkedAt: new Date().toISOString(),
      linkedBy: actorId,
      availability:
        conversation.namespace === 'mitzo'
          ? this.policy.ordinaryConversation(conversation.conversationId)
            ? 'available'
            : 'unavailable'
          : 'unknown',
      attemptId,
    };
    this.db
      .prepare(
        'INSERT INTO telos_work_links(item_id,role,namespace,conversation_id,data) VALUES(?,?,?,?,?)',
      )
      .run(itemId, role, conversation.namespace, conversation.conversationId, JSON.stringify(link));
  }
  private apply(input: TelosWorkCommand, actorId: string) {
    switch (input.operation) {
      case 'classify':
        this.db
          .prepare(
            'INSERT INTO telos_work_kinds(item_id,kind) VALUES(?,?) ON CONFLICT(item_id) DO UPDATE SET kind=excluded.kind',
          )
          .run(input.itemId, input.kind);
        break;
      case 'reparent':
        if (input.parentId !== null) this.item(input.parentId);
        this.db
          .prepare('UPDATE items SET parent_id=?,updated_at=? WHERE id=?')
          .run(input.parentId, new Date().toISOString(), input.itemId);
        break;
      case 'link':
        this.addLink(input.itemId, input.role, input.conversation, actorId);
        break;
      case 'assign': {
        if (!this.policy.ordinaryConversation(input.conversationId))
          invalid('A registered ordinary Mitzo conversation is required');
        if (
          !this.db
            .prepare(
              "SELECT 1 FROM telos_work_links WHERE item_id=? AND role=? AND namespace='mitzo' AND conversation_id=?",
            )
            .get(input.itemId, input.role, input.conversationId)
        )
          invalid('Assignment requires an explicit matching role link');
        const current = this.json<TelosWorkAssignment>(
          'SELECT data FROM telos_work_assignments WHERE item_id=? AND role=?',
          input.itemId,
          input.role,
        )[0];
        if ((current?.revision ?? 0) !== input.expectedAssignmentRevision)
          conflict('Assignment revision conflict');
        const assignment: TelosWorkAssignment = {
          itemId: input.itemId,
          role: input.role,
          conversation: { namespace: 'mitzo', conversationId: input.conversationId },
          revision: input.expectedAssignmentRevision + 1,
          assignedAt: new Date().toISOString(),
          assignedBy: actorId,
        };
        const data = JSON.stringify(assignment);
        this.db
          .prepare(
            'INSERT INTO telos_work_assignments(item_id,role,data) VALUES(?,?,?) ON CONFLICT(item_id,role) DO UPDATE SET data=excluded.data',
          )
          .run(input.itemId, input.role, data);
        this.db
          .prepare('INSERT INTO telos_work_assignment_history(item_id,data) VALUES(?,?)')
          .run(input.itemId, data);
        break;
      }
      case 'source': {
        if (input.snapshot.itemId !== input.itemId) invalid('Source snapshot item mismatch');
        const data = JSON.stringify(input.snapshot);
        const existing = this.db
          .prepare('SELECT data FROM telos_work_sources WHERE snapshot_id=?')
          .get(input.snapshot.snapshotId) as JsonRow | undefined;
        if (existing) {
          if (existing.data !== data) conflict('Source snapshot is immutable');
        } else {
          this.db
            .prepare('INSERT INTO telos_work_sources(snapshot_id,item_id,data) VALUES(?,?,?)')
            .run(input.snapshot.snapshotId, input.itemId, data);
        }
        // The source and its backlink are one adoption. This records provenance;
        // it never selects a lead, assigns a worker or requests an allocation.
        if (input.snapshot.source)
          this.addLink(input.itemId, 'origin', input.snapshot.source, actorId);
        break;
      }
      case 'request_attempt':
        this.requestAttempt(input, actorId);
        break;
    }
  }
  private requestAttempt(
    input: Extract<TelosWorkCommand, { operation: 'request_attempt' }>,
    actorId: string,
  ) {
    const child = this.item(input.itemId);
    if (!child.parent_id) invalid('Delegation requires an exact child item');
    const lead = this.json<TelosWorkAssignment>(
      "SELECT data FROM telos_work_assignments WHERE item_id=? AND role='lead'",
      child.parent_id,
    )[0];
    if (
      lead?.conversation.conversationId !== input.leadConversationId ||
      !this.policy.ordinaryConversation(input.leadConversationId)
    )
      invalid('Delegation requires the current parent lead');
    if (
      !this.db
        .prepare('SELECT 1 FROM telos_work_sources WHERE snapshot_id=? AND item_id=?')
        .get(input.contextSnapshotId, input.itemId)
    )
      invalid('Exact child context snapshot required');
    if (
      this.db.prepare('SELECT 1 FROM telos_work_attempts WHERE attempt_id=?').get(input.attemptId)
    )
      conflict('Attempt identity conflict');
    const previous = this.db
      .prepare(
        'SELECT attempt_id FROM telos_work_attempts WHERE item_id=? ORDER BY seq DESC LIMIT 1',
      )
      .get(input.itemId) as { attempt_id: string } | undefined;
    if ((previous?.attempt_id ?? null) !== input.predecessorAttemptId)
      conflict('Retry predecessor conflict');
    const attempt: TelosWorkAttempt = {
      version: 1,
      requestId: input.requestId,
      attemptId: input.attemptId,
      predecessorAttemptId: input.predecessorAttemptId,
      leadConversationId: input.leadConversationId,
      childItemId: input.itemId,
      contextSnapshotId: input.contextSnapshotId,
      state: 'requested',
      workerConversationId: null,
      allocationReceiptId: null,
      executionTaskId: null,
      accountingGoalId: null,
      turnCommandId: null,
    };
    this.db
      .prepare('INSERT INTO telos_work_attempts(attempt_id,item_id,data) VALUES(?,?,?)')
      .run(input.attemptId, input.itemId, JSON.stringify(attempt));
    this.db
      .prepare(
        'INSERT INTO telos_work_allocation_outbox(attempt_id,actor_id,configuration,allocation_key,state) VALUES(?,?,?,?,?)',
      )
      .run(
        input.attemptId,
        actorId,
        JSON.stringify(input.configuration),
        input.attemptId,
        'requested',
      );
  }
  pendingAllocations(actor: TelosWorkActor) {
    this.operator(actor);
    return (
      this.db
        .prepare(
          "SELECT o.attempt_id,o.configuration,o.allocation_key,o.state,a.data FROM telos_work_allocation_outbox o JOIN telos_work_attempts a ON a.attempt_id=o.attempt_id WHERE o.state!='recorded' ORDER BY a.seq",
        )
        .all() as Array<{
        attempt_id: string;
        data: string;
        configuration: string;
        allocation_key: string;
        state: string;
      }>
    ).map((row) => ({
      attemptId: row.attempt_id,
      attempt: TelosWorkAttemptSchema.parse(JSON.parse(row.data)),
      configuration: JSON.parse(row.configuration) as Extract<
        TelosWorkCommand,
        { operation: 'request_attempt' }
      >['configuration'],
      allocationKey: row.allocation_key,
      state: row.state,
    }));
  }
  /** Host-only reconciliation seam. Caller verifies the ordinary allocator's
   * retained receipt for this exact allocation key/session. No HTTP equivalent.
   * Does not dispatch a turn or change the current worker assignment.
   */
  recordAllocation(
    attemptId: string,
    allocation: { workerConversationId: string; allocationReceiptId: string },
    verify: (evidence: {
      allocationKey: string;
      workerConversationId: string;
      allocationReceiptId: string;
    }) => boolean,
  ) {
    return this.db
      .transaction(() => {
        const row = this.json<TelosWorkAttempt>(
          'SELECT data FROM telos_work_attempts WHERE attempt_id=?',
          attemptId,
        )[0];
        if (!row) throw new TelosWorkError('not_found', 'Attempt not found');
        if (allocation.workerConversationId === row.leadConversationId)
          invalid('Lead conversation cannot be its delegated worker');
        if (row.state === 'chat_ready') {
          if (
            row.workerConversationId !== allocation.workerConversationId ||
            row.allocationReceiptId !== allocation.allocationReceiptId
          )
            conflict('Allocation receipt conflict');
          return row;
        }
        if (
          !this.policy.ordinaryConversation(allocation.workerConversationId) ||
          !verify({ allocationKey: attemptId, ...allocation })
        )
          invalid('Verified ordinary allocation receipt required');
        const attempt = TelosWorkAttemptSchema.parse({
          ...row,
          ...allocation,
          state: 'chat_ready',
        });
        const outbox = this.db
          .prepare('SELECT actor_id FROM telos_work_allocation_outbox WHERE attempt_id=?')
          .get(attemptId) as { actor_id: string };
        this.addLink(
          row.childItemId,
          'worker',
          { namespace: 'mitzo', conversationId: allocation.workerConversationId },
          outbox.actor_id,
          attemptId,
        );
        this.db
          .prepare('UPDATE telos_work_attempts SET data=? WHERE attempt_id=?')
          .run(JSON.stringify(attempt), attemptId);
        this.db
          .prepare("UPDATE telos_work_allocation_outbox SET state='recorded' WHERE attempt_id=?")
          .run(attemptId);
        return attempt;
      })
      .immediate();
  }
}

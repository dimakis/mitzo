import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  TelosWorkCommandSchema,
  TelosSourceConversationReferenceSchema,
  TelosWorkAttemptSchema,
  TelosWorkViewSchema,
  TelosSourcePacketSchema,
  TelosWorkCommandReceiptSchema,
  TelosOutcomeContextHintsSchema,
  TelosWorkRoleSetupInputSchema,
  type TelosWorkRoleSetupIntent,
  type TelosWorkRoleSetupRecovery,
  TelosWorkRoleContextReviewSchema,
  type TelosWorkRoleContextReview,
  TelosWorkRolePresentationRefSchema,
  type TelosWorkRolePresentationRef,
  type TelosWorkRolePresentation,
  type TelosWorkRoleSetupInput,
  TelosWorkAdvisorDraftSaveRequestSchema,
  TelosWorkSourceSnapshotSchema,
  type TelosWorkCommand,
  type TelosWorkCommandReceipt,
  type TelosWorkView,
  type TelosWorkSessionLink,
  type TelosWorkAssignment,
  type TelosWorkSourceSnapshot,
  type TelosWorkAttempt,
  type TelosWorkItem,
  type TelosSourcePacket,
  TelosWorkDelegationInputSchema,
  TelosWorkDelegationReceiptSchema,
  type TelosWorkDelegationIntent,
  type TelosWorkDelegationReceipt,
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
interface SourceCreationRow {
  input_hash: string;
  packet: string;
  idempotency_key: string;
  item_id: string | null;
  item_revision: string | null;
  receipt: string | null;
}
export class TelosWorkError extends Error {
  constructor(
    readonly code: 'not_found' | 'unauthorized' | 'conflict' | 'invalid',
    message: string,
    readonly recovery?: TelosWorkRoleSetupRecovery,
  ) {
    super(message);
  }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function conflict(message: string): never {
  throw new TelosWorkError('conflict', message);
}
function invalid(message: string): never {
  throw new TelosWorkError('invalid', message);
}

/** Extends the canonical Telos database, not session allocation or composition.
 * parent_id stays on items. No event/session/task store write occurs here.
 * Command results and allocation intents commit in the same SQLite transaction.
 */
export class TelosWorkStore {
  private db: Database.Database;
  constructor(
    path: string,
    private readonly policy: {
      ordinaryConversation(id: string): boolean;
      sourceConversation?(id: string): boolean;
    },
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
  /** Internal operator-only advisor save port. Receipt identity shares the
   * existing command owner; no conversation capability or dispatch is granted. */
  advisorDraftReceipt(raw: unknown, actor: TelosWorkActor): TelosWorkCommandReceipt | undefined {
    this.operator(actor);
    const input = TelosWorkAdvisorDraftSaveRequestSchema.parse(raw);
    const saved = this.db
      .prepare(
        'SELECT fingerprint,receipt FROM telos_work_commands WHERE actor_id=? AND request_id=?',
      )
      .get(`operator:${actor.id}`, `advisor:${input.requestId}`) as
      { fingerprint: string; receipt: string } | undefined;
    if (!saved) return undefined;
    if (saved.fingerprint !== hash(input))
      conflict('Advisor request identity reused with different input');
    return TelosWorkCommandReceiptSchema.parse(JSON.parse(saved.receipt));
  }
  saveAdvisorDraft(
    raw: unknown,
    actor: TelosWorkActor,
    retainSource: (database: Database.Database, itemId: string) => TelosWorkSourceSnapshot,
    assertBeforeApply: () => void,
  ): TelosWorkCommandReceipt {
    this.operator(actor);
    const input = TelosWorkAdvisorDraftSaveRequestSchema.parse(raw);
    return this.db
      .transaction(() => {
        const previous = this.advisorDraftReceipt(input, actor);
        if (previous) return previous;
        const anchor = this.readSourceTarget(input.itemId, actor);
        if (input.operation === 'refine' && anchor.work.kind !== input.proposed.type)
          invalid('Refinement cannot change item type');
        if (anchor.work.revision !== input.expectedRevision)
          conflict('Advisor item revision conflict');
        if (input.operation === 'refine' && anchor.record.parentId !== input.parentId)
          conflict('Advisor parent scope changed');
        if (
          input.parentId !== null &&
          this.snapshot(input.parentId).revision !== input.expectedParentRevision
        )
          conflict('Advisor parent revision conflict');
        if (/^life[-_ ]?ops$/i.test(anchor.record.profile))
          invalid('This item requires private case storage');
        assertBeforeApply();
        const actorId = `operator:${actor.id}`;
        const itemId =
          input.operation === 'refine'
            ? input.itemId
            : hash(['advisor-child', actorId, input.requestId]).slice(0, 16);
        const now = new Date().toISOString();
        if (input.operation === 'child') {
          this.db
            .prepare(
              'INSERT INTO items(id,parent_id,summary,intent,rationale,acceptance_criteria,profile,status,starred,context_hints,categories,first_seen,last_seen,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            )
            .run(
              itemId,
              input.parentId,
              input.proposed.name,
              input.proposed.desiredOutcome,
              '',
              '[]',
              anchor.record.profile,
              'active',
              0,
              JSON.stringify({ session_ids: [input.advisorConversationId] }),
              JSON.stringify([input.proposed.category]),
              now,
              now,
              now,
              now,
            );
          this.db
            .prepare(
              "INSERT INTO history(item_id,old_status,new_status,changed_at) VALUES(?,NULL,'active',?)",
            )
            .run(itemId, now);
        } else {
          const categories = [
            ...new Set([input.proposed.category, ...anchor.record.categories.slice(1)]),
          ];
          this.db
            .prepare('UPDATE items SET summary=?,intent=?,categories=?,updated_at=? WHERE id=?')
            .run(
              input.proposed.name,
              input.proposed.desiredOutcome,
              JSON.stringify(categories),
              now,
              itemId,
            );
        }
        this.apply(
          {
            operation: 'classify',
            itemId,
            requestId: `advisor-kind:${input.requestId}`,
            expectedRevision: this.snapshot(itemId).revision,
            kind: input.proposed.type,
          },
          actorId,
        );
        const snapshot = TelosWorkSourceSnapshotSchema.parse(retainSource(this.db, itemId));
        if (
          snapshot.itemId !== itemId ||
          snapshot.source?.namespace !== 'mitzo' ||
          snapshot.source.conversationId !== input.advisorConversationId ||
          snapshot.selection.kind !== 'selected' ||
          snapshot.selection.throughSequence !== input.selection.boundary.sequence
        )
          invalid('Advisor draft requires its exact reviewed planning source');
        assertBeforeApply();
        this.apply(
          {
            operation: 'source',
            itemId,
            requestId: `advisor-source:${input.requestId}`,
            expectedRevision: this.snapshot(itemId).revision,
            snapshot,
          },
          actorId,
        );
        const receipt = { commandId: randomUUID(), actorId, work: this.snapshot(itemId) };
        this.db
          .prepare(
            'INSERT INTO telos_work_commands(actor_id,request_id,fingerprint,receipt) VALUES(?,?,?,?)',
          )
          .run(actorId, `advisor:${input.requestId}`, hash(input), JSON.stringify(receipt));
        return receipt;
      })
      .immediate();
  }
  /** One SQLite boundary captures names with their actual selected revisions. */
  reviewRolePresentation(
    actor: TelosWorkActor,
    produce: () => Pick<TelosWorkRoleContextReview, 'selection' | 'presentation'>,
  ): TelosWorkRoleContextReview {
    this.operator(actor);
    return this.retainRolePresentation(`operator:${actor.id}`, produce);
  }
  private retainRolePresentation(
    actorId: string,
    produce: () => Pick<TelosWorkRoleContextReview, 'selection' | 'presentation'>,
  ): TelosWorkRoleContextReview {
    return this.db
      .transaction(() => {
        const candidate = produce();
        const presentationRef = { id: randomUUID(), sha256: hash(candidate.presentation) };
        const reviewed = TelosWorkRoleContextReviewSchema.parse({
          version: 1,
          ...candidate,
          presentationRef,
        });
        if (
          reviewed.presentation.contextSha256 !== hash(reviewed.selection) ||
          presentationRef.sha256 !== hash(reviewed.presentation)
        )
          invalid('Reviewed presentation bytes changed');
        this.db
          .prepare(
            'INSERT INTO telos_work_role_presentations(id,actor_id,selection,presentation,sha256) VALUES(?,?,?,?,?)',
          )
          .run(
            presentationRef.id,
            actorId,
            JSON.stringify(reviewed.selection),
            JSON.stringify(reviewed.presentation),
            presentationRef.sha256,
          );
        return reviewed;
      })
      .immediate();
  }
  private readRolePresentation(
    raw: TelosWorkRolePresentationRef,
    actorId: string,
  ): TelosWorkRoleContextReview {
    const ref = TelosWorkRolePresentationRefSchema.parse(raw);
    const row = this.db
      .prepare('SELECT * FROM telos_work_role_presentations WHERE id=?')
      .get(ref.id) as
      { actor_id: string; selection: string; presentation: string; sha256: string } | undefined;
    if (!row) conflict('Reviewed presentation unavailable');
    if (row.actor_id !== actorId)
      throw new TelosWorkError('unauthorized', 'Original presentation owner required');
    if (row.sha256 !== ref.sha256) conflict('Reviewed presentation reference changed');
    const parsed = TelosWorkRoleContextReviewSchema.safeParse({
      version: 1,
      selection: JSON.parse(row.selection),
      presentation: JSON.parse(row.presentation),
      presentationRef: ref,
    });
    if (
      !parsed.success ||
      parsed.data.presentation.contextSha256 !== hash(parsed.data.selection) ||
      ref.sha256 !== hash(parsed.data.presentation)
    )
      throw new Error('Retained reviewed presentation unavailable');
    return parsed.data;
  }
  private qualifyRolePresentation(
    input: TelosWorkRoleSetupInput,
    actor: TelosWorkActor,
    raw: TelosWorkRolePresentationRef | null,
    hasOriginal: boolean,
  ) {
    const actorId = `operator:${actor.id}`;
    const fingerprint = hash(input);
    const saved = this.db
      .prepare('SELECT * FROM telos_work_role_setup_presentations WHERE request_id=?')
      .get(input.requestId) as
      | {
          actor_id: string;
          fingerprint: string;
          presentation_id: string;
          presentation_sha256: string;
        }
      | undefined;
    if (
      saved &&
      (saved.actor_id !== actorId ||
        saved.fingerprint !== fingerprint ||
        !raw ||
        raw.id !== saved.presentation_id ||
        raw.sha256 !== saved.presentation_sha256)
    )
      conflict('Original role presentation required for this request');
    if (!raw) return;
    const review = this.readRolePresentation(raw, `operator:${actor.id}`);
    if (JSON.stringify(review.selection) !== JSON.stringify(input.contextSelection))
      conflict('Presentation belongs to a different reviewed context');
    if (saved) return;
    if (hasOriginal) conflict('A presentation cannot attach to an existing role request');
    this.db
      .prepare(
        'INSERT INTO telos_work_role_setup_presentations(request_id,actor_id,fingerprint,presentation_id,presentation_sha256) VALUES(?,?,?,?,?)',
      )
      .run(input.requestId, actorId, fingerprint, raw.id, raw.sha256);
  }
  rolePresentationForSetup(
    raw: unknown,
    actor: TelosWorkActor,
  ): TelosWorkRoleContextReview | undefined {
    this.operator(actor);
    const input = TelosWorkRoleSetupInputSchema.parse(raw);
    const saved = this.db
      .prepare('SELECT * FROM telos_work_role_setup_presentations WHERE request_id=?')
      .get(input.requestId) as
      | {
          actor_id: string;
          fingerprint: string;
          presentation_id: string;
          presentation_sha256: string;
        }
      | undefined;
    if (!saved) return undefined;
    const ref = { id: saved.presentation_id, sha256: saved.presentation_sha256 };
    this.qualifyRolePresentation(input, actor, ref, true);
    return this.readRolePresentation(ref, `operator:${actor.id}`);
  }
  prepareRoleSetup(
    raw: unknown,
    actor: TelosWorkActor,
    reviewIsCurrent?: () => boolean,
    presentationRef?: TelosWorkRolePresentationRef | null,
  ): { setup: TelosWorkRoleSetupIntent; receipt: TelosWorkCommandReceipt | null } {
    this.operator(actor);
    const input = TelosWorkRoleSetupInputSchema.parse(raw);
    const nested = this.db.inTransaction;
    const result = this.db
      .transaction(() => {
        const actorId = `operator:${actor.id}`;
        const fingerprint = hash(input);
        const saved = this.db
          .prepare(
            'SELECT fingerprint,intent,receipt FROM telos_work_role_setups WHERE actor_id=? AND request_id=?',
          )
          .get(actorId, input.requestId) as
          { fingerprint: string; intent: string; receipt: string | null } | undefined;
        const rejected = this.db
          .prepare(
            'SELECT actor_id,fingerprint,reason FROM telos_work_role_setup_rejections WHERE request_id=?',
          )
          .get(input.requestId) as
          | { actor_id: string; fingerprint: string; reason: 'work_revision' | 'reviewed_context' }
          | undefined;
        // Public HTTP admission supplies null for legacy setup or the exact ref.
        // Internal ordinary owner replay omits this extra display-data qualifier.
        if (presentationRef !== undefined)
          this.qualifyRolePresentation(input, actor, presentationRef, !!saved || !!rejected);
        if (saved) {
          if (saved.fingerprint !== fingerprint)
            conflict('Role setup identity reused with different input');
          return {
            setup: JSON.parse(saved.intent) as TelosWorkRoleSetupIntent,
            receipt: saved.receipt
              ? TelosWorkCommandReceiptSchema.parse(JSON.parse(saved.receipt))
              : null,
          };
        }
        if (
          this.db
            .prepare(
              'SELECT 1 FROM telos_work_role_setups WHERE request_id=? AND actor_id<>? LIMIT 1',
            )
            .get(input.requestId, actorId)
        )
          conflict('Role setup request belongs to another operator');
        if (rejected) {
          if (rejected.actor_id !== actorId || rejected.fingerprint !== fingerprint)
            conflict('Role setup identity reused with different input or operator');
          return { rejection: rejected.reason };
        }
        const reason =
          this.snapshot(input.itemId).revision !== input.expectedRevision
            ? 'work_revision'
            : reviewIsCurrent && !reviewIsCurrent()
              ? 'reviewed_context'
              : null;
        if (reason) {
          this.db
            .prepare(
              'INSERT INTO telos_work_role_setup_rejections(request_id,actor_id,fingerprint,reason) VALUES(?,?,?,?)',
            )
            .run(input.requestId, actorId, fingerprint, reason);
          return { rejection: reason };
        }
        const setup: TelosWorkRoleSetupIntent = {
          actorId,
          input,
          allocationOperationId: randomUUID(),
        };
        this.db
          .prepare(
            'INSERT INTO telos_work_role_setups(actor_id,request_id,fingerprint,intent) VALUES(?,?,?,?)',
          )
          .run(actorId, input.requestId, fingerprint, JSON.stringify(setup));
        return { setup, receipt: null };
      })
      .immediate();
    // Throw only after the transaction commits. Throwing inside it would lose
    // the proof and permit the rejected UUID to allocate after a later change.
    if ('rejection' in result)
      throw new TelosWorkError(
        'conflict',
        result.rejection === 'work_revision'
          ? 'Work revision conflict'
          : 'Reviewed work context changed',
        // A caller-owned outer transaction could still roll this journal back.
        nested
          ? undefined
          : { version: 1, requestId: input.requestId, outcome: 'rejected_before_allocation' },
      );
    return result;
  }
  completeRoleSetup(
    setup: TelosWorkRoleSetupIntent,
    conversationId: string,
    actor: TelosWorkActor,
    assertBeforeApply: () => void,
  ): TelosWorkCommandReceipt {
    this.operator(actor);
    return this.db
      .transaction(() => {
        const retained = this.prepareRoleSetup(setup.input, actor);
        if (JSON.stringify(retained.setup) !== JSON.stringify(setup))
          conflict('Role setup scope mismatch');
        if (retained.receipt) return retained.receipt;
        const { itemId, expectedRevision, role, expectedAssignmentRevision } = setup.input;
        const receipt = this.execute(
          {
            itemId,
            expectedRevision,
            role,
            expectedAssignmentRevision,
            requestId: `role:${setup.allocationOperationId}`,
            operation: 'setup_role',
            conversationId,
          },
          actor,
          assertBeforeApply,
        );
        this.db
          .prepare('UPDATE telos_work_role_setups SET receipt=? WHERE actor_id=? AND request_id=?')
          .run(JSON.stringify(receipt), setup.actorId, setup.input.requestId);
        return receipt;
      })
      .immediate();
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
  private availableConversation(role: TelosWorkSessionLink['role'], id: string): boolean {
    return role === 'origin' && this.policy.sourceConversation
      ? this.policy.sourceConversation(id)
      : this.policy.ordinaryConversation(id);
  }
  private currentAvailability(link: TelosWorkSessionLink): TelosWorkSessionLink {
    return {
      ...link,
      availability:
        link.conversation.namespace === 'mitzo'
          ? this.availableConversation(link.role, link.conversation.conversationId)
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
      return this.projectRecord(itemId);
    })();
  }
  private projectRecord(itemId: string): TelosWorkItem {
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
  }
  /** Bounded host read: a current outcome lead sees only this child and its
   * canonical ancestry. This grants no ordinary conversation read or mutation. */
  readDelegationTarget(leadConversationId: string, childItemId: string, itemId: string) {
    return this.db.transaction(() => {
      const child = this.item(childItemId);
      if (!child.parent_id || this.snapshot(childItemId).kind !== 'work_item')
        invalid('Delegation requires one exact child work item');
      const parent = this.snapshot(child.parent_id);
      const lead = parent.assignments.find((assignment) => assignment.role === 'lead');
      if (
        parent.kind !== 'outcome' ||
        lead?.conversation.conversationId !== leadConversationId ||
        !this.policy.ordinaryConversation(leadConversationId)
      )
        throw new TelosWorkError('unauthorized', 'Current ordinary outcome lead required');
      const allowed = new Set<string>();
      let selected: string | null = childItemId;
      while (selected !== null) {
        if (allowed.has(selected) || allowed.size >= 100)
          throw new TelosWorkError('unauthorized', 'Delegation ancestry unavailable');
        allowed.add(selected);
        selected = this.item(selected).parent_id;
      }
      if (!allowed.has(itemId))
        throw new TelosWorkError('unauthorized', 'Outside exact delegation scope');
      return { record: this.projectRecord(itemId), work: this.snapshot(itemId) };
    })();
  }
  /** One consistent brief/relationship boundary for a source preview. */
  readSourceTarget(itemId: string, actor: TelosWorkActor) {
    this.operator(actor);
    return this.db.transaction(() => ({
      record: this.readRecord(itemId, actor),
      work: this.snapshot(itemId),
    }))();
  }
  /** Creation preparation is an outbox for the existing canonical creator, not
   * another item/milestone engine. Keep the reviewed source before crossing owners.
   */
  sourceCreation(requestId: string, inputHash: string, actor: TelosWorkActor) {
    this.operator(actor);
    const row = this.db
      .prepare('SELECT * FROM telos_work_source_creations WHERE actor_id=? AND request_id=?')
      .get('operator:' + actor.id, requestId) as SourceCreationRow | undefined;
    if (!row) return null;
    if (row.input_hash !== inputHash)
      conflict('Creation request identity reused with different input');
    return {
      packet: TelosSourcePacketSchema.parse(JSON.parse(row.packet)),
      idempotencyKey: row.idempotency_key,
      itemId: row.item_id,
      itemRevision: row.item_revision,
      receipt: row.receipt ? TelosWorkCommandReceiptSchema.parse(JSON.parse(row.receipt)) : null,
    };
  }
  prepareSourceCreation(
    requestId: string,
    inputHash: string,
    packet: TelosSourcePacket,
    actor: TelosWorkActor,
  ) {
    this.operator(actor);
    return this.db
      .transaction(() => {
        const prior = this.sourceCreation(requestId, inputHash, actor);
        if (prior) return prior;
        const parsed = TelosSourcePacketSchema.parse(packet);
        if (
          parsed.itemId !== null ||
          parsed.actorId !== 'operator:' + actor.id ||
          parsed.creation?.requestId !== requestId
        )
          invalid('Invalid reviewed creation scope');
        const key = 'telos-source:' + hash(['source-create', parsed.actorId, requestId]);
        this.db
          .prepare(
            'INSERT INTO telos_work_source_creations(actor_id,request_id,input_hash,packet,idempotency_key) VALUES(?,?,?,?,?)',
          )
          .run(parsed.actorId, requestId, inputHash, JSON.stringify(parsed), key);
        return this.sourceCreation(requestId, inputHash, actor)!;
      })
      .immediate();
  }
  recordSourceCreationItem(
    requestId: string,
    inputHash: string,
    itemId: string,
    actor: TelosWorkActor,
  ) {
    this.operator(actor);
    return this.db
      .transaction(() => {
        const record = this.sourceCreation(requestId, inputHash, actor);
        if (!record?.packet.creation) invalid('Reviewed creation not prepared');
        if (record.itemId) {
          if (record.itemId !== itemId) conflict('Creation item identity changed');
          return record;
        }
        const item = this.item(itemId);
        if (item.idempotency_key !== record.idempotencyKey)
          invalid('Canonical creation identity mismatch');
        const proposal = record.packet.creation.outcome;
        const actual = this.readRecord(itemId, actor);
        const childRows = this.db
          .prepare('SELECT id,summary FROM items WHERE parent_id=? ORDER BY created_at,rowid')
          .all(itemId) as { id: string; summary: string }[];
        const children = childRows.map((child) => child.summary);
        if (
          JSON.stringify([
            actual.parentId,
            actual.summary,
            actual.intent,
            actual.rationale,
            actual.acceptanceCriteria,
            actual.profile,
            actual.contextHints,
            actual.links.map(({ type, url, title, description }) => ({
              type,
              url,
              title,
              description,
            })),
            children,
          ]) !==
          JSON.stringify([
            null,
            proposal.summary,
            proposal.intent,
            proposal.rationale,
            proposal.acceptanceCriteria,
            proposal.profile,
            TelosOutcomeContextHintsSchema.parse(proposal.contextHints ?? {}),
            (proposal.links ?? []).map(({ type, url, title, description }) => ({
              type,
              url: url.trim(),
              title,
              description: description ?? '',
            })),
            proposal.milestones,
          ])
        )
          conflict('Created outcome differs from the reviewed proposal');
        const kind = this.snapshot(itemId).kind;
        if (kind && kind !== 'outcome') conflict('Created item classification changed');
        if (!kind)
          this.db
            .prepare("INSERT INTO telos_work_kinds(item_id,kind) VALUES(?,'outcome')")
            .run(itemId);
        for (const child of childRows) {
          const kind = this.snapshot(child.id).kind;
          if (kind && kind !== 'work_item') conflict('Created milestone classification changed');
          if (!kind)
            this.db
              .prepare("INSERT INTO telos_work_kinds(item_id,kind) VALUES(?,'work_item')")
              .run(child.id);
        }
        const revision = this.snapshot(itemId).revision;
        this.db
          .prepare(
            'UPDATE telos_work_source_creations SET item_id=?,item_revision=? WHERE actor_id=? AND request_id=?',
          )
          .run(itemId, revision, 'operator:' + actor.id, requestId);
        return this.sourceCreation(requestId, inputHash, actor)!;
      })
      .immediate();
  }
  completeSourceCreation(
    requestId: string,
    inputHash: string,
    receipt: TelosWorkCommandReceipt,
    actor: TelosWorkActor,
  ) {
    this.operator(actor);
    return this.db
      .transaction(() => {
        const record = this.sourceCreation(requestId, inputHash, actor);
        if (
          !record?.itemId ||
          record.itemId !== receipt.work.itemId ||
          receipt.actorId !== 'operator:' + actor.id
        )
          invalid('Creation receipt scope mismatch');
        if (record.receipt) return record.receipt;
        const recorded = this.db
          .prepare(
            "SELECT receipt FROM telos_work_commands WHERE actor_id=? AND json_extract(receipt,'$.commandId')=?",
          )
          .get(receipt.actorId, receipt.commandId) as { receipt: string } | undefined;
        if (!recorded || recorded.receipt !== JSON.stringify(receipt))
          invalid('Creation requires an actual source adoption receipt');
        this.db
          .prepare(
            'UPDATE telos_work_source_creations SET receipt=? WHERE actor_id=? AND request_id=?',
          )
          .run(recorded.receipt, receipt.actorId, requestId);
        return receipt;
      })
      .immediate();
  }
  sourceCreationBinds(itemId: string, packet: TelosSourcePacket, actor: TelosWorkActor) {
    this.operator(actor);
    return this.sourceCreationProof(itemId, packet);
  }
  sourceCreationBindsForDelegation(
    leadConversationId: string,
    childItemId: string,
    packet: TelosSourcePacket,
  ) {
    this.readDelegationTarget(leadConversationId, childItemId, childItemId);
    return this.sourceCreationProof(childItemId, packet);
  }
  private sourceCreationProof(itemId: string, packet: TelosSourcePacket) {
    if (!packet.creation || packet.itemId !== null) return false;
    const row = this.db
      .prepare(
        'SELECT item_id,packet FROM telos_work_source_creations WHERE actor_id=? AND request_id=?',
      )
      .get(packet.actorId, packet.creation.requestId) as
      { item_id: string | null; packet: string } | undefined;
    return !!row && row.item_id === itemId && row.packet === JSON.stringify(packet);
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
  execute(
    raw: unknown,
    actor: TelosWorkActor,
    assertBeforeApply?: () => void,
  ): TelosWorkCommandReceipt {
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
        // Host-only denial port, never command JSON or a grant. Exact completed
        // receipts remain recoverable before authority for a new apply is read.
        assertBeforeApply?.();
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
  /** Narrow host port for the existing approved creation tool. A conversation
   * cannot attach arbitrary work: canonical creation identity and stored source
   * hint must both match its actual Mitzo ID. Missing historical selections stay
   * unknown; this is not a reviewed source packet or operator read grant. */
  recordCreatedOrigin(
    input: { itemId: string; idempotencyKey: string },
    actor: TelosWorkActor,
  ): void {
    if (
      actor.kind !== 'conversation' ||
      !actor.id.trim() ||
      !this.availableConversation('origin', actor.id) ||
      !input.idempotencyKey.startsWith(actor.id + ':')
    )
      throw new TelosWorkError('unauthorized', 'Registered source conversation required');
    this.db
      .transaction(() => {
        const row = this.item(input.itemId);
        if (row.idempotency_key !== input.idempotencyKey)
          conflict('Canonical creation identity differs');
        const hints = JSON.parse(String(row.context_hints ?? '{}')) as { session_ids?: unknown };
        if (!Array.isArray(hints.session_ids) || !hints.session_ids.includes(actor.id))
          conflict('Canonical source identity differs');
        const kind = this.db
          .prepare('SELECT kind FROM telos_work_kinds WHERE item_id=?')
          .get(input.itemId) as { kind: string } | undefined;
        if (kind && kind.kind !== 'outcome') conflict('Created outcome kind differs');
        this.db
          .prepare("INSERT OR IGNORE INTO telos_work_kinds(item_id,kind) VALUES(?,'outcome')")
          .run(input.itemId);
        this.addLink(
          input.itemId,
          'origin',
          { namespace: 'mitzo', conversationId: actor.id },
          'conversation:' + actor.id,
        );
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
          ? this.availableConversation(role, conversation.conversationId)
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
      case 'setup_role': {
        if (
          (input.role === 'advisor' || input.role === 'reviewer') &&
          input.expectedAssignmentRevision !== null
        )
          invalid('An advisor or reviewer cannot be the current lead or worker');
        this.addLink(
          input.itemId,
          input.role,
          { namespace: 'mitzo', conversationId: input.conversationId },
          actorId,
        );
        if (
          (input.role === 'lead' || input.role === 'worker') &&
          input.expectedAssignmentRevision !== null
        )
          this.apply(
            {
              ...input,
              operation: 'assign',
              role: input.role,
              expectedAssignmentRevision: input.expectedAssignmentRevision,
            },
            actorId,
          );
        break;
      }
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
  /** Scoped host capability: a bound lead may request only its exact child. */
  assertDelegationAuthority(intent: TelosWorkDelegationIntent, actor: TelosWorkActor) {
    const input = intent.input;
    if (
      !actor.id.trim() ||
      (actor.kind === 'conversation' && actor.id !== input.leadConversationId)
    )
      throw new TelosWorkError('unauthorized', 'Exact lead delegation authority required');
    const child = this.item(input.childItemId);
    const parent = this.snapshot(input.leadItemId);
    if (
      child.parent_id !== input.leadItemId ||
      this.snapshot(input.childItemId).kind !== 'work_item' ||
      parent.kind !== 'outcome'
    )
      invalid('Delegation requires one exact child work item of the selected outcome');
    const lead = parent.assignments.find((assignment) => assignment.role === 'lead');
    if (
      lead?.conversation.conversationId !== input.leadConversationId ||
      !this.policy.ordinaryConversation(input.leadConversationId)
    )
      throw new TelosWorkError('unauthorized', 'Current ordinary outcome lead required');
    const receipt = this.db
      .prepare(
        'SELECT 1 FROM telos_work_delegation_requests WHERE attempt_id=? AND receipt IS NOT NULL LIMIT 1',
      )
      .get(intent.attemptId);
    if (!receipt)
      for (const pin of intent.recordRevisions) {
        if (hash(this.item(pin.itemId)) !== pin.sha256)
          conflict('Reviewed delegation context changed');
      }
  }
  delegationRequestForHost(
    requestId: string,
    actor: TelosWorkActor,
  ): TelosWorkDelegationIntent | null {
    const row = this.db
      .prepare(
        'SELECT intent FROM telos_work_delegation_requests WHERE actor_id=? AND request_id=?',
      )
      .get(`${actor.kind}:${actor.id}`, requestId) as { intent: string } | undefined;
    return row ? (JSON.parse(row.intent) as TelosWorkDelegationIntent) : null;
  }
  delegationCommittedForHost(attemptId: string): boolean {
    return !!this.db
      .prepare(
        'SELECT 1 FROM telos_work_delegation_requests WHERE attempt_id=? AND receipt IS NOT NULL LIMIT 1',
      )
      .get(attemptId);
  }
  delegationAllocationForHost(allocationOperationId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM telos_work_delegation_requests WHERE json_extract(intent,'$.allocationOperationId')=? LIMIT 1",
      )
      .get(allocationOperationId);
  }
  latestDelegationForHost(childItemId: string): TelosWorkDelegationIntent | null {
    const row = this.db
      .prepare(
        'SELECT d.intent FROM telos_work_attempts a JOIN telos_work_delegation_requests d ON d.attempt_id=a.attempt_id WHERE a.item_id=? ORDER BY a.seq DESC LIMIT 1',
      )
      .get(childItemId) as { intent: string } | undefined;
    return row ? (JSON.parse(row.intent) as TelosWorkDelegationIntent) : null;
  }
  prepareDelegation(
    raw: unknown,
    actor: TelosWorkActor,
    assertBeforeApply: (intent: TelosWorkDelegationIntent) => void = () => {},
    capturePresentation?: (intent: TelosWorkDelegationIntent) => TelosWorkRolePresentation,
  ): { intent: TelosWorkDelegationIntent; receipt: TelosWorkDelegationReceipt | null } {
    const input = TelosWorkDelegationInputSchema.parse(raw);
    const actorId = `${actor.kind}:${actor.id}`;
    const fingerprint = hash(input);
    return this.db
      .transaction(() => {
        const saved = this.db
          .prepare(
            'SELECT fingerprint,intent,receipt FROM telos_work_delegation_requests WHERE actor_id=? AND request_id=?',
          )
          .get(actorId, input.requestId) as
          { fingerprint: string; intent: string; receipt: string | null } | undefined;
        if (saved) {
          if (saved.fingerprint !== fingerprint)
            conflict('Delegation request identity reused with different input');
          const intent = JSON.parse(saved.intent) as TelosWorkDelegationIntent;
          this.assertDelegationAuthority(intent, actor);
          assertBeforeApply(intent);
          return {
            intent,
            receipt: saved.receipt
              ? TelosWorkDelegationReceiptSchema.parse(JSON.parse(saved.receipt))
              : null,
          };
        }
        if (
          this.db
            .prepare(
              'SELECT 1 FROM telos_work_delegation_requests WHERE request_id=? AND actor_id<>?',
            )
            .get(input.requestId, actorId)
        )
          conflict('Delegation request belongs to another actor');
        const previous = this.db
          .prepare(
            'SELECT attempt_id FROM telos_work_attempts WHERE item_id=? ORDER BY seq DESC LIMIT 1',
          )
          .get(input.childItemId) as { attempt_id: string } | undefined;
        if (input.mode === 'start' && previous) {
          const retained = this.db
            .prepare(
              'SELECT intent,receipt FROM telos_work_delegation_requests WHERE attempt_id=? LIMIT 1',
            )
            .get(previous.attempt_id) as { intent: string; receipt: string | null } | undefined;
          if (!retained) conflict('Existing attempt requires its original allocation recovery');
          const intent = JSON.parse(retained.intent) as TelosWorkDelegationIntent;
          if (
            intent.input.leadConversationId !== input.leadConversationId ||
            intent.input.leadItemId !== input.leadItemId
          )
            conflict('Existing worker belongs to its original lead; explicit retry required');
          this.assertDelegationAuthority(intent, actor);
          assertBeforeApply(intent);
          this.db
            .prepare('INSERT INTO telos_work_delegation_requests VALUES(?,?,?,?,?,?)')
            .run(
              actorId,
              input.requestId,
              fingerprint,
              intent.attemptId,
              retained.intent,
              retained.receipt,
            );
          return {
            intent,
            receipt: retained.receipt
              ? TelosWorkDelegationReceiptSchema.parse(JSON.parse(retained.receipt))
              : null,
          };
        }
        if ((previous?.attempt_id ?? null) !== input.predecessorAttemptId)
          conflict('Retry predecessor conflict');
        if (
          this.snapshot(input.childItemId).revision !== input.expectedRevision ||
          input.contextSelection.brief.revision !== input.expectedRevision
        )
          conflict('Reviewed child work revision changed');
        const contextSnapshotId = `delegation:${hash(input.contextSelection)}`;
        const itemIds = new Set([
          input.childItemId,
          ...input.contextSelection.parentCriteria.map((p) => p.itemId),
          input.contextSelection.overallGoal.itemId,
        ]);
        const intent: TelosWorkDelegationIntent = {
          actorId,
          input,
          attemptId: randomUUID(),
          allocationOperationId: randomUUID(),
          contextSnapshotId,
          recordRevisions: [...itemIds].map((itemId) => ({
            itemId,
            sha256: hash(this.item(itemId)),
          })),
        };
        this.assertDelegationAuthority(intent, actor);
        assertBeforeApply(intent);
        // Capture before adding the attempt advances this item's revision. The
        // presentation and its attempt association commit in this same owner.
        const display = capturePresentation
          ? this.retainRolePresentation(actorId, () => ({
              selection: intent.input.contextSelection,
              presentation: capturePresentation(structuredClone(intent)),
            }))
          : undefined;
        const attempt = TelosWorkAttemptSchema.parse({
          version: 1,
          requestId: input.requestId,
          attemptId: intent.attemptId,
          predecessorAttemptId: input.predecessorAttemptId,
          leadConversationId: input.leadConversationId,
          childItemId: input.childItemId,
          contextSnapshotId,
          state: 'requested',
          workerConversationId: null,
          allocationReceiptId: null,
          executionTaskId: null,
          accountingGoalId: null,
          turnCommandId: null,
        });
        this.db
          .prepare('INSERT INTO telos_work_attempts(attempt_id,item_id,data) VALUES(?,?,?)')
          .run(intent.attemptId, input.childItemId, JSON.stringify(attempt));
        this.db
          .prepare('INSERT INTO telos_work_allocation_outbox VALUES(?,?,?,?,?)')
          .run(
            intent.attemptId,
            actorId,
            JSON.stringify(input.settings),
            intent.attemptId,
            'requested',
          );
        this.db
          .prepare('INSERT INTO telos_work_delegation_requests VALUES(?,?,?,?,?,NULL)')
          .run(actorId, input.requestId, fingerprint, intent.attemptId, JSON.stringify(intent));
        if (display)
          this.db
            .prepare(
              'INSERT INTO telos_work_delegation_presentations(attempt_id,presentation_id,presentation_sha256) VALUES(?,?,?)',
            )
            .run(intent.attemptId, display.presentationRef.id, display.presentationRef.sha256);
        return { intent, receipt: null };
      })
      .immediate();
  }
  /** Host-only display read after exact existing S5 authority is requalified. */
  rolePresentationForDelegation(
    intent: TelosWorkDelegationIntent,
    actor: TelosWorkActor,
  ): TelosWorkRoleContextReview | undefined {
    this.assertDelegationAuthority(intent, actor);
    const original = this.db
      .prepare('SELECT intent FROM telos_work_delegation_requests WHERE attempt_id=? LIMIT 1')
      .get(intent.attemptId) as { intent: string } | undefined;
    if (!original || JSON.stringify(JSON.parse(original.intent)) !== JSON.stringify(intent))
      conflict('Original delegation presentation scope required');
    const saved = this.db
      .prepare(
        'SELECT presentation_id,presentation_sha256 FROM telos_work_delegation_presentations WHERE attempt_id=?',
      )
      .get(intent.attemptId) as
      { presentation_id: string; presentation_sha256: string } | undefined;
    if (!saved) return undefined;
    const review = this.readRolePresentation(
      { id: saved.presentation_id, sha256: saved.presentation_sha256 },
      intent.actorId,
    );
    if (JSON.stringify(review.selection) !== JSON.stringify(intent.input.contextSelection))
      throw new Error('Original delegated role presentation unavailable');
    return review;
  }
  markDelegationUncertain(attemptId: string) {
    this.db
      .transaction(() => {
        const attempt = this.attemptForHost(attemptId);
        if (!attempt || attempt.state === 'chat_ready') return;
        this.db
          .prepare('UPDATE telos_work_attempts SET data=? WHERE attempt_id=?')
          .run(JSON.stringify({ ...attempt, state: 'allocation_uncertain' }), attemptId);
      })
      .immediate();
  }
  completeDelegation(
    intent: TelosWorkDelegationIntent,
    actor: TelosWorkActor,
    result: {
      workerConversationId: string;
      executionTaskId: string;
      workerDisplay?: TelosWorkDelegationReceipt['workerDisplay'];
    },
    verify: () => boolean,
    assertBeforeApply: () => void,
  ): TelosWorkDelegationReceipt {
    return this.db
      .transaction(() => {
        const saved = this.db
          .prepare(
            'SELECT intent,receipt FROM telos_work_delegation_requests WHERE attempt_id=? LIMIT 1',
          )
          .get(intent.attemptId) as { intent: string; receipt: string | null } | undefined;
        if (!saved || saved.intent !== JSON.stringify(intent))
          conflict('Delegation intent changed');
        this.assertDelegationAuthority(intent, actor);
        assertBeforeApply();
        if (saved.receipt) return TelosWorkDelegationReceiptSchema.parse(JSON.parse(saved.receipt));
        if (!verify()) invalid('Verified exact ordinary allocation and task receipt required');
        this.recordAllocation(
          intent.attemptId,
          {
            workerConversationId: result.workerConversationId,
            allocationReceiptId: intent.allocationOperationId,
          },
          () => verify(),
        );
        const attempt = this.recordExecutionTask(
          intent.attemptId,
          {
            childItemId: intent.input.childItemId,
            leadConversationId: intent.input.leadConversationId,
            workerConversationId: result.workerConversationId,
            executionTaskId: result.executionTaskId,
          },
          () => verify(),
        );
        assertBeforeApply();
        const receipt = TelosWorkDelegationReceiptSchema.parse({
          version: 1,
          state: 'chat_ready',
          attempt,
          workerConversationId: result.workerConversationId,
          workerPath: `/chat/${encodeURIComponent(result.workerConversationId)}`,
          itemPath: `/todos/${encodeURIComponent(intent.input.childItemId)}`,
          leadPath: `/chat/${encodeURIComponent(intent.input.leadConversationId)}`,
          execution: 'not_started',
          ...(result.workerDisplay ? { workerDisplay: result.workerDisplay } : {}),
        });
        this.db
          .prepare('UPDATE telos_work_delegation_requests SET receipt=? WHERE attempt_id=?')
          .run(JSON.stringify(receipt), intent.attemptId);
        return receipt;
      })
      .immediate();
  }
  /** Host-only reconciliation read; never exposed by the operator/conversation API. */
  attemptForHost(attemptId: string): TelosWorkAttempt | null {
    const row = this.json<TelosWorkAttempt>(
      'SELECT data FROM telos_work_attempts WHERE attempt_id=?',
      attemptId,
    )[0];
    return row ?? null;
  }
  /** Host-only durable authority lookup for the exact task and worker pair.
   * Retained attribution survives conversation availability and role changes.
   */
  executionTaskBinding(
    executionTaskId: string,
    workerConversationId: string,
  ): TelosWorkAttempt | null {
    const row = this.db
      .prepare(
        "SELECT data FROM telos_work_attempts WHERE json_extract(data,'$.executionTaskId')=? AND json_extract(data,'$.workerConversationId')=?",
      )
      .get(executionTaskId, workerConversationId) as JsonRow | undefined;
    return row ? TelosWorkAttemptSchema.parse(JSON.parse(row.data)) : null;
  }
  /** Host-only task-owner reconciliation. This binds retained allocation authority;
   * it does not start execution, assign a worker, or rewrite role context.
   * The caller verifies the task owner's exact immutable worker/item/lead scope.
   */
  recordExecutionTask(
    attemptId: string,
    binding: {
      childItemId: string;
      leadConversationId: string;
      workerConversationId: string;
      executionTaskId: string;
    },
    verify: (evidence: {
      attemptId: string;
      childItemId: string;
      leadConversationId: string;
      workerConversationId: string;
      executionTaskId: string;
      allocationReceiptId: string;
    }) => boolean,
  ): TelosWorkAttempt {
    return this.db
      .transaction(() => {
        const row = this.json<TelosWorkAttempt>(
          'SELECT data FROM telos_work_attempts WHERE attempt_id=?',
          attemptId,
        )[0];
        if (!row) throw new TelosWorkError('not_found', 'Attempt not found');
        if (row.state !== 'chat_ready' || !row.workerConversationId || !row.allocationReceiptId)
          invalid('Execution binding requires a verified chat_ready attempt');
        if (
          !binding.executionTaskId.trim() ||
          binding.childItemId !== row.childItemId ||
          binding.leadConversationId !== row.leadConversationId ||
          binding.workerConversationId !== row.workerConversationId ||
          binding.workerConversationId === row.leadConversationId
        )
          invalid('Execution task scope differs from the verified worker attempt');
        if (row.executionTaskId !== null) {
          if (row.executionTaskId !== binding.executionTaskId)
            conflict('Execution task binding conflict');
          return row;
        }
        if (
          this.db
            .prepare(
              "SELECT 1 FROM telos_work_attempts WHERE json_extract(data,'$.executionTaskId')=? AND attempt_id<>?",
            )
            .get(binding.executionTaskId, attemptId)
        )
          conflict('Execution task already bound to another attempt: conflict');
        if (
          !this.policy.ordinaryConversation(binding.workerConversationId) ||
          !verify({ attemptId, ...binding, allocationReceiptId: row.allocationReceiptId })
        )
          invalid('Verified exact worker execution task required');
        const attempt = TelosWorkAttemptSchema.parse({
          ...row,
          executionTaskId: binding.executionTaskId,
        });
        this.db
          .prepare('UPDATE telos_work_attempts SET data=? WHERE attempt_id=?')
          .run(JSON.stringify(attempt), attemptId);
        return attempt;
      })
      .immediate();
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

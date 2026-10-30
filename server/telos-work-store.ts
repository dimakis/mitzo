import type { EventStore } from './event-store.js';
import type { TaskStore } from './task-store.js';
import {
  openTelosOwnedDatabase,
  retainTelosDeletionWriterMarker,
  type TelosOwnedDatabase,
} from '@mitzo/protocol/telos-sqlite-owners';
import {
  TelosOrdinaryWorkDelegationInputSchema,
  TelosOrdinaryWorkDelegationIntentSchema,
  TelosLegacyWorkDelegationIntentSchema,
  TelosWorkDelegationRequestIntentSchema,
  type TelosWorkDelegationRequest,
  type TelosWorkDelegationRequestIntent,
  type TelosOrdinaryWorkDelegationIntent,
} from '@mitzo/protocol';
import {
  TelosWorkRoleSetupIntentSchema,
  TelosOrdinaryWorkRoleSetupInputSchema,
  TelosOrdinaryWorkRoleSetupIntentSchema,
  TelosWorkRoleSetupRequestIntentSchema,
  type TelosWorkRoleSetupRequest,
  type TelosWorkRoleSetupRequestIntent,
  type TelosOrdinaryWorkRoleSetupIntent,
} from '@mitzo/protocol';
import Database from 'better-sqlite3';
import { isAbsolute, resolve } from 'node:path';
import { TelosWorkControls } from './telos-work-controls.js';
import { TelosWorkLifecycle } from './telos-work-lifecycle.js';
import type { TelosWorkControlScope } from '@mitzo/protocol';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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
  TelosWorkAdvisorDraftSaveRequestSchema,
  TelosWorkSourceSnapshotSchema,
  type TelosWorkCommand,
  type TelosWorkCommandReceipt,
  type TelosWorkView,
  type TelosWorkSessionLink,
  type TelosWorkAssignment,
  TelosWorkAssignmentSchema,
  type TelosWorkAssignmentHistory,
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
import { TelosMainPublicationRecords } from './telos-main-publication-records.js';
import type { MainPublicationPins } from './telos-main-publication-contract.js';
import { projectTelosCollection } from './telos-collection.js';
import { TelosWorkLifecycleListSchema } from '@mitzo/protocol';
import { projectTelosWorkRecord } from './telos-work-record.js';
import {
  TelosListItemsInputSchema,
  TelosListItemsResultSchema,
  TelosRecordsInputSchema,
  type TelosRecordsResult,
} from '@mitzo/protocol';

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

type LifecycleDeletionInvocation = {
  invalidated: boolean;
  writer?: ReturnType<typeof retainTelosDeletionWriterMarker>;
  fence?: { assertCurrent(): void; close(): void };
};

type TelosWorkStorePolicy = {
  ordinaryConversation(id: string): boolean;
  sourceConversation?(id: string): boolean;
};

/** Extends the canonical Telos database, not session allocation or composition.
 * parent_id stays on items. No event/session/task store write occurs here.
 * Command results and allocation intents commit in the same SQLite transaction.
 */
export class TelosWorkStore {
  private db: Database.Database;
  #telosOwner: TelosOwnedDatabase;
  #openedCanonicalName: string;
  #deletionFrame:
    | {
        itemId: string;
        invalidated: boolean;
        writer: ReturnType<typeof retainTelosDeletionWriterMarker>;
      }
    | undefined;
  #lifecycleInvocation: LifecycleDeletionInvocation | undefined;
  /** Observe initialized canonical authority without acquiring a schema writer.
   * Used by running-turn guards, including inside another owner's commit fence.
   * SQLite enforces read-only access; missing schema remains unavailable.
   */
  static openReadOnly(path: string, policy: TelosWorkStorePolicy): TelosWorkStore {
    return new TelosWorkStore(path, policy, true);
  }
  /** Record reads use committed initialized data without acquiring a schema
   * writer. A missing extension layout still takes the original initializer;
   * busy, invalid or otherwise unavailable stores never retry as a writer. */
  static openForRecordRead(path: string, policy: TelosWorkStorePolicy): TelosWorkStore {
    let store: TelosWorkStore | undefined;
    try {
      store = TelosWorkStore.openReadOnly(path, policy);
      store.db.prepare('SELECT kind FROM telos_work_kinds LIMIT 0').all();
      return store;
    } catch (error) {
      store?.close();
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'SQLITE_ERROR' ||
        !/^no such table: telos_work_(attempts|delegation_requests|kinds)$/.test(error.message)
      )
        throw error;
      return new TelosWorkStore(path, policy);
    }
  }
  /** Collection reads also need the additive lifecycle layout. Initialize only
   * genuinely missing tables; a malformed or busy reader never becomes a writer. */
  static openForLifecycleListRead(path: string, policy: TelosWorkStorePolicy): TelosWorkStore {
    const store = TelosWorkStore.openForRecordRead(path, policy);
    try {
      store.db.prepare('SELECT data FROM telos_work_lifecycle LIMIT 0').all();
      store.db.prepare('SELECT receipt FROM telos_work_lifecycle_commands LIMIT 0').all();
      store.db.prepare('SELECT data FROM telos_work_lifecycle_history LIMIT 0').all();
      return store;
    } catch (error) {
      store.close();
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'SQLITE_ERROR' ||
        !/^no such table: telos_work_lifecycle(?:_commands|_history)?$/.test(error.message)
      )
        throw error;
      return new TelosWorkStore(path, policy);
    }
  }
  constructor(
    path: string,
    private readonly policy: TelosWorkStorePolicy,
    readOnly = false,
  ) {
    this.#telosOwner = openTelosOwnedDatabase('canonical', path, {
      fileMustExist: true,
      readonly: readOnly,
    });
    this.db = this.#telosOwner.database;
    this.#openedCanonicalName = resolve(this.db.name);
    try {
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('foreign_keys = ON');
      this.db.prepare('SELECT id,parent_id,updated_at FROM items LIMIT 1').get();
      if (readOnly) {
        this.db.prepare('SELECT data FROM telos_work_attempts LIMIT 0').all();
        this.db.prepare('SELECT intent FROM telos_work_delegation_requests LIMIT 0').all();
      } else {
        initializeTelosWorkSchema(this.db);
      }
      this.#telosOwner.seal();
    } catch (error) {
      this.#telosOwner.close();
      throw error;
    }
  }
  close() {
    this.#telosOwner.close();
  }
  mainPublicationsForHost() {
    return new TelosMainPublicationRecords(
      this.db,
      (id) => this.snapshot(id),
      this.policy.ordinaryConversation,
    );
  }
  recordMainPublicationDenialForHost(pins: MainPublicationPins, assertCurrent: () => void): void {
    // The exact control snapshot, covered uncertainty and applied-denial write
    // share the same SQLite writer fence, including across other real owners.
    this.db
      .transaction(() => {
        assertCurrent();
        const records = this.mainPublicationsForHost();
        records.assertWorkCurrent(pins);
        const controls = this.controlInbox(pins.input.itemId, {
          kind: 'conversation',
          id: pins.authority.conversationId,
        });
        const affected = controls.filter(
          (c) => c.scope === 'publication' && c.stage !== 'released',
        );
        const covered = affected.flatMap((c) =>
          c.targets.flatMap((t) => [t.itemId, ...t.workers.map((w) => w.itemId)]),
        );
        if (!records.hasUncertainForItems(covered)) {
          try {
            this.enforceControlAction(
              pins.input.itemId,
              'publication',
              pins.authority.conversationId,
              pins.input.mainHead,
            );
          } catch (error) {
            // The expected hold denial follows its durable evidence write. Catch it
            // inside the writer transaction so that genuine denial evidence commits.
            if (!(error instanceof TelosWorkError) || error.code !== 'unauthorized') throw error;
          }
        }
      })
      .immediate();
  }
  private controls() {
    return new TelosWorkControls(
      this.db,
      (id) => this.snapshot(id),
      this.policy.ordinaryConversation,
    );
  }
  private lifecycle() {
    return new TelosWorkLifecycle(this.db, (id) => this.snapshot(id), this.controls());
  }
  readLifecycle(itemId: string, actor: TelosWorkActor) {
    return this.lifecycle().read(itemId, actor);
  }
  listLifecycle(view: unknown, actor: TelosWorkActor) {
    return this.lifecycle().list(view, actor);
  }
  /** Internal read projection for the original, already-authenticated canonical
   * list only. It supplies visibility labels, never lifecycle/operator authority. */
  lifecycleVisibilityForCanonicalList(itemIds: readonly string[]) {
    return this.lifecycle().visibilityForCanonicalList(itemIds);
  }
  executeLifecycle(
    raw: unknown,
    actor: TelosWorkActor,
    assertQuiescent?: (itemId: string) => void,
    assertCurrent?: () => void,
  ) {
    if (this.#lifecycleInvocation || this.#deletionFrame) {
      if (this.#lifecycleInvocation) this.#lifecycleInvocation.invalidated = true;
      if (this.#deletionFrame) this.#deletionFrame.invalidated = true;
      conflict('Original writable lifecycle deletion frame required');
    }
    const invocation: LifecycleDeletionInvocation = {
      invalidated: false,
    };
    this.#lifecycleInvocation = invocation;
    const enteredInTransaction = this.db.open && this.db.inTransaction;
    try {
      return this.lifecycle().execute(
        raw,
        actor,
        assertQuiescent
          ? (itemId) => {
              if (
                enteredInTransaction ||
                !this.db.open ||
                this.db.readonly ||
                !this.db.inTransaction
              )
                conflict('Original writable lifecycle deletion frame required');
              const writer = retainTelosDeletionWriterMarker(this.db);
              invocation.writer = writer;
              this.#deletionFrame = { itemId, invalidated: false, writer };
              try {
                const result = assertQuiescent(itemId);
                this.assertLifecycleDeletionWriter(itemId, this.#openedCanonicalName);
                return result;
              } finally {
                this.#deletionFrame = undefined;
              }
            }
          : undefined,
        () => {
          if (invocation.invalidated)
            conflict('Original writable lifecycle deletion frame required');
          invocation.writer?.assertCurrent();
          invocation.fence?.assertCurrent();
        },
        assertCurrent,
      );
    } finally {
      // lifecycle.execute has now committed OR rolled back. Cleanup must never
      // turn a committed immutable receipt into a claimed refusal/no deletion.
      try {
        invocation.fence?.close();
      } catch {
        this.#telosOwner.invalidate();
        process.emitWarning('Retained Telos deletion fence cleanup failed');
      }
      this.#lifecycleInvocation = undefined;
    }
  }
  /** Concrete original-invocation retention; only the actual host calls this
   * inside the original callback with its captured EventStore and TaskStore. */
  retainLifecycleDeletionFence(
    itemId: string,
    expectedCanonicalPath: string,
    events: EventStore,
    tasks: TaskStore,
    assertInstalledOwners: () => void,
  ): void {
    this.assertLifecycleDeletionWriter(itemId, expectedCanonicalPath);
    const invocation = this.#lifecycleInvocation;
    if (!invocation || invocation.invalidated || invocation.fence)
      conflict('Original retained lifecycle deletion scope required');
    assertInstalledOwners();
    const release = this.#telosOwner.acquireDeletionExclusion();
    let eventScope: ReturnType<EventStore['beginTelosDeletionReferenceScope']> | undefined;
    let taskScope: ReturnType<TaskStore['beginTelosDeletionReferenceScope']> | undefined;
    const close = () => {
      let failed = false;
      for (const cleanup of [() => taskScope?.close(), () => eventScope?.close(), release]) {
        try {
          cleanup();
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error('Retained deletion scope cleanup failed');
    };
    try {
      eventScope = events.beginTelosDeletionReferenceScope(itemId);
      taskScope = tasks.beginTelosDeletionReferenceScope(itemId);
      const assertCurrent = () => {
        try {
          if (
            this.#lifecycleInvocation !== invocation ||
            invocation.invalidated ||
            !this.db.open ||
            this.db.readonly ||
            !this.db.inTransaction
          )
            conflict('Original retained lifecycle deletion scope required');
          this.#telosOwner.assertCurrent();
          assertInstalledOwners();
          eventScope!.assertCurrent();
          taskScope!.assertCurrent();
        } catch {
          conflict('Permanent deletion refuses unavailable or retained host references');
        }
      };
      invocation.fence = Object.freeze({ assertCurrent, close });
      assertCurrent();
    } catch (error) {
      if (!invocation.fence) {
        try {
          close();
        } catch {
          this.#telosOwner.invalidate();
        }
      }
      throw error;
    }
  }
  /** Denial-only check on the ORIGINAL request owner during its current callback.
   * Name/frame agreement is not a certificate of external cohort completeness,
   * file replacement history or runtime quiescence. No handle or permit escapes. */
  assertLifecycleDeletionWriter(itemId: string, expectedCanonicalPath: string): void {
    const frame = this.#deletionFrame;
    if (
      !this.db.open ||
      this.db.readonly ||
      !this.db.inTransaction ||
      !frame ||
      frame.invalidated ||
      frame.itemId !== itemId ||
      typeof expectedCanonicalPath !== 'string' ||
      !isAbsolute(expectedCanonicalPath) ||
      resolve(expectedCanonicalPath) !== this.#openedCanonicalName ||
      resolve(this.db.name) !== this.#openedCanonicalName
    )
      conflict('Original writable lifecycle deletion frame required');
    try {
      frame.writer.assertCurrent();
    } catch {
      frame.invalidated = true;
      if (this.#lifecycleInvocation) this.#lifecycleInvocation.invalidated = true;
      this.#telosOwner.invalidate();
      conflict('Original writable lifecycle deletion frame required');
    }
  }
  assertLifecycleActive(itemId: string) {
    this.lifecycle().assertActive(itemId);
  }
  controlInbox(itemId: string, actor: TelosWorkActor) {
    return this.controls().inbox(itemId, actor);
  }
  requestControl(raw: unknown, actor: TelosWorkActor) {
    return this.controls().request(raw, actor);
  }
  readControl(id: string, actor: TelosWorkActor) {
    return this.controls().read(id, actor);
  }
  acknowledgeControl(raw: unknown, actor: TelosWorkActor) {
    return this.controls().acknowledge(raw, actor);
  }
  releaseControl(raw: unknown, actor: TelosWorkActor) {
    return this.controls().release(raw, actor);
  }
  assertControlAction(itemId: string, scope: TelosWorkControlScope, mainCommit?: string) {
    this.assertLifecycleActive(itemId);
    this.controls().assertAction(itemId, scope, mainCommit);
  }
  enforceControlAction(
    itemId: string,
    scope: TelosWorkControlScope,
    conversationId: string,
    mainCommit?: string,
  ) {
    this.assertLifecycleActive(itemId);
    this.controls().enforceAction(itemId, scope, conversationId, mainCommit);
  }
  recordControlAppliedForHost(
    raw: unknown,
    verify: Parameters<TelosWorkControls['recordApplied']>[1],
  ) {
    this.controls().recordApplied(raw, verify);
  }
  recordControlRevalidationForHost(
    raw: unknown,
    verify: Parameters<TelosWorkControls['recordRevalidation']>[1],
  ) {
    this.controls().recordRevalidation(raw, verify);
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
    input: TelosWorkRoleSetupRequest,
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
  roleSetupRequestRetained(requestId: string): boolean {
    return !!this.db
      .prepare(
        'SELECT 1 FROM telos_work_role_setups WHERE request_id=? UNION ALL SELECT 1 FROM telos_work_role_setup_rejections WHERE request_id=? LIMIT 1',
      )
      .get(requestId, requestId);
  }
  rolePresentationForSetup(
    raw: unknown,
    actor: TelosWorkActor,
  ): TelosWorkRoleContextReview | undefined {
    return this.rolePresentationForSetupRequest(TelosWorkRoleSetupInputSchema.parse(raw), actor);
  }
  rolePresentationForOrdinarySetup(
    raw: unknown,
    actor: TelosWorkActor,
  ): TelosWorkRoleContextReview | undefined {
    return this.rolePresentationForSetupRequest(
      TelosOrdinaryWorkRoleSetupInputSchema.parse(raw),
      actor,
    );
  }
  private rolePresentationForSetupRequest(
    input: TelosWorkRoleSetupRequest,
    actor: TelosWorkActor,
  ): TelosWorkRoleContextReview | undefined {
    this.operator(actor);
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
    const result = this.prepareRoleSetupRequest(
      TelosWorkRoleSetupInputSchema.parse(raw),
      actor,
      reviewIsCurrent,
      presentationRef,
    );
    return { ...result, setup: TelosWorkRoleSetupIntentSchema.parse(result.setup) };
  }
  prepareOrdinaryRoleSetup(
    raw: unknown,
    actor: TelosWorkActor,
    reviewIsCurrent?: () => boolean,
    presentationRef?: TelosWorkRolePresentationRef | null,
  ): { setup: TelosOrdinaryWorkRoleSetupIntent; receipt: TelosWorkCommandReceipt | null } {
    const result = this.prepareRoleSetupRequest(
      TelosOrdinaryWorkRoleSetupInputSchema.parse(raw),
      actor,
      reviewIsCurrent,
      presentationRef,
    );
    return { ...result, setup: TelosOrdinaryWorkRoleSetupIntentSchema.parse(result.setup) };
  }
  private prepareRoleSetupRequest(
    input: TelosWorkRoleSetupRequest,
    actor: TelosWorkActor,
    reviewIsCurrent?: () => boolean,
    presentationRef?: TelosWorkRolePresentationRef | null,
  ): { setup: TelosWorkRoleSetupRequestIntent; receipt: TelosWorkCommandReceipt | null } {
    this.operator(actor);
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
            setup: TelosWorkRoleSetupRequestIntentSchema.parse(JSON.parse(saved.intent)),
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
        this.assertLifecycleActive(input.itemId);
        if (input.role === 'worker') this.assertControlAction(input.itemId, 'new_worker_dispatch');
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
        const setup = TelosWorkRoleSetupRequestIntentSchema.parse({
          actorId,
          input,
          allocationOperationId: randomUUID(),
        });
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
    return this.completeRoleSetupRequest(
      TelosWorkRoleSetupIntentSchema.parse(setup),
      conversationId,
      actor,
      assertBeforeApply,
    );
  }
  completeOrdinaryRoleSetup(
    setup: TelosOrdinaryWorkRoleSetupIntent,
    conversationId: string,
    actor: TelosWorkActor,
    assertBeforeApply: () => void,
  ): TelosWorkCommandReceipt {
    return this.completeRoleSetupRequest(
      TelosOrdinaryWorkRoleSetupIntentSchema.parse(setup),
      conversationId,
      actor,
      assertBeforeApply,
    );
  }
  private completeRoleSetupRequest(
    setup: TelosWorkRoleSetupRequestIntent,
    conversationId: string,
    actor: TelosWorkActor,
    assertBeforeApply: () => void,
  ): TelosWorkCommandReceipt {
    this.operator(actor);
    return this.db
      .transaction(() => {
        const retained = this.prepareRoleSetupRequest(setup.input, actor);
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
  private assignmentReadHistory(
    itemId: string,
    links: TelosWorkSessionLink[],
    assignments: TelosWorkAssignment[],
  ): TelosWorkAssignmentHistory {
    const history = {
      lead: new Map<number, TelosWorkAssignment | null>(),
      worker: new Map<number, TelosWorkAssignment | null>(),
    };
    const linked = { lead: new Set<string>(), worker: new Set<string>() };
    for (const link of links)
      if (
        (link.role === 'lead' || link.role === 'worker') &&
        link.conversation.namespace === 'mitzo'
      )
        linked[link.role].add(link.conversation.conversationId);
    const incomplete = { lead: false, worker: false };
    for (const row of this.db
      .prepare('SELECT data FROM telos_work_assignment_history WHERE item_id=?')
      .all(itemId) as JsonRow[]) {
      let parsed: ReturnType<typeof TelosWorkAssignmentSchema.safeParse>;
      try {
        parsed = TelosWorkAssignmentSchema.safeParse(JSON.parse(row.data));
      } catch {
        incomplete.lead = incomplete.worker = true;
        continue;
      }
      if (!parsed.success || parsed.data.itemId !== itemId || parsed.data.revision < 1) {
        incomplete.lead = incomplete.worker = true;
        continue;
      }
      const entry = parsed.data;
      if (!linked[entry.role].has(entry.conversation.conversationId)) incomplete[entry.role] = true;
      // Private/unlinked facts still participate in ambiguity detection. Redact
      // disclosed identities only after conflicting revisions are withheld.
      const entries = history[entry.role];
      if (entries.has(entry.revision) && !isDeepStrictEqual(entries.get(entry.revision), entry)) {
        entries.set(entry.revision, null);
        incomplete[entry.role] = true;
      } else if (!entries.has(entry.revision)) entries.set(entry.revision, entry);
    }
    const project = (role: 'lead' | 'worker') => {
      const current = assignments.find((entry) => entry.role === role);
      const entries = history[role];
      const complete =
        !incomplete[role] &&
        (current
          ? current.revision > 0 &&
            entries.size === current.revision &&
            [...entries.keys()].every((revision) => revision <= current.revision) &&
            isDeepStrictEqual(entries.get(current.revision), current)
          : entries.size === 0);
      return {
        complete,
        conversationIds: [
          ...new Set(
            [...entries.values()].flatMap((entry) =>
              entry && linked[role].has(entry.conversation.conversationId)
                ? [entry.conversation.conversationId]
                : [],
            ),
          ),
        ].sort(),
      };
    };
    return { lead: project('lead'), worker: project('worker') };
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
    // Presentation-only history does not revise work tokens or rewrite cached receipts.
    return TelosWorkViewSchema.parse({
      ...facts,
      revision: (() => {
        const lifecycle = this.lifecycle()
          .revisionFacts(itemId)
          .filter((entry) => entry.state.generation > 0);
        return hash(lifecycle.length ? [row, facts, lifecycle] : [row, facts]);
      })(),
      assignmentHistory: this.assignmentReadHistory(itemId, links, assignments),
    });
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
  /** Canonical collection: one authority check, connection and committed snapshot.
   * Never reconstruct an ID from a mutable title or require a source row. */
  readCollection(rawView: unknown, actor: TelosWorkActor) {
    this.operator(actor);
    const view = TelosWorkLifecycleListSchema.parse(rawView);
    return this.db.transaction(() => {
      const items = this.db
        .prepare('SELECT * FROM items ORDER BY rowid LIMIT 5001')
        .all() as Item[];
      if (items.length > 5000) conflict('Telos collection exceeds bounded selection');
      return projectTelosCollection(
        this.db,
        items,
        this.lifecycleVisibilityForCanonicalList(items.map((row) => row.id)),
        view,
      );
    })();
  }
  readBacklogGuarded<T>(read: () => T, assertion: () => void): T {
    const check = () => {
      const result: unknown = assertion();
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
        throw Error('Synchronous Telos authority required');
      }
    };
    return this.db.transaction(() => {
      check();
      const result = read();
      check();
      return result;
    })();
  }
  /** One connection and snapshot for collection hydration; failures stay per item. */
  readRecords(raw: unknown, actor: TelosWorkActor): TelosRecordsResult {
    if (actor.kind !== 'operator' || !actor.id.trim())
      throw new TelosWorkError('unauthorized', 'Interactive operator required');
    const { itemIds } = TelosRecordsInputSchema.parse({ itemIds: raw });
    return this.db.transaction(() => {
      const result: TelosRecordsResult = { records: [], failures: [] };
      for (const itemId of new Set(itemIds)) {
        try {
          result.records.push(this.readRecord(itemId, actor));
        } catch (error) {
          const missing = error instanceof TelosWorkError && error.code === 'not_found';
          result.failures.push({
            itemId,
            code: missing ? 'not_found' : 'record_read_failed',
            status: missing ? 404 : 503,
          });
        }
      }
      return result;
    })();
  }
  /** Bounded keyset discovery without loading briefs, artifacts or role histories.
   * A sparse lifecycle view may return an empty page with a continuation cursor. */
  listItems(raw: unknown, actor: TelosWorkActor) {
    if (actor.kind !== 'operator' || !actor.id.trim())
      throw new TelosWorkError('unauthorized', 'Interactive operator required');
    const input = TelosListItemsInputSchema.parse(raw);
    return this.db.transaction(() => {
      const conditions = ['id > ?'];
      const values: Array<string | null> = [input.cursor ?? ''];
      if (input.query) {
        conditions.push(
          `(
            instr(lower(coalesce(summary,'') || ' ' || coalesce(intent,'') || ' ' || coalesce(rationale,'')),lower(?)) > 0
            OR EXISTS (
              SELECT 1 FROM json_each(CASE WHEN json_valid(items.acceptance_criteria) THEN items.acceptance_criteria ELSE '[]' END) AS criterion
              WHERE criterion.type='text' AND instr(lower(criterion.value),lower(?)) > 0
            )
          )`,
        );
        values.push(input.query, input.query);
      }
      if (input.status) {
        conditions.push('status=?');
        values.push(input.status);
      }
      if (input.parentId !== undefined) {
        conditions.push('parent_id IS ?');
        values.push(input.parentId);
      }
      const rows = this.db
        .prepare(
          `SELECT id,substr(summary,1,240) AS summary,length(summary)>240 AS summaryTruncated,status,parent_id AS parentId,updated_at AS updatedAt FROM items WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT 501`,
        )
        .all(...values) as Array<{
        id: string;
        summary: string;
        summaryTruncated: number;
        status: string;
        parentId: string | null;
        updatedAt: string | null;
      }>;
      const scanned = rows.slice(0, 500);
      const visibility = new Map(
        this.lifecycleVisibilityForCanonicalList(scanned.map((r) => r.id)).map((r) => [
          r.itemId,
          r.effectiveDisposition,
        ]),
      );
      const selected = scanned.flatMap((row) => {
        const effectiveDisposition = visibility.get(row.id);
        if (
          !effectiveDisposition ||
          (input.view !== 'all' &&
            effectiveDisposition !==
              { active: 'active', archive: 'archived', trash: 'trashed' }[input.view])
        )
          return [];
        return [{ ...row, summaryTruncated: row.summaryTruncated === 1, effectiveDisposition }];
      });
      const items = selected.slice(0, input.limit);
      const nextCursor =
        selected.length > input.limit
          ? items.at(-1)!.id
          : rows.length > 500
            ? scanned.at(-1)!.id
            : null;
      return TelosListItemsResultSchema.parse({ items, nextCursor });
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
        this.assertLifecycleActive(input.itemId);
        if (input.operation === 'reparent' && input.parentId !== null)
          this.assertLifecycleActive(input.parentId);
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
  assertDelegationAuthority(intent: TelosWorkDelegationRequestIntent, actor: TelosWorkActor) {
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
    if (!receipt) {
      this.assertLifecycleActive(input.childItemId);
      this.assertControlAction(input.leadItemId, 'new_worker_dispatch');
      for (const pin of intent.recordRevisions) {
        if (hash(this.item(pin.itemId)) !== pin.sha256)
          conflict('Reviewed delegation context changed');
      }
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
    if (!row) return null;
    const intent = TelosWorkDelegationRequestIntentSchema.parse(JSON.parse(row.intent));
    return 'version' in intent.input ? null : TelosLegacyWorkDelegationIntentSchema.parse(intent);
  }
  ordinaryDelegationRequestForHost(
    requestId: string,
    actor: TelosWorkActor,
  ): TelosOrdinaryWorkDelegationIntent | null {
    const row = this.db
      .prepare(
        'SELECT intent FROM telos_work_delegation_requests WHERE actor_id=? AND request_id=?',
      )
      .get(`${actor.kind}:${actor.id}`, requestId) as { intent: string } | undefined;
    if (!row) return null;
    const intent = TelosWorkDelegationRequestIntentSchema.parse(JSON.parse(row.intent));
    return 'version' in intent.input ? TelosOrdinaryWorkDelegationIntentSchema.parse(intent) : null;
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
    if (!row) return null;
    const intent = TelosWorkDelegationRequestIntentSchema.parse(JSON.parse(row.intent));
    return 'version' in intent.input ? null : TelosLegacyWorkDelegationIntentSchema.parse(intent);
  }
  latestOrdinaryDelegationForHost(childItemId: string): TelosOrdinaryWorkDelegationIntent | null {
    const row = this.db
      .prepare(
        'SELECT d.intent FROM telos_work_attempts a JOIN telos_work_delegation_requests d ON d.attempt_id=a.attempt_id WHERE a.item_id=? ORDER BY a.seq DESC LIMIT 1',
      )
      .get(childItemId) as { intent: string } | undefined;
    if (!row) return null;
    const intent = TelosWorkDelegationRequestIntentSchema.parse(JSON.parse(row.intent));
    return 'version' in intent.input ? TelosOrdinaryWorkDelegationIntentSchema.parse(intent) : null;
  }
  prepareDelegation(
    raw: unknown,
    actor: TelosWorkActor,
    assertBeforeApply: (intent: TelosWorkDelegationIntent) => void = () => {},
    capturePresentation?: (intent: TelosWorkDelegationIntent) => TelosWorkRolePresentation,
  ): { intent: TelosWorkDelegationIntent; receipt: TelosWorkDelegationReceipt | null } {
    const result = this.prepareDelegationRequest(
      TelosWorkDelegationInputSchema.parse(raw),
      actor,
      (intent) => assertBeforeApply(TelosLegacyWorkDelegationIntentSchema.parse(intent)),
      capturePresentation
        ? (intent) => capturePresentation(TelosLegacyWorkDelegationIntentSchema.parse(intent))
        : undefined,
    );
    return { ...result, intent: TelosLegacyWorkDelegationIntentSchema.parse(result.intent) };
  }
  prepareOrdinaryDelegation(
    raw: unknown,
    actor: TelosWorkActor,
    assertBeforeApply: (intent: TelosOrdinaryWorkDelegationIntent) => void = () => {},
    capturePresentation?: (intent: TelosOrdinaryWorkDelegationIntent) => TelosWorkRolePresentation,
  ): { intent: TelosOrdinaryWorkDelegationIntent; receipt: TelosWorkDelegationReceipt | null } {
    const result = this.prepareDelegationRequest(
      TelosOrdinaryWorkDelegationInputSchema.parse(raw),
      actor,
      (intent) => assertBeforeApply(TelosOrdinaryWorkDelegationIntentSchema.parse(intent)),
      capturePresentation
        ? (intent) => capturePresentation(TelosOrdinaryWorkDelegationIntentSchema.parse(intent))
        : undefined,
    );
    return { ...result, intent: TelosOrdinaryWorkDelegationIntentSchema.parse(result.intent) };
  }
  private prepareDelegationRequest(
    input: TelosWorkDelegationRequest,
    actor: TelosWorkActor,
    assertBeforeApply: (intent: TelosWorkDelegationRequestIntent) => void,
    capturePresentation?: (intent: TelosWorkDelegationRequestIntent) => TelosWorkRolePresentation,
  ): { intent: TelosWorkDelegationRequestIntent; receipt: TelosWorkDelegationReceipt | null } {
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
          const intent = TelosWorkDelegationRequestIntentSchema.parse(JSON.parse(saved.intent));
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
          const intent = TelosWorkDelegationRequestIntentSchema.parse(JSON.parse(retained.intent));
          if (
            'version' in intent.input !== 'version' in input ||
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
        const intent = TelosWorkDelegationRequestIntentSchema.parse({
          actorId,
          input,
          attemptId: randomUUID(),
          allocationOperationId: randomUUID(),
          contextSnapshotId,
          recordRevisions: [...itemIds].map((itemId) => ({
            itemId,
            sha256: hash(this.item(itemId)),
          })),
        });
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
    intent: TelosWorkDelegationRequestIntent,
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
    intent: TelosWorkDelegationRequestIntent,
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
        if (saved.receipt) {
          const receipt = TelosWorkDelegationReceiptSchema.parse(JSON.parse(saved.receipt));
          if (
            receipt.workerConversationId !== result.workerConversationId ||
            receipt.attempt.executionTaskId !== result.executionTaskId ||
            !verify()
          )
            invalid('Verified original ordinary allocation and execution task required');
          return receipt;
        }
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
    requireCurrentAuthority = false,
  ): TelosWorkAttempt | null {
    const row = this.db
      .prepare(
        "SELECT data FROM telos_work_attempts WHERE json_extract(data,'$.executionTaskId')=? AND json_extract(data,'$.workerConversationId')=?",
      )
      .get(executionTaskId, workerConversationId) as JsonRow | undefined;
    const attempt = row ? TelosWorkAttemptSchema.parse(JSON.parse(row.data)) : null;
    if (attempt && requireCurrentAuthority) {
      const child = this.snapshot(attempt.childItemId);
      const assigned = child.assignments.find((assignment) => assignment.role === 'worker');
      const latest = child.attempts.at(-1);
      if (
        !this.policy.ordinaryConversation(workerConversationId) ||
        latest?.attemptId !== attempt.attemptId ||
        (assigned && assigned.conversation.conversationId !== workerConversationId)
      )
        throw new TelosWorkError('unauthorized', 'Worker execution authority has been superseded');
    }
    return attempt;
  }
  /** New-command/physical-dispatch fence only. Running output callbacks retain
   * their original reviewed context. A scope change requires an explicit newly
   * reviewed retry; neither this guard nor a source save can rewrite a packet. */
  assertExecutionBriefCurrent(executionTaskId: string, workerConversationId: string): void {
    this.db.transaction(() => {
      const attempt = this.executionTaskBinding(executionTaskId, workerConversationId, true);
      if (!attempt) throw new TelosWorkError('unauthorized', 'Exact delegated worker required');
      this.assertLifecycleActive(attempt.childItemId);
      const row = this.db
        .prepare('SELECT intent FROM telos_work_delegation_requests WHERE attempt_id=? LIMIT 1')
        .get(attempt.attemptId) as { intent: string } | undefined;
      if (!row) conflict('Reviewed execution context unavailable');
      const intent = JSON.parse(row.intent) as TelosWorkDelegationIntent;
      for (const pin of intent.recordRevisions)
        if (hash(this.item(pin.itemId)) !== pin.sha256)
          conflict(
            'Reviewed execution context changed; explicitly review and adopt a new worker attempt',
          );
    })();
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

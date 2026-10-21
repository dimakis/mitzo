import type Database from 'better-sqlite3';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import {
  TelosWorkIdSchema,
  TelosWorkControlRequestSchema,
  TelosWorkControlAcknowledgementSchema,
  TelosWorkControlReleaseSchema,
  TelosWorkControlViewSchema,
  type TelosWorkControlView,
  type TelosWorkControlScope,
  type TelosWorkView,
} from '@mitzo/protocol';
import { TelosWorkError, type TelosWorkActor } from './telos-work-store.js';
interface Control {
  controlId: string;
  input: ReturnType<typeof TelosWorkControlRequestSchema.parse>;
  coordinatorConversationId: string | null;
  operatorPause?: true;
  released: boolean;
}
type Evidence = TelosWorkControlView['history'][number];
const appliedProof = z.strictObject({
  controlId: TelosWorkIdSchema,
  itemId: TelosWorkIdSchema,
  conversationId: TelosWorkIdSchema,
  assignmentRevision: z.number().int().nonnegative().safe(),
  evidenceRef: TelosWorkIdSchema,
});
const revalidationProof = z.strictObject({
  controlId: TelosWorkIdSchema,
  itemId: TelosWorkIdSchema,
  mainCommit: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/),
  evidenceRef: TelosWorkIdSchema,
});
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const denied = (message: string): never => {
  throw new TelosWorkError('unauthorized', message);
};
const conflict = (message: string): never => {
  throw new TelosWorkError('conflict', message);
};
/** Durable controls in the existing Telos owner. No scheduler, provider, interrupt
 * or message engine. Ordinary admission/publication owners enforce each scope. */
export class TelosWorkControls {
  constructor(
    private readonly db: Database.Database,
    private readonly work: (id: string) => TelosWorkView,
    private readonly available: (id: string) => boolean,
  ) {}
  private load(id: string): Control {
    const row = this.db
      .prepare('SELECT data FROM telos_work_controls WHERE control_id=?')
      .get(id) as { data: string } | undefined;
    if (!row) throw new TelosWorkError('not_found', 'Work control not found');
    return JSON.parse(row.data) as Control;
  }
  private coordinator(itemId: string, actor: TelosWorkActor) {
    const work = this.work(itemId);
    const lead = work.assignments.find((a) => a.role === 'lead');
    if (
      work.kind !== 'coordinator' ||
      !lead ||
      !this.available(lead.conversation.conversationId) ||
      !actor.id.trim() ||
      (actor.kind === 'conversation' && actor.id !== lead.conversation.conversationId)
    )
      denied('Current coordinator authority required');
    return lead!;
  }
  private replay<T>(actor: TelosWorkActor, requestId: string, input: unknown, apply: () => T): T {
    const key = `${actor.kind}:${actor.id}`;
    const fingerprint = digest(input);
    const row = this.db
      .prepare(
        'SELECT fingerprint,receipt FROM telos_work_control_commands WHERE actor_id=? AND request_id=?',
      )
      .get(key, requestId) as { fingerprint: string; receipt: string } | undefined;
    if (row) {
      if (row.fingerprint !== fingerprint)
        conflict('Control request identity reused with different input');
      return JSON.parse(row.receipt) as T;
    }
    const result = apply();
    this.db
      .prepare('INSERT INTO telos_work_control_commands VALUES(?,?,?,?)')
      .run(key, requestId, fingerprint, JSON.stringify(result));
    return result;
  }
  private descendants(root: string) {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE tree(id) AS (SELECT id FROM items WHERE id=? UNION SELECT i.id FROM items i JOIN tree t ON i.parent_id=t.id) SELECT id FROM tree LIMIT 1001`,
      )
      .all(root) as { id: string }[];
    if (!rows.length || rows.length > 1000) denied('Control tree unavailable or too large');
    return rows.map((row) => this.work(row.id));
  }
  private attached(c: Control, itemId?: string) {
    const roots =
      itemId === undefined
        ? c.input.targetItemIds
        : c.input.targetItemIds.filter((id) =>
            this.descendants(id).some((w) => w.itemId === itemId),
          );
    if (!roots.length) denied('Control recipient is not in an exact attached outcome');
    for (const id of roots) {
      const target = this.work(id);
      if (c.operatorPause && id === c.input.coordinatorItemId) continue;
      if (
        target.parentId !== c.input.coordinatorItemId ||
        !['outcome', 'coordinator'].includes(target.kind ?? '')
      )
        conflict('Control target is no longer an exact attached outcome');
    }
  }
  private rootAttached(c: Control, root: string): boolean {
    return c.operatorPause
      ? root === c.input.coordinatorItemId
      : this.work(root).parentId === c.input.coordinatorItemId;
  }
  private history(id: string): Evidence[] {
    return (
      this.db
        .prepare('SELECT data FROM telos_work_control_evidence WHERE control_id=? ORDER BY seq')
        .all(id) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as Evidence);
  }
  private project(c: Control): TelosWorkControlView {
    const history = this.history(c.controlId);
    const stage = (
      itemId: string,
      conversationId: string | null,
      assignmentRevision: number,
      role: 'lead' | 'worker',
    ) =>
      history
        .filter(
          (e) =>
            e.itemId === itemId &&
            e.conversationId === conversationId &&
            e.assignmentRevision === assignmentRevision &&
            e.role === role,
        )
        .some((e) => e.stage === 'applied')
        ? ('applied' as const)
        : history.some(
              (e) =>
                e.itemId === itemId &&
                e.conversationId === conversationId &&
                e.assignmentRevision === assignmentRevision &&
                e.role === role,
            )
          ? ('acknowledged' as const)
          : ('requested' as const);
    const targets = c.input.targetItemIds.flatMap((root) => {
      if (!this.rootAttached(c, root))
        return [
          {
            itemId: root,
            leadConversationId: null,
            assignmentRevision: 0,
            stage: 'requested' as const,
            workers: [],
          },
        ];
      return this.descendants(root)
        .filter((w) => w.kind !== 'work_item')
        .map((w) => {
          const lead = w.assignments.find((a) => a.role === 'lead');
          const leadId =
            lead && this.available(lead.conversation.conversationId)
              ? lead.conversation.conversationId
              : null;
          const workers = this.descendants(w.itemId)
            .filter((child) => child.kind === 'work_item' && child.parentId === w.itemId)
            .map((child) => {
              const assignment = child.assignments.find((a) => a.role === 'worker');
              const latest = child.attempts.at(-1);
              const id =
                assignment?.conversation.conversationId ?? latest?.workerConversationId ?? null;
              const conversationId = id && this.available(id) ? id : null;
              const revision = assignment?.revision ?? 0;
              return {
                itemId: child.itemId,
                conversationId,
                assignmentRevision: revision,
                stage: stage(child.itemId, conversationId, revision, 'worker'),
              };
            });
          const ownStage = stage(w.itemId, leadId, lead?.revision ?? 0, 'lead');
          return {
            itemId: w.itemId,
            leadConversationId: leadId,
            assignmentRevision: lead?.revision ?? 0,
            stage:
              ownStage === 'applied' && workers.some((worker) => worker.stage !== 'applied')
                ? ('acknowledged' as const)
                : ownStage,
            workers,
          };
        });
    });
    for (const target of targets) {
      if (target.stage !== 'applied') continue;
      const descendants = new Set(this.descendants(target.itemId).map((w) => w.itemId));
      if (
        targets.some(
          (other) =>
            other.itemId !== target.itemId &&
            descendants.has(other.itemId) &&
            other.stage !== 'applied',
        )
      )
        target.stage = 'acknowledged';
    }
    return TelosWorkControlViewSchema.parse({
      version: 1,
      controlId: c.controlId,
      coordinatorItemId: c.input.coordinatorItemId,
      coordinatorConversationId: c.coordinatorConversationId,
      priorityItemId: c.operatorPause ? null : c.input.priorityItemId,
      ...(c.operatorPause ? { origin: 'operator_pause' } : {}),
      scope: c.input.scope,
      stage: c.released
        ? 'released'
        : targets.length && targets.every((t) => t.stage === 'applied')
          ? 'applied'
          : targets.length && targets.every((t) => t.stage !== 'requested')
            ? 'acknowledged'
            : 'requested',
      publicationRevalidation:
        c.released && c.input.scope === 'publication' ? 'required' : 'not_applicable',
      targets,
      history,
    });
  }
  read(id: string, actor: TelosWorkActor): TelosWorkControlView {
    return this.db.transaction(() => {
      const c = this.load(id);
      const view = this.project(c);
      if (actor.kind === 'operator' && actor.id.trim()) return view;
      const coordinator = this.work(c.input.coordinatorItemId).assignments.find(
        (a) => a.role === 'lead',
      );
      if (
        actor.kind === 'conversation' &&
        this.available(actor.id) &&
        !c.operatorPause &&
        coordinator?.conversation.conversationId === actor.id
      ) {
        this.attached(c);
        return view;
      }
      const targets = view.targets.filter(
        (t) =>
          t.leadConversationId === actor.id || t.workers.some((w) => w.conversationId === actor.id),
      );
      if (!targets.length || actor.kind !== 'conversation' || !this.available(actor.id))
        denied('Conversation is not authorized for this control');
      return {
        ...view,
        targets: targets.map((t) =>
          t.leadConversationId === actor.id
            ? t
            : { ...t, workers: t.workers.filter((w) => w.conversationId === actor.id) },
        ),
        history: view.history.filter((h) => h.conversationId === actor.id),
      };
    })();
  }
  inbox(itemId: string, actor: TelosWorkActor): TelosWorkControlView[] {
    return this.db.transaction(() => {
      const item = this.work(itemId);
      if (actor.kind !== 'operator' || !actor.id.trim()) {
        const current = item.assignments.some((a) => a.conversation.conversationId === actor.id);
        const worker =
          item.attempts.at(-1)?.workerConversationId === actor.id &&
          !item.assignments.some(
            (a) => a.role === 'worker' && a.conversation.conversationId !== actor.id,
          );
        if (actor.kind !== 'conversation' || !this.available(actor.id) || (!current && !worker))
          denied('Current linked recipient required; conversation is not authorized');
      }
      const rows = this.db
        .prepare('SELECT control_id,data FROM telos_work_controls ORDER BY rowid')
        .all() as { control_id: string; data: string }[];
      return rows
        .filter((row) => {
          const c = JSON.parse(row.data) as Control;
          return (
            c.input.coordinatorItemId === itemId ||
            c.input.targetItemIds.some((id) =>
              this.descendants(id).some((w) => w.itemId === itemId),
            )
          );
        })
        .map((row) => this.read(row.control_id, actor));
    })();
  }
  request(raw: unknown, actor: TelosWorkActor): TelosWorkControlView {
    const input = TelosWorkControlRequestSchema.parse(raw);
    return this.db
      .transaction(() => {
        const lead = this.coordinator(input.coordinatorItemId, actor);
        return this.replay(actor, input.requestId, { operation: 'request', input }, () => {
          if (
            new Set(input.targetItemIds).size !== input.targetItemIds.length ||
            input.targetItemIds.includes(input.priorityItemId)
          )
            conflict('Control targets must be distinct from the priority outcome');
          const priority = this.work(input.priorityItemId);
          if (
            priority.parentId !== input.coordinatorItemId ||
            !['outcome', 'coordinator'].includes(priority.kind ?? '')
          )
            denied('Priority must be an exact attached outcome');
          const c: Control = {
            controlId: randomUUID(),
            input,
            coordinatorConversationId: lead.conversation.conversationId,
            released: false,
          };
          this.attached(c);
          // Read the full bounded tree before committing any control.
          const view = this.project(c);
          this.db
            .prepare('INSERT INTO telos_work_controls VALUES(?,?,?)')
            .run(c.controlId, input.coordinatorItemId, JSON.stringify(c));
          return view;
        });
      })
      .immediate();
  }
  /** Called only by the operator lifecycle transaction. There is no manufactured
   * coordinator, priority choice, recipient ACK or applied safe-point receipt. */
  requestOperatorPause(
    itemId: string,
    requestId: string,
    scope: TelosWorkControlScope,
    actor: TelosWorkActor,
  ): TelosWorkControlView {
    if (actor.kind !== 'operator' || !actor.id.trim()) denied('Interactive operator required');
    if (this.work(itemId).kind === 'work_item') conflict('Pause selects an outcome or coordinator');
    const c: Control = {
      controlId: randomUUID(),
      input: {
        requestId,
        coordinatorItemId: itemId,
        priorityItemId: itemId,
        targetItemIds: [itemId],
        scope,
      },
      coordinatorConversationId: null,
      operatorPause: true,
      released: false,
    };
    const view = this.project(c);
    this.db
      .prepare('INSERT INTO telos_work_controls VALUES(?,?,?)')
      .run(c.controlId, itemId, JSON.stringify(c));
    return view;
  }
  acknowledge(raw: unknown, actor: TelosWorkActor): TelosWorkControlView {
    const input = TelosWorkControlAcknowledgementSchema.parse(raw);
    return this.db
      .transaction(() => {
        const c = this.load(input.controlId);
        this.attached(c, input.itemId);
        if (c.released) conflict('Control has been released; late acknowledgement rejected');
        const view = this.project(c);
        const target = view.targets.find((t) => t.itemId === input.itemId);
        const worker = view.targets
          .flatMap((t) => t.workers)
          .find((w) => w.itemId === input.itemId);
        const id = target?.leadConversationId ?? worker?.conversationId;
        const revision = target?.assignmentRevision ?? worker?.assignmentRevision;
        if (actor.kind !== 'conversation' || actor.id !== id || !this.available(actor.id))
          denied('Current control recipient required');
        if (revision !== input.assignmentRevision) conflict('Current assignment revision required');
        this.replay(actor, input.requestId, { operation: 'acknowledge', input }, () => {
          const event: Evidence = {
            eventId: randomUUID(),
            itemId: input.itemId,
            role: target ? 'lead' : 'worker',
            conversationId: actor.id,
            assignmentRevision: input.assignmentRevision,
            stage: 'acknowledged',
            evidenceRef: `ack:${actor.id}:${input.requestId}`,
          };
          this.db
            .prepare('INSERT INTO telos_work_control_evidence(control_id,data) VALUES(?,?)')
            .run(c.controlId, JSON.stringify(event));
          return this.read(c.controlId, actor);
        });
        // Reauthorize and project even old receipts saved before recipient scoping.
        // A replay must never return broader or stale assignment visibility.
        return this.read(c.controlId, actor);
      })
      .immediate();
  }
  release(raw: unknown, actor: TelosWorkActor): TelosWorkControlView {
    const input = TelosWorkControlReleaseSchema.parse(raw);
    return this.db
      .transaction(() => {
        const c = this.load(input.controlId);
        if (c.operatorPause) {
          if (actor.kind !== 'operator' || !actor.id.trim())
            denied('Interactive operator required to resume');
        } else this.coordinator(c.input.coordinatorItemId, actor);
        return this.replay(actor, input.requestId, { operation: 'release', input }, () => {
          c.released = true;
          this.db
            .prepare('UPDATE telos_work_controls SET data=? WHERE control_id=?')
            .run(JSON.stringify(c), c.controlId);
          return this.project(c);
        });
      })
      .immediate();
  }
  recordApplied(raw: unknown, verify: (proof: z.infer<typeof appliedProof>) => boolean): void {
    const proof = appliedProof.parse(raw);
    this.db
      .transaction(() => {
        const c = this.load(proof.controlId);
        this.attached(c, proof.itemId);
        if (c.released) conflict('Control already released');
        const view = this.project(c);
        const target = view.targets.find((t) => t.itemId === proof.itemId);
        const worker = view.targets
          .flatMap((t) => t.workers)
          .find((w) => w.itemId === proof.itemId);
        const id = target?.leadConversationId ?? worker?.conversationId;
        const revision = target?.assignmentRevision ?? worker?.assignmentRevision;
        if (
          id !== proof.conversationId ||
          revision !== proof.assignmentRevision ||
          !this.available(proof.conversationId)
        )
          denied('Current control recipient required');
        if (!verify(structuredClone(proof))) denied('Verified host application evidence required');
        const event: Evidence = {
          eventId: randomUUID(),
          ...proof,
          role: target ? 'lead' : 'worker',
          stage: 'applied',
        };
        // A host receipt is idempotent; it cannot label another recipient applied.
        if (
          !view.history.some(
            (e) =>
              e.stage === 'applied' &&
              e.itemId === event.itemId &&
              e.conversationId === event.conversationId &&
              e.assignmentRevision === event.assignmentRevision &&
              e.evidenceRef === event.evidenceRef,
          )
        )
          this.db
            .prepare('INSERT INTO telos_work_control_evidence(control_id,data) VALUES(?,?)')
            .run(
              c.controlId,
              JSON.stringify({
                eventId: event.eventId,
                itemId: event.itemId,
                conversationId: event.conversationId,
                assignmentRevision: event.assignmentRevision,
                evidenceRef: event.evidenceRef,
                role: event.role,
                stage: event.stage,
              }),
            );
      })
      .immediate();
  }
  recordRevalidation(
    raw: unknown,
    verify: (proof: z.infer<typeof revalidationProof>) => boolean,
  ): void {
    const proof = revalidationProof.parse(raw);
    this.db
      .transaction(() => {
        const c = this.load(proof.controlId);
        this.attached(c);
        if (
          !c.released ||
          c.input.scope !== 'publication' ||
          !c.input.targetItemIds.some((id) =>
            this.descendants(id).some((w) => w.itemId === proof.itemId),
          )
        )
          denied('Released publication control and exact item required');
        if (!verify(structuredClone(proof)))
          denied('Verified current-main revalidation evidence required');
        const workRevision = this.work(proof.itemId).revision;
        this.db
          .prepare(
            'INSERT OR IGNORE INTO telos_work_control_revalidations(control_id,item_id,main_commit,work_revision,evidence_ref) VALUES(?,?,?,?,?)',
          )
          .run(c.controlId, proof.itemId, proof.mainCommit, workRevision, proof.evidenceRef);
      })
      .immediate();
  }
  /** The ordinary host calls this at the real action boundary, outside its
   * mutation transaction. Persist denial evidence before throwing to its caller. */
  enforceAction(
    itemId: string,
    scope: TelosWorkControlScope,
    conversationId: string,
    mainCommit?: string,
  ): void {
    try {
      this.assertAction(itemId, scope, mainCommit);
    } catch (error) {
      let views: TelosWorkControlView[] = [];
      try {
        views = this.inbox(itemId, { kind: 'conversation', id: conversationId });
      } catch {
        /* Denial still holds when evidence cannot be attributed. */
      }
      for (const view of views) {
        if (view.scope !== scope || view.stage === 'released') continue;
        const target = view.targets.find(
          (t) => t.itemId === itemId && t.leadConversationId === conversationId,
        );
        const worker = view.targets
          .flatMap((t) => t.workers)
          .find((w) => w.itemId === itemId && w.conversationId === conversationId);
        const revision = target?.assignmentRevision ?? worker?.assignmentRevision;
        if (revision === undefined) continue;
        this.recordApplied(
          {
            controlId: view.controlId,
            itemId,
            conversationId,
            assignmentRevision: revision,
            evidenceRef: `host-denial:${scope}:${view.controlId}:${itemId}:${revision}`,
          },
          () => true,
        );
      }
      throw error;
    }
  }
  /** Denial-only host fence. A requested hold is already effective for admission;
   * it is never proof that a running worker has reached a safe point. */
  assertAction(itemId: string, scope: TelosWorkControlScope, mainCommit?: string): void {
    this.db.transaction(() => {
      this.work(itemId);
      const controls = this.db.prepare('SELECT data FROM telos_work_controls').all() as {
        data: string;
      }[];
      for (const row of controls) {
        const c = JSON.parse(row.data) as Control;
        if (c.input.scope !== scope) continue;
        const covered = c.input.targetItemIds.some(
          (root) =>
            this.rootAttached(c, root) && this.descendants(root).some((w) => w.itemId === itemId),
        );
        if (!covered) continue;
        if (!c.released) denied(`Scoped ${scope} hold remains requested`);
        if (
          scope === 'publication' &&
          (!mainCommit ||
            !this.db
              .prepare(
                'SELECT 1 FROM telos_work_control_revalidations WHERE control_id=? AND item_id=? AND main_commit=? AND work_revision=?',
              )
              .get(c.controlId, itemId, mainCommit, this.work(itemId).revision))
        )
          denied('Publication release requires current-main revalidation');
      }
    })();
  }
}

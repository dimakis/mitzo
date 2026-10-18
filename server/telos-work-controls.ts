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
  coordinatorConversationId: string;
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
  private attached(c: Control) {
    for (const id of c.input.targetItemIds) {
      const target = this.work(id);
      if (
        target.parentId !== c.input.coordinatorItemId ||
        !['outcome', 'coordinator'].includes(target.kind ?? '')
      )
        conflict('Control target is no longer an exact attached outcome');
    }
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
    const targets = c.input.targetItemIds.flatMap((root) =>
      this.descendants(root)
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
        }),
    );
    return TelosWorkControlViewSchema.parse({
      version: 1,
      controlId: c.controlId,
      coordinatorItemId: c.input.coordinatorItemId,
      coordinatorConversationId: c.coordinatorConversationId,
      priorityItemId: c.input.priorityItemId,
      scope: c.input.scope,
      stage: c.released ? 'released' : 'requested',
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
        coordinator?.conversation.conversationId === actor.id
      )
        return view;
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
  acknowledge(raw: unknown, actor: TelosWorkActor): TelosWorkControlView {
    const input = TelosWorkControlAcknowledgementSchema.parse(raw);
    return this.db
      .transaction(() => {
        const c = this.load(input.controlId);
        this.attached(c);
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
        return this.replay(actor, input.requestId, { operation: 'acknowledge', input }, () => {
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
          return this.project(c);
        });
      })
      .immediate();
  }
  release(raw: unknown, actor: TelosWorkActor): TelosWorkControlView {
    const input = TelosWorkControlReleaseSchema.parse(raw);
    return this.db
      .transaction(() => {
        const c = this.load(input.controlId);
        this.coordinator(c.input.coordinatorItemId, actor);
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
        this.attached(c);
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
        const covered = c.input.targetItemIds.some((root) =>
          this.descendants(root).some((w) => w.itemId === itemId),
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

import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  SessionCollaborationIdSchema,
  SessionCollaborationSchema,
  type SessionCollaboration,
} from './session-collaboration.js';
import {
  CollaborationContractError as ContractError,
  COLLABORATION_EXECUTION_DISABLED,
  CollaborationPolicyUpdateSchema,
  CollaborationPolicySchema,
  CollaborationSettingsSchema,
  CollaborationMessageInputSchema,
  CollaborationReplyInputSchema,
  CollaborationMessageSchema,
  CollaborationDeliverySchema,
  CollaborationDeliveryReceiptInputSchema,
  CollaborationSnapshotDraftSchema,
  CollaborationSnapshotSchema,
  CollaborationJoinInputSchema,
  CollaborationJoinSchema,
  CollaborationAllocationSchema,
  CollaborationEventSchema,
  CollaborationViewSchema,
  CollaborationCursorSchema,
  CollaborationBeginSchema,
  type CollaborationPolicy,
  type CollaborationSettings,
  type CollaborationDelivery,
  type CollaborationJoin,
  type CollaborationEvent,
  type CollaborationMessageSource,
} from './collaboration-conversation.js';

/** Stable key ordering makes exact semantic retries independent of JSON object key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function sha(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
interface Owners {
  membership(id: string): SessionCollaboration | null;
  setMembership(id: string, input: unknown): SessionCollaboration;
  beginMembership(id: string, sourceSessionId: string): SessionCollaboration;
  available(sessionId: string): boolean;
  settings(sessionId: string): CollaborationSettings | undefined;
  /** The ordinary first-command ledger owns this proof; never a client-provided session ID. */
  allocation(
    operationId: string,
  ): { sessionId: string; settings: CollaborationSettings } | undefined;
}
type Row = { body: string };
/** Slice-2 metadata only. Existing EventStore connection/backup owner; no dispatcher or scheduler.
 * saveSnapshot/acceptMessage/recordDelivery/recordAllocation are trusted host ports, not HTTP writes.
 */
export class CollaborationConversationStore {
  constructor(
    private readonly db: Database.Database,
    private readonly owners: Owners,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_records (
        collaboration_id TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL,
        revision INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(collaboration_id,kind,record_id,revision));
      CREATE TABLE IF NOT EXISTS collaboration_events (
        collaboration_id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(collaboration_id,sequence));
      CREATE TABLE IF NOT EXISTS collaboration_requests (
        collaboration_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        result TEXT NOT NULL, PRIMARY KEY(collaboration_id,request_id));
      CREATE INDEX IF NOT EXISTS idx_collaboration_message_heads
        ON collaboration_records(collaboration_id,record_id,revision DESC) WHERE kind='message';
    `);
  }
  private group(id: string) {
    SessionCollaborationIdSchema.parse(id);
    const group = this.owners.membership(id);
    if (!group) throw new ContractError('not_found');
    return group;
  }
  private current<T>(group: string, kind: string, key: string, schema: z.ZodType<T>): T | null {
    const row = this.db
      .prepare(
        `SELECT body FROM collaboration_records
      WHERE collaboration_id=? AND kind=? AND record_id=? ORDER BY revision DESC LIMIT 1`,
      )
      .get(group, kind, key) as Row | undefined;
    return row ? schema.parse(JSON.parse(row.body)) : null;
  }
  private recent<T>(group: string, kind: 'message' | 'join', schema: z.ZodType<T>): T[] {
    const bound =
      kind === 'message'
        ? "ORDER BY CAST(json_extract(r.body,'$.sequence') AS INTEGER) DESC LIMIT 51"
        : "AND json_extract(r.body,'$.state')<>'linked' ORDER BY r.record_id LIMIT 17";
    const rows = this.db
      .prepare(
        `SELECT r.body FROM collaboration_records r
      WHERE collaboration_id=? AND kind=? AND NOT EXISTS (SELECT 1 FROM collaboration_records n
      WHERE n.collaboration_id=r.collaboration_id AND n.kind=r.kind AND n.record_id=r.record_id AND n.revision>r.revision)
      ${bound}`,
      )
      .all(group, kind) as Row[];
    return rows.map((row) => schema.parse(JSON.parse(row.body)));
  }
  private put(group: string, kind: string, key: string, value: unknown) {
    this.db
      .prepare(
        `INSERT INTO collaboration_records SELECT ?,?,?,
      coalesce(max(revision),0)+1,? FROM collaboration_records WHERE collaboration_id=? AND kind=? AND record_id=?`,
      )
      .run(group, kind, key, JSON.stringify(value), group, kind, key);
  }
  private cursor(group: string): number {
    return (
      this.db
        .prepare(
          'SELECT coalesce(max(sequence),0) AS value FROM collaboration_events WHERE collaboration_id=?',
        )
        .get(group) as { value: number }
    ).value;
  }
  private event(group: string, change: CollaborationEvent['change']) {
    const event = CollaborationEventSchema.parse({
      version: 1,
      collaborationId: group,
      eventId: randomUUID(),
      sequence: this.cursor(group) + 1,
      change,
    });
    this.db
      .prepare('INSERT INTO collaboration_events VALUES (?,?,?)')
      .run(group, event.sequence, JSON.stringify(event));
    return event;
  }
  /** Commit the result and its retry proof in the same transaction, before any external effects. */
  private mutation<T>(
    group: string,
    requestId: string,
    input: unknown,
    schema: z.ZodType<T>,
    commit: () => T,
    requireGroup = true,
  ): T {
    return this.db
      .transaction(() => {
        SessionCollaborationIdSchema.parse(group);
        if (requireGroup) this.group(group);
        const fingerprint = sha(input);
        const receipt = this.db
          .prepare(
            'SELECT fingerprint,result FROM collaboration_requests WHERE collaboration_id=? AND request_id=?',
          )
          .get(group, requestId) as { fingerprint: string; result: string } | undefined;
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) throw new ContractError('request_conflict');
          return schema.parse(JSON.parse(receipt.result));
        }
        const result = schema.parse(commit());
        this.db
          .prepare('INSERT INTO collaboration_requests VALUES (?,?,?,?)')
          .run(group, requestId, fingerprint, JSON.stringify(result));
        return result;
      })
      .immediate();
  }
  /** First Add agent starts from one ordinary source, before any fresh session exists. */
  begin(group: string, raw: unknown) {
    const input = CollaborationBeginSchema.parse(raw);
    return this.mutation(
      group,
      input.requestId,
      { kind: 'begin', input },
      SessionCollaborationSchema,
      () => {
        if (this.owners.membership(group)) throw new ContractError('conflict');
        if (!this.owners.available(input.sessionId))
          throw new ContractError('unavailable_recipient');
        const enrolled = this.db
          .prepare(
            `SELECT 1 FROM session_collaboration_revisions r WHERE
        NOT EXISTS (SELECT 1 FROM session_collaboration_revisions n WHERE n.collaboration_id=r.collaboration_id AND n.revision>r.revision)
        AND EXISTS (SELECT 1 FROM json_each(r.participant_session_ids) WHERE value=?) LIMIT 1`,
          )
          .get(input.sessionId);
        if (enrolled) throw new ContractError('conflict');
        return this.owners.beginMembership(group, input.sessionId);
      },
      false,
    );
  }
  private membership(group: string, expected: number) {
    const current = this.group(group);
    if (current.revision !== expected) throw new ContractError('conflict');
    return current;
  }
  private requireRecipients(group: SessionCollaboration, recipients: string[]) {
    for (const id of recipients) {
      if (!group.participantSessionIds.includes(id)) throw new ContractError('unknown_recipient');
      if (!this.owners.available(id)) throw new ContractError('unavailable_recipient');
    }
  }
  private policies(group: SessionCollaboration): CollaborationPolicy[] {
    return group.participantSessionIds.map((sessionId) => {
      const policy = this.current(
        group.collaborationId,
        'policy',
        sessionId,
        CollaborationPolicySchema,
      );
      // Re-enrollment never resurrects a previously revoked reader/default-responder policy.
      const removed =
        policy &&
        this.db
          .prepare(
            `SELECT 1 FROM session_collaboration_revisions
        WHERE collaboration_id=? AND revision>? AND NOT EXISTS
        (SELECT 1 FROM json_each(participant_session_ids) WHERE value=?) LIMIT 1`,
          )
          .get(group.collaborationId, policy.membershipRevision, sessionId);
      return policy && !removed
        ? policy
        : {
            version: 1,
            sessionId,
            revision: policy?.revision ?? 0,
            membershipRevision: group.revision,
            effectiveFromSequence: 0,
            readsFutureDiscussion: false,
            repliesByDefault: false,
          };
    });
  }
  private policySequence(group: string) {
    return (
      this.db
        .prepare(
          `SELECT coalesce(max(sequence),0) AS value FROM collaboration_events
      WHERE collaboration_id=? AND json_extract(body,'$.change.kind') IN ('policy','membership')`,
        )
        .get(group) as { value: number }
    ).value;
  }
  /** Called inside the existing membership owner's immediate transaction. */
  membershipChanged(membership: SessionCollaboration): void {
    if (!this.db.inTransaction) throw new ContractError('invalid_transition');
    const previous = this.db
      .prepare(
        `SELECT participant_session_ids FROM session_collaboration_revisions
      WHERE collaboration_id=? AND revision=?`,
      )
      .get(membership.collaborationId, membership.revision - 1) as
      { participant_session_ids: string } | undefined;
    if (!previous) throw new ContractError('conflict');
    const priorIds = SessionCollaborationSchema.shape.participantSessionIds.parse(
      JSON.parse(previous.participant_session_ids),
    );
    for (const sessionId of membership.participantSessionIds) {
      if (priorIds.includes(sessionId)) continue;
      const priorPolicy = this.current(
        membership.collaborationId,
        'policy',
        sessionId,
        CollaborationPolicySchema,
      );
      const reset = CollaborationPolicySchema.parse({
        version: 1,
        sessionId,
        revision: (priorPolicy?.revision ?? 0) + 1,
        membershipRevision: membership.revision,
        effectiveFromSequence: this.cursor(membership.collaborationId) + 2,
        readsFutureDiscussion: false,
        repliesByDefault: false,
      });
      this.put(membership.collaborationId, 'policy', sessionId, reset);
    }
    this.event(membership.collaborationId, {
      kind: 'membership',
      membership,
      policies: this.policies(membership),
    });
  }
  setPolicy(group: string, raw: unknown) {
    const input = CollaborationPolicyUpdateSchema.parse(raw);
    return this.mutation(
      group,
      input.requestId,
      { kind: 'policy', input },
      CollaborationPolicySchema,
      () => {
        const current = this.membership(group, input.expectedMembershipRevision);
        this.requireRecipients(current, [input.sessionId]);
        const policy = this.current(group, 'policy', input.sessionId, CollaborationPolicySchema);
        if ((policy?.revision ?? 0) !== input.expectedRevision) throw new ContractError('conflict');
        const next = CollaborationPolicySchema.parse({
          version: 1,
          sessionId: input.sessionId,
          revision: input.expectedRevision + 1,
          membershipRevision: current.revision,
          effectiveFromSequence: this.cursor(group) + 2,
          readsFutureDiscussion: input.readsFutureDiscussion,
          repliesByDefault: input.repliesByDefault,
        });
        this.put(group, 'policy', input.sessionId, next);
        this.event(group, { kind: 'policy', policy: next });
        return next;
      },
    );
  }
  acceptMessage(group: string, raw: unknown) {
    const input = CollaborationMessageInputSchema.parse(raw);
    if (input.responders.kind === 'selected') input.responders.sessionIds.sort();
    return this.mutation(
      group,
      input.requestId,
      { kind: 'message', input },
      CollaborationMessageSchema,
      () => {
        const current = this.membership(group, input.expectedMembershipRevision);
        if (this.policySequence(group) !== input.expectedPolicySequence)
          throw new ContractError('conflict');
        const policies = this.policies(current);
        const responders = (
          input.responders.kind === 'all'
            ? [...current.participantSessionIds]
            : input.responders.kind === 'selected'
              ? input.responders.sessionIds
              : policies.filter((p) => p.repliesByDefault).map((p) => p.sessionId)
        ).sort();
        if (!responders.length) throw new ContractError('no_responders');
        const readers = [
          ...new Set([
            ...responders,
            ...policies.filter((p) => p.readsFutureDiscussion).map((p) => p.sessionId),
          ]),
        ].sort();
        this.requireRecipients(current, readers);
        const settings: Record<string, CollaborationSettings> = {};
        for (const sessionId of readers) {
          const selected = this.owners.settings(sessionId);
          if (!selected) throw new ContractError('unavailable_recipient');
          settings[sessionId] = CollaborationSettingsSchema.parse(selected);
        }
        if (input.snapshot) this.reviewedSnapshot(group, input.snapshot, Object.values(settings));
        const message = CollaborationMessageSchema.parse({
          version: 1,
          messageId: randomUUID(),
          projectionId: randomUUID(),
          sequence: this.cursor(group) + 1,
          author: 'operator',
          source: null,
          replyToDeliveryId: null,
          text: input.text,
          membershipRevision: current.revision,
          policySequence: input.expectedPolicySequence,
          policyRevisions: Object.fromEntries(policies.map((p) => [p.sessionId, p.revision])),
          responders,
          readers,
          snapshot: input.snapshot,
          settings,
          deliveries: readers.map((sessionId) => ({
            version: 1,
            deliveryId: randomUUID(),
            sessionId,
            purpose: responders.includes(sessionId) ? 'reply' : 'context',
            revision: 0,
            status: 'pending',
            commandId: null,
            reason: null,
          })),
        });
        this.put(group, 'message', message.messageId, message);
        this.event(group, { kind: 'message', message });
        return message;
      },
    );
  }
  /** Host-only receipt, never a scheduler. Unknown external outcomes remain uncertain. */
  recordDelivery(group: string, messageId: string, deliveryId: string, raw: unknown) {
    const input = CollaborationDeliveryReceiptInputSchema.parse(raw);
    return this.mutation(
      group,
      input.requestId,
      { kind: 'delivery', messageId, deliveryId, input },
      CollaborationDeliverySchema,
      () => {
        const message = this.current(group, 'message', messageId, CollaborationMessageSchema);
        const delivery = message?.deliveries.find((d) => d.deliveryId === deliveryId);
        if (!message || !delivery) throw new ContractError('not_found');
        if (delivery.revision !== input.expectedRevision) throw new ContractError('conflict');
        const transitions: Record<CollaborationDelivery['status'], string[]> = {
          pending: ['queued', 'delivered', 'failed', 'unavailable', 'uncertain'],
          queued: ['delivered', 'failed', 'unavailable', 'uncertain'],
          uncertain: ['delivered', 'failed', 'unavailable'],
          delivered: [],
          failed: [],
          unavailable: [],
        };
        if (
          !transitions[delivery.status].includes(input.status) ||
          (delivery.commandId !== null && input.commandId !== delivery.commandId) ||
          (['queued', 'delivered', 'uncertain'].includes(input.status) && !input.commandId) ||
          (['failed', 'unavailable', 'uncertain'].includes(input.status) && !input.reason)
        )
          throw new ContractError('invalid_transition');
        if (
          input.commandId &&
          this.db
            .prepare(
              `SELECT 1 FROM collaboration_records r, json_each(r.body,'$.deliveries') d
           WHERE r.kind='message' AND NOT EXISTS (
             SELECT 1 FROM collaboration_records newer WHERE newer.collaboration_id=r.collaboration_id
             AND newer.kind=r.kind AND newer.record_id=r.record_id AND newer.revision>r.revision)
           AND json_extract(d.value,'$.commandId')=?
           AND json_extract(d.value,'$.deliveryId')<>? LIMIT 1`,
            )
            .get(input.commandId, deliveryId)
        )
          throw new ContractError('reply_conflict');
        const next = CollaborationDeliverySchema.parse({
          ...delivery,
          status: input.status,
          revision: delivery.revision + 1,
          commandId: input.commandId,
          reason: input.reason,
        });
        message.deliveries = message.deliveries.map((d) =>
          d.deliveryId === deliveryId ? next : d,
        );
        this.put(group, 'message', messageId, message);
        this.event(group, { kind: 'delivery', messageId, delivery: next });
        return next;
      },
    );
  }
  /** Host-only attributed projection. The trusted source port must verify the exact ordinary
   * command/message mapping and finalized visible blocks. Attribution never dispatches or fans out.
   */
  recordReply(
    group: string,
    raw: unknown,
    readSource: (
      source: CollaborationMessageSource,
    ) => { text: string; settings: CollaborationSettings } | undefined,
  ) {
    const input = CollaborationReplyInputSchema.parse(raw);
    return this.mutation(
      group,
      input.requestId,
      { kind: 'reply', input },
      CollaborationMessageSchema,
      () => {
        // A driver may replay the same finalized message with a fresh callback receipt.
        // Its entire source identity and delivery must still match the original projection.
        const key = sha([input.source.conversationId, input.source.messageId]);
        const previous = this.current(group, 'reply-source', key, CollaborationMessageSchema);
        if (previous) {
          if (
            sha(previous.source) !== sha(input.source) ||
            previous.replyToDeliveryId !== input.deliveryId
          )
            throw new ContractError('reply_conflict');
          const origin = this.current(
            group,
            'message',
            input.messageId,
            CollaborationMessageSchema,
          );
          if (!origin?.deliveries.some((delivery) => delivery.deliveryId === input.deliveryId))
            throw new ContractError('reply_conflict');
          return previous;
        }
        const message = this.current(group, 'message', input.messageId, CollaborationMessageSchema);
        const delivery = message?.deliveries.find((row) => row.deliveryId === input.deliveryId);
        if (
          !message ||
          !delivery ||
          delivery.purpose !== 'reply' ||
          !['queued', 'uncertain', 'delivered'].includes(delivery.status) ||
          delivery.sessionId !== input.source.conversationId ||
          delivery.commandId !== input.source.commandId ||
          !message.responders.includes(delivery.sessionId)
        )
          throw new ContractError('reply_conflict');
        this.requireRecipients(this.group(group), [delivery.sessionId]);
        const verified = readSource(structuredClone(input.source));
        if (!verified) throw new ContractError('reply_unavailable');
        if (sha(verified.settings) !== sha(message.settings[delivery.sessionId]))
          throw new ContractError('reply_conflict');
        const reply = CollaborationMessageSchema.parse({
          version: 1,
          messageId: randomUUID(),
          projectionId: randomUUID(),
          sequence: this.cursor(group) + 1,
          author: { sessionId: delivery.sessionId },
          text: verified.text,
          source: input.source,
          replyToDeliveryId: delivery.deliveryId,
          membershipRevision: message.membershipRevision,
          policySequence: message.policySequence,
          policyRevisions: message.policyRevisions,
          responders: [],
          readers: [],
          settings: {},
          deliveries: [],
          snapshot: null,
        });
        this.put(group, 'message', reply.messageId, reply);
        this.put(group, 'reply-source', key, reply);
        this.event(group, { kind: 'message', message: reply });
        return reply;
      },
    );
  }
  /** Trusted source compiler only: source authorization, completeness and token estimates belong to that owner.
   * No public route accepts these bytes. Hashes are recomputed before the review object is saved.
   */
  saveSnapshot(group: string, raw: unknown) {
    const draft = structuredClone(raw) as z.infer<typeof CollaborationSnapshotDraftSchema>;
    if (Array.isArray(draft?.messages))
      for (const message of draft.messages) {
        if (Array.isArray(message.blocks))
          for (const block of message.blocks) {
            if (typeof block.content === 'string')
              block.sha256 = createHash('sha256').update(block.content).digest('hex');
          }
      }
    const input = CollaborationSnapshotDraftSchema.parse(draft);
    for (const artifact of input.artifacts) {
      if (artifact.contentBase64 === undefined) continue;
      const bytes = Buffer.from(artifact.contentBase64, 'base64');
      if (
        bytes.toString('base64') !== artifact.contentBase64 ||
        bytes.byteLength !== artifact.sizeBytes ||
        createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
      )
        throw new ContractError('snapshot_changed');
    }
    if (Buffer.byteLength(JSON.stringify(input)) > 512 * 1024)
      throw new ContractError('capacity_refused');
    return this.mutation(
      group,
      input.requestId,
      { kind: 'snapshot', input },
      CollaborationSnapshotSchema,
      () => {
        let previousSequence = -1;
        const messageIds = new Set<string>();
        for (const message of input.messages) {
          if (
            message.conversationId !== input.sourceConversationId ||
            message.sequence > input.boundary.sequence ||
            message.sequence <= previousSequence ||
            messageIds.has(message.messageId) ||
            new Set(message.blocks.map((b) => b.blockId)).size !== message.blocks.length
          )
            throw new ContractError('snapshot_changed');
          previousSequence = message.sequence;
          messageIds.add(message.messageId);
        }
        if (
          new Set(input.artifacts.map((a) => `${a.artifactId}:${a.revision}`)).size !==
          input.artifacts.length
        )
          throw new ContractError('snapshot_changed');
        if (input.summary) {
          const source = this.getSnapshot(group, input.summary.sourceSnapshotId);
          if (
            !source ||
            source.sha256 !== input.summary.sourceSha256 ||
            source.summary ||
            sha([
              source.sourceConversationId,
              source.boundary,
              source.messages,
              source.artifacts,
            ]) !==
              sha([input.sourceConversationId, input.boundary, input.messages, input.artifacts])
          )
            throw new ContractError('snapshot_changed');
        }
        const { requestId: _requestId, ...content } = input;
        const snapshot = CollaborationSnapshotSchema.parse({
          version: 1,
          snapshotId: randomUUID(),
          ...content,
          sha256: sha(content),
        });
        this.put(group, 'snapshot', snapshot.snapshotId, snapshot);
        this.event(group, { kind: 'snapshot', snapshotId: snapshot.snapshotId });
        return snapshot;
      },
    );
  }
  getSnapshot(group: string, snapshotId: string) {
    this.group(group);
    z.uuid().parse(snapshotId);
    const snapshot = this.current(group, 'snapshot', snapshotId, CollaborationSnapshotSchema);
    if (snapshot) {
      const { version: _version, snapshotId: _snapshotId, sha256, ...content } = snapshot;
      if (sha(content) !== sha256) throw new ContractError('snapshot_changed');
    }
    return snapshot;
  }
  private reviewedSnapshot(
    group: string,
    reference: { snapshotId: string; sha256: string },
    settings: CollaborationSettings[],
  ) {
    const snapshot = this.getSnapshot(group, reference.snapshotId);
    if (!snapshot || snapshot.sha256 !== reference.sha256)
      throw new ContractError('snapshot_changed');
    const { version: _version, snapshotId: _snapshotId, sha256, ...content } = snapshot;
    if (sha(content) !== sha256) throw new ContractError('snapshot_changed');
    if (snapshot.capacity.status !== 'ready') throw new ContractError('capacity_refused');
    const assessments = snapshot.capacity.assessments;
    if (
      settings.some(
        (selected) => !assessments.some((assessment) => sha(assessment.settings) === sha(selected)),
      )
    )
      throw new ContractError('capacity_refused');
    return snapshot;
  }
  prepareJoin(group: string, raw: unknown) {
    const input = CollaborationJoinInputSchema.parse(raw);
    return this.mutation(
      group,
      input.requestId,
      { kind: 'join', input },
      CollaborationJoinSchema,
      () => {
        this.membership(group, input.expectedMembershipRevision);
        this.reviewedSnapshot(group, input.snapshot, [input.settings]);
        if (this.recent(group, 'join', CollaborationJoinSchema).length >= 16)
          throw new ContractError('capacity_refused');
        const join = CollaborationJoinSchema.parse({
          version: 1,
          joinId: randomUUID(),
          name: input.name,
          membershipRevision: input.expectedMembershipRevision,
          settings: input.settings,
          snapshot: input.snapshot,
          allocationOperationId: randomUUID(),
          state: 'pending_preparation',
          sessionId: null,
          linkedFromRevision: null,
          execution: COLLABORATION_EXECUTION_DISABLED,
        });
        this.put(group, 'join', join.joinId, join);
        this.event(group, { kind: 'join', join });
        return join;
      },
    );
  }
  getJoin(group: string, joinId: string) {
    this.group(group);
    z.uuid().parse(joinId);
    return this.current(group, 'join', joinId, CollaborationJoinSchema);
  }
  recordAllocation(group: string, joinId: string, raw: unknown) {
    const input = CollaborationAllocationSchema.parse(raw);
    return this.db
      .transaction(() => {
        const join = this.getJoin(group, joinId);
        if (!join) throw new ContractError('not_found');
        if (
          join.allocationOperationId !== input.operationId ||
          sha(join.settings) !== sha(input.settings) ||
          (join.sessionId !== null && join.sessionId !== input.sessionId)
        )
          throw new ContractError('allocation_conflict');
        if (join.sessionId !== null) return join;
        const proof = this.owners.allocation(input.operationId);
        if (
          !proof ||
          proof.sessionId !== input.sessionId ||
          sha(proof.settings) !== sha(join.settings) ||
          !this.owners.available(input.sessionId) ||
          this.db
            .prepare(
              `SELECT 1 FROM session_collaboration_revisions
          WHERE EXISTS (SELECT 1 FROM json_each(participant_session_ids) WHERE value=?) LIMIT 1`,
            )
            .get(input.sessionId)
        )
          throw new ContractError('allocation_conflict');
        const next: CollaborationJoin = { ...join, state: 'allocated', sessionId: input.sessionId };
        this.put(group, 'join', joinId, next);
        this.event(group, { kind: 'join', join: next });
        return next;
      })
      .immediate();
  }
  /** Allocation receipt is committed separately first. A link conflict never reallocates. */
  linkJoin(group: string, joinId: string, expectedMembershipRevision: number) {
    z.number().int().nonnegative().safe().parse(expectedMembershipRevision);
    return this.db
      .transaction(() => {
        const join = this.getJoin(group, joinId);
        if (!join) throw new ContractError('not_found');
        if (join.state === 'linked') {
          if (join.linkedFromRevision !== expectedMembershipRevision)
            throw new ContractError('conflict');
          return join;
        }
        if (join.state !== 'allocated' || !join.sessionId)
          throw new ContractError('invalid_transition');
        const current = this.membership(group, expectedMembershipRevision);
        if (!this.owners.available(join.sessionId))
          throw new ContractError('unavailable_recipient');
        const currentSettings = this.owners.settings(join.sessionId);
        if (
          !currentSettings ||
          sha(currentSettings) !== sha(join.settings) ||
          this.db
            .prepare(
              `SELECT 1 FROM session_collaboration_revisions WHERE collaboration_id<>?
          AND EXISTS (SELECT 1 FROM json_each(participant_session_ids) WHERE value=?) LIMIT 1`,
            )
            .get(group, join.sessionId)
        )
          throw new ContractError('allocation_conflict');
        this.owners.setMembership(group, {
          expectedRevision: expectedMembershipRevision,
          participantSessionIds: [...current.participantSessionIds, join.sessionId],
        });
        const next: CollaborationJoin = {
          ...join,
          state: 'linked',
          linkedFromRevision: expectedMembershipRevision,
        };
        this.put(group, 'join', joinId, next);
        this.event(group, { kind: 'join', join: next });
        return next;
      })
      .immediate();
  }
  events(group: string, after = 0) {
    return this.db.transaction(() => {
      this.group(group);
      CollaborationCursorSchema.parse({ after });
      const highWatermark = this.cursor(group);
      if (after > highWatermark) throw new ContractError('conflict');
      const rows = this.db
        .prepare(
          'SELECT body FROM collaboration_events WHERE collaboration_id=? AND sequence>? ORDER BY sequence LIMIT 51',
        )
        .all(group, after) as Row[];
      const events = rows
        .slice(0, 50)
        .map((row) => CollaborationEventSchema.parse(JSON.parse(row.body)));
      return {
        events,
        cursor: events.at(-1)?.sequence ?? after,
        highWatermark,
        hasMore: rows.length > 50,
      };
    })();
  }
  view(group: string) {
    return this.db.transaction(() => {
      const membership = this.group(group);
      const messages = this.recent(group, 'message', CollaborationMessageSchema).sort(
        (a, b) => a.sequence - b.sequence,
      );
      return CollaborationViewSchema.parse({
        version: 1,
        collaborationId: group,
        membershipRevision: membership.revision,
        participantSessionIds: membership.participantSessionIds,
        unavailableParticipantSessionIds: membership.participantSessionIds.filter(
          (id) => !this.owners.available(id),
        ),
        cursor: this.cursor(group),
        policySequence: this.policySequence(group),
        policies: this.policies(membership),
        messages: messages.slice(-50),
        hasEarlierMessages: messages.length > 50,
        joins: this.recent(group, 'join', CollaborationJoinSchema),
        execution: COLLABORATION_EXECUTION_DISABLED,
      });
    })();
  }
}

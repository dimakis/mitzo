import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import {
  TelosSourcePreviewRequestSchema,
  TelosSourceAdoptRequestSchema,
  TelosSourcePacketSchema,
  TelosSourcePreviewSchema,
  TelosReviewedSourceViewSchema,
  TelosSourceNewPreviewRequestSchema,
  TelosSourceCreateRequestSchema,
  TelosOutcomeContextHintsSchema,
  type CollaborationSnapshotSelection,
  type TelosOutcomeCreation,
  type TelosSourcePreview,
  type TelosWorkCommandReceipt,
  type TelosSourcePacket,
  type TelosOutcomeProposal,
  TelosWorkAdvisorDraftPreviewRequestSchema,
  type TelosWorkAdvisorDraftPreviewRequest,
  type TelosWorkSourceSnapshot,
} from '@mitzo/protocol';
import { compileCollaborationSourceContext } from './collaboration-context-compiler.js';
import { createTelosConversationSource } from './telos-conversation-source.js';
import { TelosWorkError, type TelosWorkStore, type TelosWorkActor } from './telos-work-store.js';
import type { EventStore } from './event-store.js';
import {
  MAX_TELOS_ARTIFACT_BYTES,
  type TelosArtifactStore,
  type TelosArtifactMetadata,
} from './telos-artifact-store.js';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const requestKey = (operation: string, actorId: string, requestId: string) =>
  hash(JSON.stringify([operation, actorId, requestId]));
export function advisorDraftTargetId(
  input: TelosWorkAdvisorDraftPreviewRequest,
  actorId: string,
): string {
  return input.operation === 'refine'
    ? input.itemId
    : hash(JSON.stringify(['advisor-child', actorId, input.requestId])).slice(0, 16);
}
/** Shape projection only; capture and work owners retain authority and custody. */
export function telosSourceSnapshot(
  packet: TelosSourcePacket,
  artifact: TelosArtifactMetadata,
  itemId: string,
  snapshotId: string,
): TelosWorkSourceSnapshot {
  return {
    version: 1,
    snapshotId,
    itemId,
    source: { namespace: 'mitzo', conversationId: packet.context.sourceConversationId },
    selection: {
      kind: 'selected',
      messageIds: packet.context.messages.map((message) => message.messageId),
      blockIds: packet.context.messages
        .filter((message) => message.author !== 'operator')
        .flatMap((message) => message.blocks.map((block) => block.blockId)),
      throughSequence: packet.context.boundary.sequence,
    },
    adoptedBrief: { revision: packet.brief.sha256, sha256: packet.brief.sha256 },
    artifacts: [
      ...packet.context.artifacts.map(({ artifactId, revision, sha256 }) => ({
        artifactId,
        revision,
        sha256,
      })),
      { artifactId: artifact.id, revision: artifact.revision, sha256: artifact.sha256 },
    ],
    author: null,
    sourceCreatedAt: packet.sourceCreatedAt,
    adoptedAt: artifact.createdAt,
  };
}
function operator(actor: TelosWorkActor) {
  if (actor.kind !== 'operator' || !actor.id.trim())
    throw new TelosWorkError('unauthorized', 'Interactive operator authority required');
  return 'operator:' + actor.id;
}
function conflict(): never {
  throw new TelosWorkError(
    'conflict',
    'Reviewed source or work changed; review the current selection before adopting',
  );
}

/** Preview is read-only. Adoption retains a reviewed packet through the existing
 * artifact owner, then idempotently links its exact source through the work owner.
 * Artifact request receipts recover the same bytes after a cross-owner interruption;
 * work command receipts recover an already completed adoption before stale checks.
 */
export class TelosSourceCapture {
  constructor(
    private readonly options: {
      events: EventStore;
      artifacts: TelosArtifactStore;
      work: TelosWorkStore;
      /** Trusted host authority only; never deserialized from a source request. */
      assertAuthorized?(): void;
      authorizeSource(actor: TelosWorkActor, conversationId: string): boolean;
      authorizeArtifact(actor: TelosWorkActor, itemId: string): boolean;
    },
  ) {}

  private operator(actor: TelosWorkActor) {
    this.options.assertAuthorized?.();
    return operator(actor);
  }

  /** Trusted advisor owner only. Reuses the original public-source compiler;
   * the proposed brief and selected parent revisions are part of its digest. */
  async previewAdvisorDraft(raw: unknown, actor: TelosWorkActor): Promise<TelosSourcePreview> {
    const actorId = this.operator(actor);
    const input = TelosWorkAdvisorDraftPreviewRequestSchema.parse(structuredClone(raw));
    const assertCurrent = () => {
      this.operator(actor);
      const target = this.options.work.readSourceTarget(input.itemId, actor);
      if (input.operation === 'refine' && target.work.kind !== input.proposed.type)
        throw new TelosWorkError('invalid', 'Refinement cannot change item type');
      if (!this.options.artifacts.userUploadAllowed(input.itemId))
        throw new TelosWorkError('invalid', 'This item requires private case storage');
      if (
        target.work.revision !== input.expectedRevision ||
        (input.operation === 'refine' && target.record.parentId !== input.parentId)
      )
        conflict();
      if (input.parentId !== null) {
        if (!this.options.artifacts.userUploadAllowed(input.parentId))
          throw new TelosWorkError('invalid', 'This parent requires private case storage');
        if (this.options.work.read(input.parentId, actor).revision !== input.expectedParentRevision)
          conflict();
      }
    };
    assertCurrent();
    const briefText = JSON.stringify({
      operation: input.operation,
      itemId: advisorDraftTargetId(input, actorId),
      anchorItemId: input.itemId,
      parentId: input.parentId,
      expectedRevision: input.expectedRevision,
      expectedParentRevision: input.expectedParentRevision,
      proposed: input.proposed,
    });
    const preview = await this.compilePreview(input.selection, actor, {
      itemId: advisorDraftTargetId(input, actorId),
      workRevision: input.expectedRevision,
      briefText,
    });
    assertCurrent();
    return preview;
  }

  async preview(raw: unknown, actor: TelosWorkActor): Promise<TelosSourcePreview> {
    this.operator(actor);
    const input = TelosSourcePreviewRequestSchema.parse(raw);
    const target = this.options.work.readSourceTarget(input.itemId, actor);
    if (!this.options.artifacts.userUploadAllowed(input.itemId))
      throw new TelosWorkError('invalid', 'This item requires private case storage');
    const briefText = JSON.stringify({
      itemId: target.record.itemId,
      parentId: target.record.parentId,
      summary: target.record.summary,
      intent: target.record.intent,
      rationale: target.record.rationale,
      acceptanceCriteria: target.record.acceptanceCriteria,
      profile: target.record.profile,
      contextHints: target.record.contextHints,
    });
    const preview = await this.compilePreview(input.selection, actor, {
      itemId: input.itemId,
      workRevision: target.work.revision,
      briefText,
    });
    this.operator(actor);
    if (this.options.work.read(input.itemId, actor).revision !== target.work.revision) conflict();
    return preview;
  }

  private async compilePreview(
    selection: CollaborationSnapshotSelection,
    actor: TelosWorkActor,
    target: {
      itemId: string | null;
      workRevision: string;
      briefText: string;
      creation?: TelosSourcePacket['creation'];
    },
  ): Promise<TelosSourcePreview> {
    const actorId = this.operator(actor);
    const source = createTelosConversationSource({
      events: this.options.events,
      artifacts: this.options.artifacts,
      authorize: (id) => this.options.authorizeSource(actor, id),
      authorizeArtifact: (_pin, id) => this.options.authorizeArtifact(actor, id),
    });
    let opened: Awaited<ReturnType<typeof source.openConversation>> | undefined;
    const context = await compileCollaborationSourceContext(
      // There is no joining recipient in source-only capture. The complete
      // canonical brief is retained separately and bound by the packet digest.
      { ...selection, joiningBrief: '' },
      {
        ...source,
        openConversation: async (selection) => {
          opened = await source.openConversation(selection);
          return opened;
        },
      },
    );
    this.operator(actor);
    if (!context.messages.length)
      throw new TelosWorkError('invalid', 'Select at least one completed public message');
    if (!opened) conflict();
    const original = this.options.events.getSession(selection.sourceConversationId);
    const createdAt = original?.createdAt;
    const packet = TelosSourcePacketSchema.parse({
      version: 1,
      actorId,
      itemId: target.itemId,
      workRevision: target.workRevision,
      selection,
      brief: { sha256: hash(target.briefText), text: target.briefText },
      context,
      attributions: Object.fromEntries(
        [
          ...new Set([
            ...context.messages.map((message) => message.messageId),
            selection.boundary.messageId,
          ]),
        ]
          .filter((messageId): messageId is string => messageId !== null)
          .map((messageId) => [messageId, opened!.attributions[messageId]]),
      ),
      sourceTitle: original?.summary ?? null,
      sourceCreatedAt:
        typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0
          ? new Date(createdAt).toISOString()
          : null,
      ...(target.creation ? { creation: target.creation } : {}),
    });
    if (Buffer.byteLength(JSON.stringify(packet)) > MAX_TELOS_ARTIFACT_BYTES)
      throw new TelosWorkError('invalid', 'Narrow the source selection before retaining it');
    return TelosSourcePreviewSchema.parse({ sha256: hash(JSON.stringify(packet)), packet });
  }

  private creationOutcome(proposal: TelosOutcomeProposal, sourceConversationId: string) {
    if (/^life[-_ ]?ops$/i.test(proposal.profile))
      throw new TelosWorkError('invalid', 'This outcome requires private case storage');
    const links = proposal.links ?? [];
    if (
      links.some((link) => !link.url.trim()) ||
      new Set(links.map((link) => link.url.trim())).size !== links.length
    )
      throw new TelosWorkError(
        'invalid',
        'Outcome links must identify distinct non-empty references',
      );
    const hints = TelosOutcomeContextHintsSchema.parse(proposal.contextHints ?? {});
    return {
      ...proposal,
      contextHints: {
        ...hints,
        sessionIds: [...new Set([...hints.sessionIds, sourceConversationId])],
      },
    };
  }

  /** A host callback re-reads the immutable approval owner; never request JSON.
   * Canonical owners retain the original packet without consulting mutable
   * transcript bytes, while current operator/material authority is rechecked.
   */
  private preparedPreview(
    read: () => TelosSourcePreview,
    actor: TelosWorkActor,
    selection: CollaborationSnapshotSelection,
    previewSha256: string,
    itemId: string | null,
  ) {
    const preview = TelosSourcePreviewSchema.parse(read());
    const packet = preview.packet;
    const source = this.options.events.getSession(selection.sourceConversationId);
    if (
      preview.sha256 !== previewSha256 ||
      hash(JSON.stringify(packet)) !== previewSha256 ||
      packet.actorId !== this.operator(actor) ||
      packet.itemId !== itemId ||
      !isDeepStrictEqual(packet.selection, selection) ||
      packet.context.sourceConversationId !== selection.sourceConversationId ||
      !isDeepStrictEqual(packet.context.boundary, selection.boundary) ||
      packet.context.mode !== selection.mode ||
      packet.brief.sha256 !== hash(packet.brief.text) ||
      !source ||
      source.isHidden ||
      source.conversationSource === 'external_import' ||
      !this.options.authorizeSource(actor, selection.sourceConversationId)
    )
      conflict();
    for (const pin of packet.context.artifacts) {
      const saved = this.options.artifacts.read(pin.artifactId, pin.revision);
      if (!this.options.authorizeArtifact(actor, saved.itemId))
        throw new TelosWorkError('unauthorized', 'Retained material authorization changed');
      if (
        saved.sha256 !== pin.sha256 ||
        hash(saved.bytes) !== pin.sha256 ||
        (pin.contentBase64 !== undefined &&
          !saved.bytes.equals(Buffer.from(pin.contentBase64, 'base64')))
      )
        conflict();
    }
    return preview;
  }

  async previewNew(raw: unknown, actor: TelosWorkActor): Promise<TelosSourcePreview> {
    this.operator(actor);
    const input = TelosSourceNewPreviewRequestSchema.parse(raw);
    const outcome = this.creationOutcome(input.outcome, input.selection.sourceConversationId);
    const briefText = JSON.stringify(outcome);
    return this.compilePreview(input.selection, actor, {
      itemId: null,
      workRevision: hash(briefText),
      briefText,
      creation: { requestId: input.requestId, outcome },
    });
  }

  async createReviewed(
    raw: unknown,
    actor: TelosWorkActor,
    createOutcome: (body: TelosOutcomeCreation) => Promise<{ itemId: string }>,
    readPreparedPreview?: () => TelosSourcePreview,
  ): Promise<TelosWorkCommandReceipt> {
    const actorId = this.operator(actor);
    const input = TelosSourceCreateRequestSchema.parse(raw);
    const inputHash = hash(JSON.stringify(input));
    let record = this.options.work.sourceCreation(input.requestId, inputHash, actor);
    if (record?.receipt) return record.receipt;
    if (!record) {
      const preview = readPreparedPreview
        ? this.preparedPreview(
            readPreparedPreview,
            actor,
            input.selection,
            input.previewSha256,
            null,
          )
        : await this.previewNew(
            { requestId: input.requestId, outcome: input.outcome, selection: input.selection },
            actor,
          );
      if (readPreparedPreview) {
        const outcome = this.creationOutcome(input.outcome, input.selection.sourceConversationId);
        if (
          !isDeepStrictEqual(preview.packet.creation, { requestId: input.requestId, outcome }) ||
          preview.packet.brief.text !== JSON.stringify(outcome) ||
          preview.packet.workRevision !== hash(JSON.stringify(outcome))
        )
          conflict();
      }
      if (preview.sha256 !== input.previewSha256) conflict();
      this.preparedPreview(() => preview, actor, input.selection, input.previewSha256, null);
      record = this.options.work.prepareSourceCreation(
        input.requestId,
        inputHash,
        preview.packet,
        actor,
      );
    }
    const retained = { sha256: input.previewSha256, packet: record.packet };
    const assertCurrentAuthority = () =>
      this.preparedPreview(() => retained, actor, input.selection, input.previewSha256, null);
    const creation = record.packet.creation;
    if (!creation) conflict();
    if (!record.itemId) {
      assertCurrentAuthority();
      const result = await createOutcome({
        ...creation.outcome,
        idempotencyKey: record.idempotencyKey,
      });
      record = this.options.work.recordSourceCreationItem(
        input.requestId,
        inputHash,
        result.itemId,
        actor,
      );
    }
    // Retaining a returned canonical identity above is recovery bookkeeping.
    // No new source artifact or backlink may follow expired/revoked authority.
    this.operator(actor);
    if (!record.itemId || !record.itemRevision) conflict();
    const sessionId = 'source-capture:' + hash(actorId),
      requestId = requestKey('create-artifact', actorId, input.requestId);
    let artifact = this.options.artifacts.retryReceipt(sessionId, requestId, inputHash);
    if (!artifact) {
      assertCurrentAuthority();
      artifact = this.options.artifacts.save({
        itemId: record.itemId,
        filename: 'origin-' + input.previewSha256 + '.json',
        title: (
          'Original discussion · ' + (record.packet.sourceTitle ?? 'Reviewed exchange')
        ).slice(0, 200),
        bytes: Buffer.from(JSON.stringify(record.packet)),
        sessionId,
        requestId,
        requestInputHash: inputHash,
      });
    }
    const receipt = this.linkPacket(
      record.packet,
      artifact,
      {
        itemId: record.itemId,
        requestId: input.requestId,
        scope: 'create',
        expectedRevision: record.itemRevision,
      },
      actor,
      assertCurrentAuthority,
    );
    return this.options.work.completeSourceCreation(input.requestId, inputHash, receipt, actor);
  }

  async adopt(
    raw: unknown,
    actor: TelosWorkActor,
    readPreparedPreview?: () => TelosSourcePreview,
  ): Promise<TelosWorkCommandReceipt> {
    const actorId = this.operator(actor);
    const input = TelosSourceAdoptRequestSchema.parse(raw);
    const sessionId = 'source-capture:' + hash(actorId);
    const requestId = requestKey('adopt-artifact', actorId, input.requestId);
    const inputHash = hash(JSON.stringify(input));
    // Check the original request before source rereads or any mutable/current data.
    let artifact = this.options.artifacts.retryReceipt(sessionId, requestId, inputHash);
    let packet: TelosSourcePacket;
    if (artifact) {
      const bytes = this.options.artifacts.read(artifact.id, artifact.revision).bytes;
      if (hash(bytes) !== input.previewSha256) conflict();
      packet = TelosSourcePacketSchema.parse(JSON.parse(bytes.toString('utf8')));
    } else {
      const preview = readPreparedPreview
        ? this.preparedPreview(
            readPreparedPreview,
            actor,
            input.selection,
            input.previewSha256,
            input.itemId,
          )
        : await this.preview({ itemId: input.itemId, selection: input.selection }, actor);
      if (
        readPreparedPreview &&
        (preview.packet.creation !== undefined ||
          !this.options.artifacts.userUploadAllowed(input.itemId) ||
          !this.options.authorizeArtifact(actor, input.itemId) ||
          this.options.work.read(input.itemId, actor).revision !== input.expectedRevision)
      )
        conflict();
      if (
        preview.sha256 !== input.previewSha256 ||
        preview.packet.workRevision !== input.expectedRevision
      )
        conflict();
      packet = preview.packet;
      this.preparedPreview(
        () => preview,
        actor,
        input.selection,
        input.previewSha256,
        input.itemId,
      );
      artifact = this.options.artifacts.save({
        itemId: input.itemId,
        filename: 'origin-' + preview.sha256 + '.json',
        title: ('Original discussion · ' + (packet.sourceTitle ?? 'Reviewed exchange')).slice(
          0,
          200,
        ),
        bytes: Buffer.from(JSON.stringify(packet)),
        sessionId,
        requestId,
        requestInputHash: inputHash,
      });
    }
    if (
      packet.actorId !== actorId ||
      packet.itemId !== input.itemId ||
      packet.workRevision !== input.expectedRevision
    )
      conflict();
    return this.linkPacket(packet, artifact, { ...input, scope: 'adopt' }, actor, () =>
      this.preparedPreview(
        () => ({ sha256: input.previewSha256, packet }),
        actor,
        input.selection,
        input.previewSha256,
        input.itemId,
      ),
    );
  }

  private linkPacket(
    packet: TelosSourcePacket,
    artifact: TelosArtifactMetadata,
    input: {
      itemId: string;
      requestId: string;
      expectedRevision: string;
      scope: 'create' | 'adopt';
    },
    actor: TelosWorkActor,
    assertBeforeApply: () => void,
  ) {
    const actorId = this.operator(actor),
      requestId = requestKey(input.scope + '-command', actorId, input.requestId);
    return this.options.work.execute(
      {
        operation: 'source',
        itemId: input.itemId,
        requestId: 'source:' + requestId,
        expectedRevision: input.expectedRevision,
        snapshot: telosSourceSnapshot(packet, artifact, input.itemId, requestId),
      },
      actor,
      assertBeforeApply,
    );
  }

  /** Inspect the retained adoption, even if the original chat later disappears.
   * A general source link or an arbitrary artifact is never treated as this proof.
   */
  read(itemId: string, snapshotId: string, actor: TelosWorkActor) {
    this.operator(actor);
    const snapshot = this.options.work
      .read(itemId, actor)
      .sources.find((source) => source.snapshotId === snapshotId);
    return this.readRetainedSource(itemId, snapshotId, actor, snapshot, (packet) =>
      this.options.work.sourceCreationBinds(itemId, packet, actor),
    );
  }
  /** Host-scoped retained custody proof. Never opens a transcript or grants
   * source capture/adoption authority to the lead conversation. */
  readForDelegation(leadConversationId: string, childItemId: string, snapshotId: string) {
    this.options.assertAuthorized?.();
    const actor: TelosWorkActor = { kind: 'conversation', id: leadConversationId };
    const snapshot = this.options.work
      .readDelegationTarget(leadConversationId, childItemId, childItemId)
      .work.sources.find((source) => source.snapshotId === snapshotId);
    return this.readRetainedSource(childItemId, snapshotId, actor, snapshot, (packet) =>
      this.options.work.sourceCreationBindsForDelegation(leadConversationId, childItemId, packet),
    );
  }
  private readRetainedSource(
    itemId: string,
    snapshotId: string,
    actor: TelosWorkActor,
    snapshot: TelosWorkSourceSnapshot | undefined,
    creationBinds: (packet: TelosSourcePacket) => boolean,
  ) {
    if (
      !snapshot ||
      snapshot.source?.namespace !== 'mitzo' ||
      snapshot.selection.kind !== 'selected'
    )
      throw new TelosWorkError('not_found', 'Reviewed source not found');
    const pin = snapshot.artifacts.at(-1);
    if (!pin) throw new TelosWorkError('not_found', 'Reviewed source not retained');
    const artifact = this.options.artifacts.read(pin.artifactId, pin.revision);
    if (
      artifact.itemId !== itemId ||
      artifact.sourceKind !== 'source_capture' ||
      artifact.sha256 !== pin.sha256 ||
      hash(artifact.bytes) !== pin.sha256 ||
      artifact.filename !== 'origin-' + pin.sha256 + '.json'
    )
      conflict();
    const packet = TelosSourcePacketSchema.parse(JSON.parse(artifact.bytes.toString('utf8')));
    if (
      (packet.itemId === null ? !creationBinds(packet) : packet.itemId !== itemId) ||
      packet.context.sourceConversationId !== snapshot.source.conversationId ||
      packet.context.boundary.sequence !== snapshot.selection.throughSequence ||
      JSON.stringify(packet.context.messages.map((message) => message.messageId)) !==
        JSON.stringify(snapshot.selection.messageIds) ||
      packet.brief.sha256 !== snapshot.adoptedBrief?.sha256 ||
      hash(packet.brief.text) !== packet.brief.sha256
    )
      conflict();
    const blocks = packet.context.messages
      .filter((message) => message.author !== 'operator')
      .flatMap((message) => message.blocks.map((block) => block.blockId));
    const pins = [
      ...packet.context.artifacts.map(({ artifactId, revision, sha256 }) => ({
        artifactId,
        revision,
        sha256,
      })),
      pin,
    ];
    if (
      JSON.stringify(blocks) !== JSON.stringify(snapshot.selection.blockIds) ||
      JSON.stringify(pins) !== JSON.stringify(snapshot.artifacts) ||
      snapshot.adoptedBrief.revision !== packet.brief.sha256 ||
      snapshot.sourceCreatedAt !== packet.sourceCreatedAt ||
      snapshot.adoptedAt !== artifact.createdAt
    )
      conflict();
    const original = this.options.events.getSession(snapshot.source.conversationId);
    const params = new URLSearchParams({ telosItem: itemId, telosSource: snapshotId });
    return TelosReviewedSourceViewSchema.parse({
      snapshot,
      packet,
      sourceHref: '/chat/' + encodeURIComponent(snapshot.source.conversationId) + '?' + params,
      available:
        !!original &&
        !original.isHidden &&
        original.conversationSource !== 'external_import' &&
        this.options.authorizeSource(actor, snapshot.source.conversationId),
    });
  }
}

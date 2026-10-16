import { createHash } from 'node:crypto';
import {
  TelosSourcePreviewRequestSchema,
  TelosSourceAdoptRequestSchema,
  TelosSourcePacketSchema,
  TelosSourcePreviewSchema,
  TelosReviewedSourceViewSchema,
  type TelosSourcePreview,
  type TelosWorkCommandReceipt,
  type TelosSourcePacket,
} from '@mitzo/protocol';
import { compileCollaborationSourceContext } from './collaboration-context-compiler.js';
import { createTelosConversationSource } from './telos-conversation-source.js';
import { TelosWorkError, type TelosWorkStore, type TelosWorkActor } from './telos-work-store.js';
import type { EventStore } from './event-store.js';
import type { TelosArtifactStore } from './telos-artifact-store.js';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
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
      authorizeSource(actor: TelosWorkActor, conversationId: string): boolean;
      authorizeArtifact(actor: TelosWorkActor, itemId: string): boolean;
    },
  ) {}

  async preview(raw: unknown, actor: TelosWorkActor): Promise<TelosSourcePreview> {
    const actorId = operator(actor);
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
    const source = createTelosConversationSource({
      events: this.options.events,
      artifacts: this.options.artifacts,
      authorize: (id) => this.options.authorizeSource(actor, id),
      authorizeArtifact: (_pin, id) => this.options.authorizeArtifact(actor, id),
    });
    let opened: Awaited<ReturnType<typeof source.openConversation>> | undefined;
    const context = await compileCollaborationSourceContext(
      { ...input.selection, joiningBrief: briefText },
      {
        ...source,
        openConversation: async (selection) => {
          opened = await source.openConversation(selection);
          return opened;
        },
      },
    );
    if (!context.messages.length)
      throw new TelosWorkError('invalid', 'Select at least one completed public message');
    if (!opened || this.options.work.read(input.itemId, actor).revision !== target.work.revision)
      conflict();
    const original = this.options.events.getSession(input.selection.sourceConversationId);
    const createdAt = original?.createdAt;
    const packet = TelosSourcePacketSchema.parse({
      version: 1,
      actorId,
      itemId: input.itemId,
      workRevision: target.work.revision,
      selection: input.selection,
      brief: { sha256: hash(briefText), text: briefText },
      context,
      attributions: Object.fromEntries(
        context.messages.map((message) => [
          message.messageId,
          opened!.attributions[message.messageId],
        ]),
      ),
      sourceTitle: original?.summary ?? null,
      sourceCreatedAt:
        typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0
          ? new Date(createdAt).toISOString()
          : null,
    });
    return TelosSourcePreviewSchema.parse({ sha256: hash(JSON.stringify(packet)), packet });
  }

  async adopt(raw: unknown, actor: TelosWorkActor): Promise<TelosWorkCommandReceipt> {
    const actorId = operator(actor);
    const input = TelosSourceAdoptRequestSchema.parse(raw);
    const sessionId = 'source-capture:' + hash(actorId);
    const requestId = hash(actorId + ':' + input.requestId);
    const inputHash = hash(JSON.stringify(input));
    // Check the original request before source rereads or any mutable/current data.
    let artifact = this.options.artifacts.retryReceipt(sessionId, requestId, inputHash);
    let packet: TelosSourcePacket;
    if (artifact) {
      const bytes = this.options.artifacts.read(artifact.id, artifact.revision).bytes;
      if (hash(bytes) !== input.previewSha256) conflict();
      packet = TelosSourcePacketSchema.parse(JSON.parse(bytes.toString('utf8')));
    } else {
      const preview = await this.preview(
        { itemId: input.itemId, selection: input.selection },
        actor,
      );
      if (
        preview.sha256 !== input.previewSha256 ||
        preview.packet.workRevision !== input.expectedRevision
      )
        conflict();
      packet = preview.packet;
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
    return this.options.work.execute(
      {
        operation: 'source',
        itemId: input.itemId,
        requestId: 'source:' + requestId,
        expectedRevision: input.expectedRevision,
        snapshot: {
          version: 1,
          snapshotId: hash(actorId + ':' + input.requestId),
          itemId: input.itemId,
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
        },
      },
      actor,
    );
  }

  /** Inspect the retained adoption, even if the original chat later disappears.
   * A general source link or an arbitrary artifact is never treated as this proof.
   */
  read(itemId: string, snapshotId: string, actor: TelosWorkActor) {
    operator(actor);
    const snapshot = this.options.work
      .read(itemId, actor)
      .sources.find((source) => source.snapshotId === snapshotId);
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
      packet.itemId !== itemId ||
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

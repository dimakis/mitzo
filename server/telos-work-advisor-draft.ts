import { createHash } from 'node:crypto';
import {
  TelosWorkAdvisorDraftPreviewRequestSchema,
  TelosWorkAdvisorDraftSaveRequestSchema,
  type TelosWorkAdvisorDraftPreviewRequest,
  type TelosSourcePreview,
  type TelosWorkCommandReceipt,
} from '@mitzo/protocol';
import { TelosWorkError, type TelosWorkActor, type TelosWorkStore } from './telos-work-store.js';
import type { EventStore } from './event-store.js';
import { TelosArtifactStore } from './telos-artifact-store.js';
import { TelosSourceCapture, telosSourceSnapshot } from './telos-source-capture.js';
import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';
import { isAvailableTelosWorkConversation } from './telos-work-conversation.js';

export interface TelosWorkAdvisorDraftDependencies {
  events: EventStore;
  artifacts: TelosArtifactStore;
  work: TelosWorkStore;
  assertAuthorized(): void;
  authorizeSource(actor: TelosWorkActor, conversationId: string): boolean;
  authorizeArtifact(actor: TelosWorkActor, itemId: string): boolean;
}
export class TelosWorkAdvisorDraft {
  constructor(private readonly deps: TelosWorkAdvisorDraftDependencies) {}
  private assertScope(
    input: TelosWorkAdvisorDraftPreviewRequest,
    actor: TelosWorkActor,
    requireCurrentCriteria = true,
  ) {
    this.deps.assertAuthorized();
    if (actor.kind !== 'operator' || !actor.id.trim())
      throw new TelosWorkError('unauthorized', 'Interactive operator authority required');
    const session = this.deps.events.getSession(input.advisorConversationId);
    if (
      !isAvailableTelosWorkConversation(session) ||
      !session?.accountBinding ||
      !this.deps.authorizeSource(actor, input.advisorConversationId)
    )
      throw new TelosWorkError('unauthorized', 'Bound advisor conversation unavailable');
    const context = resolveTelosWorkRoleContext(
      this.deps.events,
      input.advisorConversationId,
      session.accountBinding,
    );
    if (
      context?.role !== 'advisor' ||
      context.itemId !== input.itemId ||
      context.advisorPurpose !== input.operation
    )
      throw new TelosWorkError('unauthorized', 'Exact bound advisor draft scope required');
    const work = this.deps.work.read(input.itemId, actor);
    if (
      !work.links.some(
        (link) =>
          link.role === 'advisor' &&
          link.conversation.namespace === 'mitzo' &&
          link.conversation.conversationId === input.advisorConversationId &&
          link.availability === 'available',
      )
    )
      throw new TelosWorkError('unauthorized', 'Explicit advisor link required');
    for (const itemId of [
      input.itemId,
      ...context.parentCriteria.map((parent) => parent.itemId),
      context.overallGoal.itemId,
    ]) {
      if (
        !this.deps.authorizeArtifact(actor, itemId) ||
        !this.deps.artifacts.userUploadAllowed(itemId)
      )
        throw new TelosWorkError('unauthorized', 'Advisor context requires private case storage');
    }
    for (const parent of requireCurrentCriteria ? context.parentCriteria : []) {
      const current = this.deps.work.readSourceTarget(parent.itemId, actor);
      if (
        current.work.revision !== parent.revision ||
        JSON.stringify(current.record.acceptanceCriteria) !== JSON.stringify(parent.criteria)
      )
        throw new TelosWorkError('conflict', 'Advisor parent criteria changed');
    }
  }
  private capture() {
    return new TelosSourceCapture(this.deps);
  }
  private assertMaterial(
    packet: TelosSourcePreview['packet'],
    actor: TelosWorkActor,
    artifacts = this.deps.artifacts,
  ) {
    this.deps.assertAuthorized();
    for (const pin of packet.context.artifacts) {
      const artifact = artifacts.read(pin.artifactId, pin.revision);
      if (
        !this.deps.authorizeArtifact(actor, artifact.itemId) ||
        !artifacts.userUploadAllowed(artifact.itemId) ||
        artifact.sha256 !== pin.sha256 ||
        createHash('sha256').update(artifact.bytes).digest('hex') !== pin.sha256 ||
        (pin.contentBase64 !== undefined &&
          !artifact.bytes.equals(Buffer.from(pin.contentBase64, 'base64')))
      )
        throw new TelosWorkError('unauthorized', 'Retained advisor material unavailable');
    }
  }
  async preview(raw: unknown, actorInput: TelosWorkActor): Promise<TelosSourcePreview> {
    const actor = structuredClone(actorInput);
    const input = TelosWorkAdvisorDraftPreviewRequestSchema.parse(structuredClone(raw));
    this.assertScope(input, actor);
    const result = await this.capture().previewAdvisorDraft(input, actor);
    this.assertScope(input, actor);
    this.assertMaterial(result.packet, actor);
    return result;
  }
  async save(raw: unknown, actorInput: TelosWorkActor): Promise<TelosWorkCommandReceipt> {
    const actor = structuredClone(actorInput);
    const input = TelosWorkAdvisorDraftSaveRequestSchema.parse(structuredClone(raw));
    this.assertScope(input, actor, false);
    const previous = this.deps.work.advisorDraftReceipt(input, actor);
    if (previous) {
      if (
        !this.deps.authorizeArtifact(actor, previous.work.itemId) ||
        !this.deps.artifacts.userUploadAllowed(previous.work.itemId)
      )
        throw new TelosWorkError(
          'unauthorized',
          'Retained advisor draft requires private case storage',
        );
      const source = previous.work.sources.find(
        (source) => source.snapshotId === this.snapshotId(actor, input.requestId),
      );
      if (!source) throw new TelosWorkError('conflict', 'Retained advisor source missing');
      const retained = this.capture().read(previous.work.itemId, source.snapshotId, actor);
      if (
        !retained.available ||
        JSON.stringify(retained.packet.selection) !== JSON.stringify(input.selection)
      )
        throw new TelosWorkError('unauthorized', 'Retained advisor source unavailable');
      this.assertMaterial(retained.packet, actor);
      this.assertScope(input, actor, false);
      return previous;
    }
    this.assertScope(input, actor);
    const { previewSha256, ...previewInput } = input;
    const preview = await this.preview(previewInput, actor);
    this.assertScope(input, actor);
    if (preview.sha256 !== previewSha256)
      throw new TelosWorkError('conflict', 'Reviewed advisor draft changed');
    this.assertMaterial(preview.packet, actor);
    let materialReader = this.deps.artifacts;
    return this.deps.work.saveAdvisorDraft(
      input,
      actor,
      (database, itemId) => {
        const artifacts = TelosArtifactStore.borrowConnection(database);
        // The second transaction fence must read the work owner's transaction,
        // including any changes made while retaining the source artifact.
        materialReader = artifacts;
        try {
          const artifact = artifacts.save({
            itemId,
            filename: `origin-${preview.sha256}.json`,
            title: 'Reviewed advisor draft source',
            bytes: Buffer.from(JSON.stringify(preview.packet)),
            sessionId: `source-capture:${createHash('sha256').update(`operator:${actor.id}`).digest('hex')}`,
            requestId: `advisor:${input.requestId}`,
            requestInputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
          });
          return telosSourceSnapshot(
            preview.packet,
            artifact,
            itemId,
            this.snapshotId(actor, input.requestId),
          );
        } finally {
          artifacts.close();
        }
      },
      () => {
        this.assertScope(input, actor);
        this.assertMaterial(preview.packet, actor, materialReader);
      },
    );
  }
  private snapshotId(actor: TelosWorkActor, requestId: string) {
    return createHash('sha256')
      .update(JSON.stringify(['advisor-source', `operator:${actor.id}`, requestId]))
      .digest('hex');
  }
}

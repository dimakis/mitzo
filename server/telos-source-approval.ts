import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { getPendingTelosSourceReview, resolveReviewedTelosSourcePermission } from '@mitzo/harness';
import {
  TelosOutcomeProposalSchema,
  TelosSourcePermissionPreviewRequestSchema,
  TelosSourcePermissionApproveRequestSchema,
  TelosSourcePermissionReviewSchema,
  TelosSourcePermissionReceiptSchema,
  type TelosSourcePermissionOperation,
  type TelosSourcePermissionPreviewRequest,
  type TelosOutcomeCreation,
} from '@mitzo/protocol';
import { TelosWorkError, type TelosWorkActor, type TelosWorkStore } from './telos-work-store.js';
import { TelosSourceCapture } from './telos-source-capture.js';
import { createTelosConversationSource } from './telos-conversation-source.js';
import {
  TelosSourceApprovalStore,
  sourceApprovalHash,
  type RetainedTelosSourceApproval,
} from './telos-source-approval-store.js';
import type { TelosArtifactStore } from './telos-artifact-store.js';
import type { EventStore } from './event-store.js';

const adopt = z.strictObject({ itemId: z.string().min(1).max(200) });
export class TelosSourceSaveUncertainError extends Error {
  constructor() {
    super(
      'Source save uncertain. Retry the exact original reviewed request to recover its receipt.',
    );
  }
}
export class TelosSourceApproval {
  readonly capture: TelosSourceCapture;
  constructor(
    private readonly options: {
      events: EventStore;
      work: TelosWorkStore;
      artifacts: TelosArtifactStore;
      store: TelosSourceApprovalStore;
      createOutcome(input: TelosOutcomeCreation): Promise<{ itemId: string; receipt?: unknown }>;
    },
  ) {
    this.capture = new TelosSourceCapture({
      ...options,
      authorizeSource: (actor, id) => actor.kind === 'operator' && !!options.events.getSession(id),
      authorizeArtifact: (actor, id) =>
        actor.kind === 'operator' && options.artifacts.userUploadAllowed(id),
    });
  }
  private operator(actor: TelosWorkActor) {
    if (actor.kind !== 'operator' || !actor.id.trim())
      throw new TelosWorkError('unauthorized', 'Interactive operator authority required');
    return 'operator:' + actor.id;
  }
  private pending(permId: string, sessionId: string) {
    const proof = getPendingTelosSourceReview(permId, sessionId);
    if (!proof)
      throw new TelosWorkError(
        'conflict',
        'Source approval expired or conversation permissions changed',
      );
    return proof;
  }
  private resume(record: RetainedTelosSourceApproval) {
    const pending = getPendingTelosSourceReview(record.proof.permId, record.proof.sessionId);
    if (
      pending &&
      pending.toolName === record.proof.toolName &&
      pending.toolUseId === record.proof.toolUseId &&
      isDeepStrictEqual(pending.toolInput, record.proof.toolInput)
    )
      resolveReviewedTelosSourcePermission(pending, record.id);
  }
  private operation(
    proof: ReturnType<TelosSourceApproval['pending']>,
    actor: TelosWorkActor,
  ): TelosSourcePermissionOperation {
    const name = proof.toolName.replace(/^mcp__telos__/, '');
    if (name === 'TelosCreateOutcome')
      return { kind: 'create', outcome: TelosOutcomeProposalSchema.parse(proof.toolInput) };
    if (name === 'TelosAdoptSource') {
      const input = adopt.parse(proof.toolInput);
      return {
        kind: 'adopt',
        itemId: input.itemId,
        expectedRevision: this.options.work.read(input.itemId, actor).revision,
      };
    }
    throw new TelosWorkError('invalid', 'Unsupported reviewed source operation');
  }
  async review(permId: string, sessionId: string, actor: TelosWorkActor, afterSequence = 0) {
    const actorId = this.operator(actor),
      retained = this.options.store.lookup(permId, sessionId, actorId);
    if (retained) {
      const { preview, input, proof, operation, receipt } = retained;
      return TelosSourcePermissionReviewSchema.parse({
        permId,
        sessionId,
        toolUseId: proof.toolUseId,
        expiresAt: proof.expiresAt,
        proposalSha256: input.proposalSha256,
        operation,
        source: {
          conversationId: sessionId,
          title: preview.packet.sourceTitle,
          boundary: preview.packet.context.boundary,
        },
        messages: [],
        artifacts: [],
        cursor: preview.packet.context.boundary.sequence,
        hasMore: false,
        recovery: {
          requestId: input.requestId,
          proposalSha256: input.proposalSha256,
          selection: input.selection,
          previewSha256: input.previewSha256,
          preview,
          receipt,
        },
      });
    }
    const proof = this.pending(permId, sessionId),
      operation = this.operation(proof, actor);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw new TelosWorkError('invalid', 'Invalid source cursor');
    const anchors = this.options.events.getSymposiumPerspectiveEvents(sessionId, afterSequence, 51);
    const rawPage = anchors.slice(0, 50);
    const page = rawPage.filter((e) => e.type === 'user_message' || e.type === 'message_end');
    const cursor = rawPage.at(-1)?.seq ?? afterSequence;
    const source = createTelosConversationSource({
      events: this.options.events,
      artifacts: this.options.artifacts,
      authorize: () => true,
      authorizeArtifact: (_pin, id) => this.options.artifacts.userUploadAllowed(id),
    });
    const messages = [];
    for (const event of page) {
      const messageId = event.payload.messageId;
      if (typeof messageId !== 'string')
        throw new TelosWorkError('invalid', 'Original message identity unavailable');
      const selection = {
        requestId: '00000000-0000-4000-8000-000000000001',
        expectedMembershipRevision: 0,
        sourceConversationId: sessionId,
        boundary: { sequence: event.seq, messageId },
        mode: 'selected',
        messageIds: [messageId],
        artifacts: [],
        purpose: 'Review source',
        joiningBrief: '',
      };
      const opened = await source.openConversation(selection, true);
      if (!isDeepStrictEqual(this.pending(permId, sessionId), proof))
        throw new TelosWorkError('conflict', 'Pending source approval changed; review again');
      const message = opened.publicMessages.find((message) => message.messageId === messageId);
      if (!message) continue;
      messages.push({
        ...message,
        attribution: opened.attributions[messageId],
        unavailableReason: opened.unavailable[messageId] ?? null,
      });
    }
    if (!isDeepStrictEqual(this.pending(permId, sessionId), proof))
      throw new TelosWorkError('conflict', 'Pending source approval changed; review again');
    return TelosSourcePermissionReviewSchema.parse({
      permId,
      sessionId,
      toolUseId: proof.toolUseId,
      expiresAt: proof.expiresAt,
      proposalSha256: sourceApprovalHash(operation),
      operation,
      source: {
        conversationId: sessionId,
        title: this.options.events.getSession(sessionId)?.summary ?? null,
        boundary: {
          sequence: messages.at(-1)?.sequence ?? 0,
          messageId: messages.at(-1)?.messageId ?? null,
        },
      },
      messages,
      artifacts: this.options.artifacts.sourceMaterials(sessionId).map((a) => ({
        artifactId: a.id,
        revision: a.revision,
        sha256: a.sha256,
        title: a.title,
        filename: a.filename,
        sizeBytes: a.size,
        createdAt: a.createdAt,
        sessionId: a.sessionId,
      })),
      cursor,
      hasMore: anchors.length > 50,
    });
  }
  private async compile(
    permId: string,
    input: TelosSourcePermissionPreviewRequest,
    actor: TelosWorkActor,
  ) {
    this.operator(actor);
    const proof = this.pending(permId, input.sessionId),
      operation = this.operation(proof, actor);
    if (sourceApprovalHash(operation) !== input.proposalSha256)
      throw new TelosWorkError('conflict', 'Pending proposal or target item changed; review again');
    const selection = {
      ...input.selection,
      requestId: input.requestId,
      expectedMembershipRevision: 0,
      sourceConversationId: input.sessionId,
      purpose:
        operation.kind === 'create'
          ? 'Create reviewed Telos outcome'
          : 'Adopt reviewed Telos source',
      joiningBrief: '',
    };
    const requestId = sourceApprovalHash([permId, proof.toolUseId, input.requestId]);
    const preview =
      operation.kind === 'create'
        ? await this.capture.previewNew({ requestId, outcome: operation.outcome, selection }, actor)
        : await this.capture.preview({ itemId: operation.itemId, selection }, actor);
    if (operation.kind === 'adopt' && preview.packet.workRevision !== operation.expectedRevision)
      throw new TelosWorkError('conflict', 'Target item changed; review again');
    if (!isDeepStrictEqual(this.pending(permId, input.sessionId), proof))
      throw new TelosWorkError('conflict', 'Pending source approval changed; review again');
    return { proof, operation, requestId, selection, preview };
  }
  async preview(permId: string, raw: unknown, actor: TelosWorkActor) {
    const input = TelosSourcePermissionPreviewRequestSchema.parse(raw),
      retained = this.options.store.lookup(permId, input.sessionId, this.operator(actor));
    if (retained) {
      if (
        !isDeepStrictEqual(
          { ...input, previewSha256: retained.input.previewSha256 },
          retained.input,
        )
      )
        throw new TelosWorkError('conflict', 'Retry the exact original reviewed source request');
      return {
        permId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        proposalSha256: input.proposalSha256,
        preview: retained.preview,
      };
    }
    const compiled = await this.compile(permId, input, actor);
    if (!isDeepStrictEqual(this.pending(permId, input.sessionId), compiled.proof))
      throw new TelosWorkError('conflict', 'Pending source approval changed; review again');
    return {
      permId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      proposalSha256: input.proposalSha256,
      preview: compiled.preview,
    };
  }
  async approve(permId: string, raw: unknown, actor: TelosWorkActor) {
    const actorId = this.operator(actor),
      input = TelosSourcePermissionApproveRequestSchema.parse(raw);
    let record = this.options.store.find(permId, input.sessionId, actorId, input);
    if (!record) {
      const compiled = await this.compile(permId, input, actor);
      if (compiled.preview.sha256 !== input.previewSha256)
        throw new TelosWorkError('conflict', 'Reviewed source changed; review again');
      if (!isDeepStrictEqual(this.pending(permId, input.sessionId), compiled.proof))
        throw new TelosWorkError('conflict', 'Pending source approval changed; review again');
      record = this.options.store.prepare(
        compiled.proof,
        actorId,
        input,
        compiled.operation,
        compiled.preview,
      );
    }
    if (record.receipt) {
      this.resume(record);
      return record.receipt;
    }
    const approvalId = record.id;
    const originalProof = record.proof;
    try {
      const operation = record.operation,
        requestId = sourceApprovalHash([permId, record.proof.toolUseId, input.requestId]);
      const selection = {
        ...input.selection,
        requestId: input.requestId,
        expectedMembershipRevision: 0,
        sourceConversationId: input.sessionId,
        purpose:
          operation.kind === 'create'
            ? 'Create reviewed Telos outcome'
            : 'Adopt reviewed Telos source',
        joiningBrief: '',
      };
      const readPreparedPreview = () => {
        const retained = this.options.store.find(permId, input.sessionId, actorId, input);
        if (
          !retained ||
          retained.id !== approvalId ||
          !isDeepStrictEqual(retained.operation, operation) ||
          !isDeepStrictEqual(retained.proof, originalProof)
        )
          throw new TelosWorkError('conflict', 'Original reviewed source approval changed');
        return retained.preview;
      };
      const receipt =
        operation.kind === 'create'
          ? await this.capture.createReviewed(
              {
                requestId,
                outcome: operation.outcome,
                selection,
                previewSha256: input.previewSha256,
              },
              actor,
              async (body) => {
                const created = await this.options.createOutcome(body);
                this.options.store.observeCanonical(approvalId, created.itemId, created.receipt);
                return created;
              },
              readPreparedPreview,
            )
          : await this.capture.adopt(
              {
                itemId: operation.itemId,
                requestId,
                selection,
                expectedRevision: operation.expectedRevision,
                previewSha256: input.previewSha256,
              },
              actor,
              readPreparedPreview,
            );
      const source = receipt.work.sources.find(
        (source) =>
          source.artifacts.at(-1)?.sha256 === input.previewSha256 &&
          source.source?.namespace === 'mitzo' &&
          source.source.conversationId === input.sessionId,
      );
      if (!source) throw new Error('Saved reviewed source receipt unavailable');
      const canonicalCreation =
        operation.kind === 'create' ? this.options.store.canonical(record.id) : null;
      if (
        operation.kind === 'create' &&
        (!canonicalCreation || canonicalCreation.item.id !== receipt.work.itemId)
      )
        throw new Error('Actual canonical creation receipt unavailable');
      const result = TelosSourcePermissionReceiptSchema.parse({
        permId,
        sessionId: input.sessionId,
        receipt,
        sourceSnapshotId: source.snapshotId,
        canonicalCreation,
      });
      this.options.store.complete(record.id, result);
      this.resume(record);
      return result;
    } catch (error) {
      if (error instanceof TelosWorkError) throw error;
      throw new TelosSourceSaveUncertainError();
    }
  }
  execute(approvalReceiptId: string, sessionId: string, rawProposal: unknown) {
    const record = this.options.store.read(approvalReceiptId, sessionId);
    if (!record?.receipt)
      throw new TelosWorkError('unauthorized', 'Reviewed source approval receipt required');
    const proposal =
      record.operation.kind === 'create'
        ? { kind: 'create', outcome: TelosOutcomeProposalSchema.parse(rawProposal) }
        : { ...record.operation, ...adopt.parse(rawProposal) };
    if (sourceApprovalHash(proposal) !== sourceApprovalHash(record.operation))
      throw new TelosWorkError(
        'conflict',
        'Tool proposal differs from the original reviewed invocation',
      );
    this.options.store.retrieved(record.id);
    return { operation: record.operation, ...record.receipt };
  }
}

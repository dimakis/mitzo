import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { SessionCollaborationSchema } from './session-collaboration.js';
import {
  CollaborationContractError,
  CollaborationDeliverySchema,
  CollaborationForwardReferenceSchema,
  CollaborationSettingsSchema,
  CollaborationSnapshotMessageSchema,
  CollaborationSnapshotSelectionSchema,
} from './collaboration-conversation.js';

const selection = CollaborationSnapshotSelectionSchema.shape;
const id = CollaborationSnapshotMessageSchema.shape.messageId;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const artifactPin = selection.artifacts.element;
const target = z.strictObject({
  collaborationId: SessionCollaborationSchema.shape.collaborationId,
  expectedMembershipRevision: selection.expectedMembershipRevision,
  // Existing Message.settings record parsing omits __proto__. Refuse it before
  // reserving durable intent rather than committing an unusable reservation.
  sessionIds: SessionCollaborationSchema.shape.participantSessionIds
    .refine((ids) => ids.length > 0)
    .refine((ids) => !ids.includes('__proto__')),
});
/** Exact B selector shape/order. Selectors and digests confer no access or input eligibility. */
export const CollaborationForwardSelectionSchema = z
  .strictObject({
    requestId: selection.requestId,
    target,
    sourceConversationId: selection.sourceConversationId.nullable(),
    boundary: selection.boundary.nullable(),
    messages: z
      .array(
        z.strictObject({
          messageId: id,
          sequence: CollaborationSnapshotMessageSchema.shape.sequence,
          blocks: z
            .array(CollaborationSnapshotMessageSchema.shape.blocks.element.omit({ content: true }))
            .min(1)
            .max(100),
        }),
      )
      .max(500),
    artifacts: z
      .array(
        z.discriminatedUnion('kind', [
          artifactPin.extend({ kind: z.literal('transcript_reference') }),
          artifactPin.extend({ kind: z.literal('retained_artifact') }),
        ]),
      )
      .max(100),
  })
  .refine((input) => input.messages.length + input.artifacts.length > 0)
  .refine((input) =>
    input.sourceConversationId !== null
      ? input.boundary !== null
      : input.boundary === null &&
        input.messages.length === 0 &&
        input.artifacts.length > 0 &&
        input.artifacts.every((pin) => pin.kind === 'retained_artifact'),
  )
  .superRefine((input, context) => {
    if (
      new Set(input.messages.map((message) => message.messageId)).size !== input.messages.length ||
      input.messages.some(
        (message) =>
          new Set(message.blocks.map((block) => block.blockId)).size !== message.blocks.length,
      ) ||
      new Set(input.artifacts.map((pin) => `${pin.kind}:${pin.artifactId}:${pin.revision}`))
        .size !== input.artifacts.length
    )
      context.addIssue({ code: 'custom', message: 'Duplicate forwarding selector' });
  });
export const CollaborationForwardPrepareInputSchema = z.strictObject({
  selection: CollaborationForwardSelectionSchema,
  note: z.string().max(20_000),
});
export const CollaborationForwardConfirmInputSchema = z.strictObject({
  requestId: z.uuid(),
  expectedMembershipRevision: selection.expectedMembershipRevision,
  forward: CollaborationForwardReferenceSchema.extend({ selectionFingerprint: digest }),
  requestReply: z.literal(false),
});
export const CollaborationForwardConfirmationSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.uuid(),
  forward: CollaborationForwardConfirmInputSchema.shape.forward,
  messageId: z.uuid(),
  deliveries: z.array(CollaborationDeliverySchema).min(1).max(16),
});
/** Private existing-record shape. Never serialize this through HTTP or replay. */
export const CollaborationForwardPreparationSchema = z.strictObject({
  version: z.literal(1),
  forwardId: z.uuid(),
  operatorId: id,
  input: CollaborationForwardPrepareInputSchema,
  selectionFingerprint: digest,
  settings: z.record(id, CollaborationSettingsSchema),
  serialized: z
    .string()
    .max(512 * 1024)
    .nullable(),
  packetSha256: digest.nullable(),
  confirmation: CollaborationForwardConfirmationSchema.nullable(),
});
export const CollaborationForwardReadSchema = z.strictObject({
  version: z.literal(1),
  forwardId: z.uuid(),
  requestId: z.uuid(),
  selection: CollaborationForwardSelectionSchema,
  note: z.string().max(20_000),
  selectionFingerprint: digest,
  packetSha256: digest.nullable(),
  state: z.enum(['preparing', 'prepared', 'confirmed']),
  confirmation: CollaborationForwardConfirmationSchema.nullable(),
  deliveries: z.array(CollaborationDeliverySchema).max(16),
});
const encodedArtifact = artifactPin.extend({
  mediaType: z.string().min(1).max(200),
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .max(512 * 1024),
  contentBase64: z.string().max(512 * 1024),
});
export const CollaborationForwardPacketSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.uuid(),
  mode: z.literal('context_only'),
  target,
  sourceConversationId: id.nullable(),
  sourceIdentity: id.nullable(),
  boundary: selection.boundary.nullable(),
  messages: z.array(CollaborationSnapshotMessageSchema).max(500),
  artifacts: z
    .array(
      z.discriminatedUnion('kind', [
        encodedArtifact.extend({
          kind: z.literal('transcript_reference'),
          retention: z.literal('source_dependent'),
          sourceConversationId: id,
        }),
        encodedArtifact.extend({
          kind: z.literal('retained_artifact'),
          retention: z.literal('independent'),
          itemId: id,
          filename: z.string().min(1),
          title: z.string().min(1),
          mediaType: z.literal('application/octet-stream'),
          provenance: z.strictObject({
            sessionId: z.string(),
            sourceKind: z.enum([
              'user_upload',
              'user_edit',
              'session_artifact',
              'external_codex_report',
              'source_capture',
            ]),
            sourcePath: z.string().nullable(),
          }),
        }),
      ]),
    )
    .max(100),
});
export type CollaborationForwardPreparation = z.infer<typeof CollaborationForwardPreparationSchema>;
export type CollaborationForwardPrepareInput = z.infer<
  typeof CollaborationForwardPrepareInputSchema
>;
export type CollaborationForwardConfirmInput = z.infer<
  typeof CollaborationForwardConfirmInputSchema
>;
export type CollaborationForwardConfirmation = z.infer<
  typeof CollaborationForwardConfirmationSchema
>;
export type CollaborationForwardRead = z.infer<typeof CollaborationForwardReadSchema>;
export type CollaborationForwardSelection = z.infer<typeof CollaborationForwardSelectionSchema>;
export type CollaborationForwardPacket = z.infer<typeof CollaborationForwardPacketSchema>;
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function collaborationForwardSelectionFingerprint(raw: unknown): string {
  return hash(JSON.stringify(CollaborationForwardSelectionSchema.parse(raw)));
}
function changed(): never {
  throw new CollaborationContractError('snapshot_changed');
}
/** Validate trusted host custody only. Opaque retained bytes are not a model input adapter. */
export function validateCollaborationForwardPacket(
  input: CollaborationForwardPrepareInput,
  serialized: string,
  packetSha256: string,
) {
  if (Buffer.byteLength(serialized, 'utf8') + Buffer.byteLength(input.note, 'utf8') > 512 * 1024)
    throw new CollaborationContractError('capacity_refused');
  if (hash(serialized) !== packetSha256) changed();
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    changed();
  }
  // B emits JSON.stringify. Reject duplicate keys/alternate lossy encodings without
  // normalizing the retained literal or changing its independently checked digest.
  if (JSON.stringify(raw) !== serialized) changed();
  const packet = CollaborationForwardPacketSchema.parse(raw);
  const selected = input.selection;
  if (
    packet.requestId !== selected.requestId ||
    !isDeepStrictEqual(packet.target, selected.target) ||
    packet.sourceConversationId !== selected.sourceConversationId ||
    !isDeepStrictEqual(packet.boundary, selected.boundary) ||
    (selected.sourceConversationId === null
      ? packet.sourceIdentity !== null
      : !packet.sourceIdentity) ||
    packet.messages.length !== selected.messages.length ||
    packet.artifacts.length !== selected.artifacts.length
  )
    changed();
  packet.messages.forEach((message, index) => {
    const pin = selected.messages[index];
    if (
      message.conversationId !== selected.sourceConversationId ||
      message.messageId !== pin.messageId ||
      message.sequence !== pin.sequence ||
      !selected.boundary ||
      message.sequence > selected.boundary.sequence ||
      !isDeepStrictEqual(
        message.blocks.map(({ blockId, sha256 }) => ({ blockId, sha256 })),
        pin.blocks,
      ) ||
      message.blocks.some((block) => hash(block.content) !== block.sha256) ||
      (message.source &&
        ((message.author !== 'operator' &&
          message.source.conversationId !== message.author.sessionId) ||
          message.blocks.some((block) => !message.source!.blockIds.includes(block.blockId))))
    )
      changed();
  });
  packet.artifacts.forEach((artifact, index) => {
    const pin = selected.artifacts[index];
    if (
      !isDeepStrictEqual(
        {
          artifactId: artifact.artifactId,
          revision: artifact.revision,
          sha256: artifact.sha256,
          kind: artifact.kind,
        },
        pin,
      ) ||
      (artifact.kind === 'transcript_reference' &&
        artifact.sourceConversationId !== selected.sourceConversationId) ||
      (artifact.kind === 'retained_artifact' && artifact.provenance.sourceKind === 'source_capture')
    )
      changed();
    const bytes = Buffer.from(artifact.contentBase64, 'base64');
    if (
      bytes.toString('base64') !== artifact.contentBase64 ||
      bytes.length !== artifact.sizeBytes ||
      hash(bytes) !== artifact.sha256
    )
      changed();
  });
  return packet;
}

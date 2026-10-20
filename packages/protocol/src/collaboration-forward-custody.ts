import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CollaborationContractError } from './collaboration-conversation.js';
import {
  CollaborationForwardSelectionSchema,
  CollaborationForwardPacketSchema,
  type CollaborationForwardPrepareInput,
} from './collaboration-forward.js';

// Host custody only. Keep Node hashing and retained-byte validation outside the
// public protocol barrel shared with browser clients.
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

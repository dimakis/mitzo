import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  CollaborationContractError,
  CollaborationSnapshotMessageSchema,
  CollaborationSnapshotSelectionSchema,
  SessionCollaborationSchema,
} from '@mitzo/protocol';
import type { AuthorizedCollaborationContext } from './collaboration-context-compiler.js';
import type {
  RetainedCollaborationArtifact,
  RetainedCollaborationArtifactSource,
} from './collaboration-retained-artifact-source.js';

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const selection = CollaborationSnapshotSelectionSchema.shape;
const id = CollaborationSnapshotMessageSchema.shape.messageId;
const blockPin = CollaborationSnapshotMessageSchema.shape.blocks.element.omit({ content: true });
const artifactPin = selection.artifacts.element;
const target = z.strictObject({
  collaborationId: SessionCollaborationSchema.shape.collaborationId,
  expectedMembershipRevision: selection.expectedMembershipRevision,
  sessionIds: SessionCollaborationSchema.shape.participantSessionIds.refine(
    (ids) => ids.length > 0,
  ),
});
/** Select complete visible blocks, never caller-supplied text or a private-history selector.
 * Linked URLs/Git references are not accepted as independently retained bytes.
 */
export const CollaborationForwardSelectionSchema = z
  .strictObject({
    requestId: selection.requestId,
    target,
    sourceConversationId: selection.sourceConversationId,
    boundary: selection.boundary,
    messages: z
      .array(
        z.strictObject({
          messageId: id,
          sequence: CollaborationSnapshotMessageSchema.shape.sequence,
          blocks: z.array(blockPin).min(1).max(100),
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
  .refine(
    (input) => input.messages.length + input.artifacts.length > 0,
    'Explicit content required',
  );
export type CollaborationForwardSelection = z.infer<typeof CollaborationForwardSelectionSchema>;
export type CollaborationForwardTarget = z.infer<typeof target>;

type Message = z.infer<typeof CollaborationSnapshotMessageSchema>;
type TranscriptArtifact = z.infer<typeof artifactPin> & {
  kind: 'transcript_reference';
  retention: 'source_dependent';
  sourceConversationId: string;
  mediaType: string;
  contentBase64: string;
  sizeBytes: number;
};
type Artifact =
  | TranscriptArtifact
  | (Omit<RetainedCollaborationArtifact, 'bytes'> & {
      kind: 'retained_artifact';
      contentBase64: string;
      sizeBytes: number;
    });
export interface CollaborationForwardPacket {
  version: 1;
  requestId: string;
  mode: 'context_only';
  target: CollaborationForwardTarget;
  sourceConversationId: string;
  sourceIdentity: string;
  boundary: CollaborationForwardSelection['boundary'];
  messages: Message[];
  artifacts: Artifact[];
}
function changed(): never {
  throw new CollaborationContractError('snapshot_changed');
}
function unique(ids: string[]) {
  if (new Set(ids).size !== ids.length) changed();
}
function bounded(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > 512 * 1024)
    throw new CollaborationContractError('capacity_refused');
}
/** Canonical selectors for the existing durable request owner. This hash is neither
 * an idempotency receipt nor authorization. Bind it to the authenticated operator
 * there; recover the original receipt before recompilation and reject identity reuse.
 */
export function collaborationForwardFingerprint(raw: unknown): string {
  return sha(JSON.stringify(CollaborationForwardSelectionSchema.parse(raw)));
}
/** Read-only host composition. No persistence, allocator, queue, capacity adapter or
 * provider port exists here. The ordinary delivery owner must retain the exact packet
 * and request identity, and renew authority at its own dispatch fence. assertCurrent
 * is a point-in-time check, not atomic admission or a reusable execution permit.
 */
export async function prepareCollaborationForward(
  raw: unknown,
  deps: {
    source: AuthorizedCollaborationContext;
    retainedArtifacts?: RetainedCollaborationArtifactSource;
    authorizeTarget(target: CollaborationForwardTarget): Promise<void>;
  },
) {
  const input = CollaborationForwardSelectionSchema.parse(raw);
  bounded(input);
  unique(input.messages.map((m) => m.messageId));
  unique(input.artifacts.map((a) => `${a.kind}:${a.artifactId}:${a.revision}`));
  for (const message of input.messages) unique(message.blocks.map((b) => b.blockId));
  const authorizeTarget = () => deps.authorizeTarget(structuredClone(input.target));
  await authorizeTarget();
  const opened = await deps.source.openConversation({
    requestId: input.requestId,
    expectedMembershipRevision: input.target.expectedMembershipRevision,
    sourceConversationId: input.sourceConversationId,
    boundary: structuredClone(input.boundary),
    mode: 'selected',
    messageIds: input.messages.map((m) => m.messageId),
    artifacts: [],
    purpose: 'Forward selected content',
    joiningBrief: '',
  });
  if (
    !opened.sourceIdentity ||
    opened.sourceConversationId !== input.sourceConversationId ||
    !isDeepStrictEqual(opened.boundary, input.boundary)
  )
    changed();
  const messages = z
    .array(CollaborationSnapshotMessageSchema)
    .max(500)
    .parse(await opened.readSelected(input.messages.map((m) => m.messageId)));
  unique(messages.map((m) => m.messageId));
  if (messages.length !== input.messages.length) changed();
  const selected = input.messages.map((pin) => {
    const message = messages.find((m) => m.messageId === pin.messageId);
    if (
      !message ||
      message.conversationId !== input.sourceConversationId ||
      message.sequence !== pin.sequence ||
      message.sequence > input.boundary.sequence ||
      (message.source &&
        message.author !== 'operator' &&
        message.source.conversationId !== message.author.sessionId)
    )
      changed();
    unique(message.blocks.map((b) => b.blockId));
    for (const block of message.blocks) if (sha(block.content) !== block.sha256) changed();
    const blocks = pin.blocks.map((ref) => {
      const block = message.blocks.find((b) => b.blockId === ref.blockId);
      if (
        !block ||
        block.sha256 !== ref.sha256 ||
        (message.source && !message.source.blockIds.includes(block.blockId))
      )
        changed();
      return structuredClone(block);
    });
    return { ...message, blocks };
  });
  const packet: CollaborationForwardPacket = {
    version: 1,
    requestId: input.requestId,
    mode: 'context_only',
    target: structuredClone(input.target),
    sourceConversationId: input.sourceConversationId,
    sourceIdentity: opened.sourceIdentity,
    boundary: structuredClone(input.boundary),
    messages: selected,
    artifacts: [],
  };
  async function material(
    ref: CollaborationForwardSelection['artifacts'][number],
  ): Promise<Artifact> {
    const pin = artifactPin.parse({
      artifactId: ref.artifactId,
      revision: ref.revision,
      sha256: ref.sha256,
    });
    if (ref.kind === 'retained_artifact') {
      if (!deps.retainedArtifacts) changed();
      const saved = await deps.retainedArtifacts.read(pin);
      if (
        saved.artifactId !== pin.artifactId ||
        saved.revision !== pin.revision ||
        saved.sha256 !== pin.sha256 ||
        saved.retention !== 'independent' ||
        sha(saved.bytes) !== pin.sha256
      )
        changed();
      if (saved.bytes.byteLength > 512 * 1024)
        throw new CollaborationContractError('capacity_refused');
      return {
        ...pin,
        kind: ref.kind,
        retention: saved.retention,
        itemId: saved.itemId,
        filename: saved.filename,
        title: saved.title,
        mediaType: saved.mediaType,
        provenance: structuredClone(saved.provenance),
        sizeBytes: saved.bytes.byteLength,
        contentBase64: Buffer.from(saved.bytes).toString('base64'),
      };
    }
    await deps.source.authorizeArtifact(pin);
    const artifact = await deps.source.readArtifact(pin);
    if (
      artifact.artifactId !== pin.artifactId ||
      artifact.revision !== pin.revision ||
      artifact.sha256 !== pin.sha256 ||
      sha(artifact.bytes) !== pin.sha256 ||
      artifact.sourceConversationId !== input.sourceConversationId
    )
      changed();
    if (artifact.bytes.byteLength > 512 * 1024)
      throw new CollaborationContractError('capacity_refused');
    return {
      ...pin,
      kind: ref.kind,
      retention: 'source_dependent',
      sourceConversationId: artifact.sourceConversationId,
      mediaType: artifact.mediaType,
      sizeBytes: artifact.bytes.byteLength,
      contentBase64: Buffer.from(artifact.bytes).toString('base64'),
    };
  }
  for (const ref of input.artifacts) {
    packet.artifacts.push(await material(ref));
    bounded(packet);
  }
  async function assertCurrent() {
    await authorizeTarget();
    await opened.assertCurrent();
    for (let index = 0; index < input.artifacts.length; index++) {
      if (!isDeepStrictEqual(await material(input.artifacts[index]), packet.artifacts[index]))
        changed();
    }
    await opened.assertCurrent();
    await authorizeTarget();
    // A target check may yield while finalized source storage changes.
    await opened.assertCurrent();
  }
  bounded(packet);
  await assertCurrent();
  const serialized = JSON.stringify(packet);
  return {
    // Fresh projections keep callers from mutating the retained closure's selection.
    get packet() {
      return structuredClone(packet);
    },
    serialized,
    sha256: sha(serialized),
    requestFingerprint: collaborationForwardFingerprint(input),
    assertCurrent,
  };
}

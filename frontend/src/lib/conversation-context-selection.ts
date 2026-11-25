import type { FinishedMessage } from '@mitzo/protocol';
import type { ConversationAgentSetup } from './conversation-joining-review';

/** Recorded display facts only. These never change a source selector or grant access. */
export interface ConversationContextMessageMetadata {
  authorId: string;
  authorLabel: string;
  type?: 'message' | 'reply' | 'progress';
  timestamp?: number;
}

export function contextMessagePresentation(
  message: FinishedMessage,
  metadata?: ConversationContextMessageMetadata,
) {
  const peer = message.agentMessage;
  const provenance = message.symposiumProvenance;
  const authorId =
    metadata?.authorId ??
    (peer
      ? `peer:${peer.message.senderConversationId}`
      : provenance
        ? `seat:${provenance.seatId}`
        : message.role);
  const authorLabel =
    metadata?.authorLabel ??
    (peer
      ? peer.senderName || 'Agent · name not recorded'
      : provenance
        ? 'seatLabel' in provenance
          ? provenance.seatLabel
          : 'Agent · name not recorded'
        : message.role === 'user'
          ? 'You'
          : 'Agent · name not recorded');
  const timestamp = metadata?.timestamp ?? message.timestamp ?? peer?.timestamp;
  return {
    authorId,
    authorLabel,
    timestamp:
      timestamp !== undefined && Number.isFinite(new Date(timestamp).getTime())
        ? timestamp
        : undefined,
    type:
      metadata?.type ??
      (message.inReplyTo || message.replyToMessageId || peer?.message.replyTo
        ? 'reply'
        : 'message'),
    text: message.blocks
      .filter((block) => block.blockType === 'text')
      .map((block) => block.content)
      .join('\n'),
  };
}

/** Preserve the existing selector's text eligibility, including whitespace text. */
export function selectableContextMessages(messages: FinishedMessage[]) {
  return messages.filter((message) =>
    message.blocks.some((block) => block.blockType === 'text' && block.content),
  );
}

export function contextArtifactKey(artifact: ConversationAgentSetup['artifacts'][number]) {
  return JSON.stringify([artifact.artifactId, artifact.revision, artifact.sha256]);
}

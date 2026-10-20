import { CollaborationArtifactPinSchema, type CollaborationArtifactPin } from '@mitzo/protocol';

/** A label is never a selector. Keep the namespace and exact version, excluding display metadata. */
export function conversationArtifactPin(
  artifact: CollaborationArtifactPin,
): CollaborationArtifactPin {
  return CollaborationArtifactPinSchema.parse({
    ...('kind' in artifact ? { kind: artifact.kind } : {}),
    artifactId: artifact.artifactId,
    revision: artifact.revision,
    sha256: artifact.sha256,
  });
}

export function conversationArtifactKey(artifact: CollaborationArtifactPin): string {
  return JSON.stringify([
    'kind' in artifact ? artifact.kind : 'inline',
    artifact.artifactId,
    artifact.revision,
    artifact.sha256,
  ]);
}

export const sameConversationArtifact = (
  a: CollaborationArtifactPin,
  b: CollaborationArtifactPin,
) => conversationArtifactKey(a) === conversationArtifactKey(b);

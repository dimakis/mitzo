import type { CollaborationRetainedArtifactMetadata } from '@mitzo/protocol';
import { joiningReviewFixture } from '../../preview/conversation-joining-fixture';

/** Offline exact-version evidence; no artifact catalog or access owner is simulated. */
export const retainedArtifact = {
  kind: 'retainedArtifactVersion',
  artifactId: 'plan',
  revision: 2,
  sha256: 'd'.repeat(64),
  retention: 'independent',
  itemId: 'retained-item',
  title: 'Retained review plan',
  filename: 'retained-plan-r2.md',
  provenance: {
    sessionId: 'original-author-chat',
    sourceKind: 'session_artifact',
    sourcePath: 'notes/retained-plan-r2.md',
  },
  mediaType: 'application/octet-stream',
  sizeBytes: 3,
} satisfies CollaborationRetainedArtifactMetadata;
export const retainedPin = () => ({
  kind: retainedArtifact.kind,
  artifactId: retainedArtifact.artifactId,
  revision: retainedArtifact.revision,
  sha256: retainedArtifact.sha256,
});
export const retainedLabel = () => ({
  ...retainedPin(),
  title: retainedArtifact.title,
  filename: retainedArtifact.filename,
});
export function retainedJoiningReviewFixture() {
  const review = joiningReviewFixture();
  review.snapshot.artifacts.push({ ...structuredClone(retainedArtifact), contentBase64: 'YWJj' });
  review.artifactLabels!.push(retainedLabel());
  return review;
}

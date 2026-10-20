import { expect, it } from 'vitest';
import {
  CollaborationSnapshotSelectionSchema,
  CollaborationSnapshotDraftSchema,
} from '../src/collaboration-conversation.js';
const pin = { artifactId: 'a'.repeat(32), revision: 2, sha256: 'b'.repeat(64) };
const tagged = { kind: 'retainedArtifactVersion' as const, ...pin };
const selection = {
  requestId: '00000000-0000-4000-8000-000000000001',
  expectedMembershipRevision: 1,
  sourceConversationId: 'visible-conversation',
  boundary: { sequence: 0, messageId: null },
  mode: 'selected' as const,
  messageIds: [],
  artifacts: [tagged],
  purpose: 'Review',
  joiningBrief: 'Exact selected version',
};
const retained = {
  ...tagged,
  retention: 'independent',
  itemId: 'work',
  filename: 'plan.md',
  title: 'Plan',
  provenance: {
    sessionId: 'origin-no-longer-present',
    sourceKind: 'session_artifact',
    sourcePath: '/synthetic/plan.md',
  },
  mediaType: 'application/octet-stream',
  sizeBytes: 3,
  contentBase64: 'YWJj',
};
const draft = {
  requestId: selection.requestId,
  sourceConversationId: selection.sourceConversationId,
  boundary: selection.boundary,
  mode: selection.mode,
  purpose: selection.purpose,
  joiningBrief: selection.joiningBrief,
  messages: [],
  artifacts: [retained],
  capacity: { status: 'unverified', reason: 'No native producer' },
  summary: null,
};
it('accepts exact tagged retained selectors while preserving legacy bare selectors byte-for-byte', () => {
  expect(CollaborationSnapshotSelectionSchema.parse(selection).artifacts).toEqual([tagged]);
  const legacy = { ...selection, artifacts: [pin] };
  expect(JSON.stringify(CollaborationSnapshotSelectionSchema.parse(legacy))).toBe(
    JSON.stringify(legacy),
  );
});
it('keeps independent original provenance separate from the selected source conversation in frozen retained bytes', () => {
  const value = CollaborationSnapshotDraftSchema.parse(draft);
  expect(value.artifacts).toEqual([retained]);
  expect(value.artifacts[0]).not.toHaveProperty('sourceConversationId');
  const legacy = {
    ...pin,
    sourceConversationId: 'visible-conversation',
    mediaType: 'text/plain',
    sizeBytes: 3,
  };
  expect(
    CollaborationSnapshotDraftSchema.parse({ ...draft, artifacts: [legacy] }).artifacts,
  ).toEqual([legacy]);
});
it.each([
  { itemId: 'caller-grant' },
  { retention: 'independent' },
  { authorized: true },
  { provenance: retained.provenance },
])('rejects caller authority or source bytes in a retained selector', (extra) => {
  expect(() =>
    CollaborationSnapshotSelectionSchema.parse({
      ...selection,
      artifacts: [{ ...tagged, ...extra }],
    }),
  ).toThrow();
});
it.each([
  { sourceConversationId: 'fabricated-origin' },
  { retention: 'source_dependent' },
  { contentBase64: undefined },
  { provenance: { ...retained.provenance, sourceKind: 'source_capture' } },
])('rejects fabricated or incomplete retained snapshot authority', (extra) => {
  expect(() =>
    CollaborationSnapshotDraftSchema.parse({ ...draft, artifacts: [{ ...retained, ...extra }] }),
  ).toThrow();
});

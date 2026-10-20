import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TelosSourceCapture } from './telos-source-capture.js';
import type { TelosWorkStore, TelosWorkActor } from './telos-work-store.js';
import type { TelosArtifactStore } from './telos-artifact-store.js';
import {
  TelosWorkRoleContextSelectionSchema,
  renderTelosWorkRoleContext,
  type TelosWorkRoleContextSelection,
} from './telos-work-role-context.js';
export interface TelosWorkRoleReviewInput {
  work: TelosWorkStore;
  artifacts?: TelosArtifactStore;
  actor: TelosWorkActor;
  itemId: string;
  role: TelosWorkRoleContextSelection['role'];
  advisorPurpose?: 'refine' | 'child';
  selectedSourceSnapshotIds: string[];
  selectedArtifactRefs: TelosWorkRoleContextSelection['artifacts'];
  /** Scoped host reader may grant exactly one child plus its ancestry. */
  readTarget?(itemId: string): ReturnType<TelosWorkStore['readSourceTarget']>;
  /** Trusted host proof reader, restricted to this selected item's retained sources. */
  readReviewedSource?(snapshotId: string): ReturnType<TelosSourceCapture['read']>;
}
/** Read only canonical work and retained references. No transcript/provider port exists. */
export function reviewTelosWorkRoleContext(
  input: TelosWorkRoleReviewInput,
): TelosWorkRoleContextSelection {
  const { work, actor, itemId, role } = input;
  const readTarget = input.readTarget ?? ((id: string) => work.readSourceTarget(id, actor));
  const target = readTarget(itemId);
  if (
    role === 'advisor' &&
    input.advisorPurpose === 'child' &&
    target.work.kind !== 'coordinator' &&
    target.work.kind !== 'outcome'
  )
    throw new Error('Child advisor requires a coordinator or outcome');
  if (/^life[-_ ]?ops$/i.test(target.record.profile))
    throw new Error('Selected role context unavailable');
  const ancestors: Array<ReturnType<TelosWorkStore['readSourceTarget']>> = [];
  const seen = new Set([itemId]);
  let parentId = target.record.parentId;
  while (parentId !== null) {
    if (seen.has(parentId) || ancestors.length >= 100)
      throw new Error('Selected work ancestry unavailable');
    seen.add(parentId);
    const parent = readTarget(parentId);
    if (/^life[-_ ]?ops$/i.test(parent.record.profile))
      throw new Error('Selected role context unavailable');
    ancestors.push(parent);
    parentId = parent.record.parentId;
  }
  const root = ancestors.at(-1) ?? target;
  const sources = input.selectedSourceSnapshotIds.map((snapshotId) => {
    const source = target.work.sources.find((source) => source.snapshotId === snapshotId);
    if (!source || source.itemId !== itemId || source.selection.kind !== 'selected')
      throw new Error('Selected reviewed source unavailable');
    return source;
  });
  if (new Set(input.selectedSourceSnapshotIds).size !== sources.length)
    throw new Error('Duplicate reviewed source selection');
  const artifacts = input.selectedArtifactRefs.map((ref) => ({ ...ref }));
  const pinKey = (ref: (typeof artifacts)[number]) =>
    JSON.stringify([ref.artifactId, ref.revision, ref.sha256]);
  let reviewedMaterial: Set<string> | undefined;
  const hasReviewedCustody = (ref: (typeof artifacts)[number]) => {
    if (!input.readReviewedSource) return false;
    if (!reviewedMaterial) {
      reviewedMaterial = new Set();
      for (const source of sources) {
        const reviewed = input.readReviewedSource(source.snapshotId);
        if (!isDeepStrictEqual(reviewed.snapshot, source))
          throw new Error('Selected reviewed source unavailable');
        for (const material of reviewed.packet.context.artifacts)
          reviewedMaterial.add(pinKey(material));
      }
    }
    return reviewedMaterial.has(pinKey(ref));
  };
  for (const ref of [...artifacts, ...sources.flatMap((source) => source.artifacts)]) {
    if (!input.artifacts || !input.artifacts.userUploadAllowed(itemId))
      throw new Error('Selected retained artifact unavailable');
    let artifact;
    try {
      artifact = input.artifacts.read(ref.artifactId, ref.revision);
    } catch {
      throw new Error('Selected retained artifact unavailable');
    }
    if (
      (artifact.itemId !== itemId && !hasReviewedCustody(ref)) ||
      !input.artifacts.userUploadAllowed(artifact.itemId) ||
      artifact.revision !== ref.revision ||
      artifact.sha256 !== ref.sha256 ||
      createHash('sha256').update(artifact.bytes).digest('hex') !== ref.sha256
    )
      throw new Error('Selected retained artifact unavailable');
  }
  let leadConversationId: string | undefined;
  if (role === 'worker') {
    const outcome = [target, ...ancestors].find((candidate) => candidate.work.kind === 'outcome');
    const lead = outcome?.work.assignments.find((assignment) => assignment.role === 'lead');
    if (
      !lead ||
      !outcome?.work.links.some(
        (link) =>
          link.role === 'lead' &&
          link.conversation.namespace === 'mitzo' &&
          link.conversation.conversationId === lead.conversation.conversationId &&
          link.availability === 'available',
      )
    )
      throw new Error('Selected outcome lead unavailable');
    leadConversationId = lead.conversation.conversationId;
  }
  const text = JSON.stringify({
    summary: target.record.summary,
    intent: target.record.intent,
    rationale: target.record.rationale,
    acceptanceCriteria: target.record.acceptanceCriteria,
    taskHint: target.record.contextHints.taskHint,
  });
  const selected = TelosWorkRoleContextSelectionSchema.parse({
    version: 1,
    itemId,
    itemKind: target.work.kind,
    role,
    ...(input.advisorPurpose ? { advisorPurpose: input.advisorPurpose } : {}),
    brief: {
      revision: target.work.revision,
      text,
      sha256: createHash('sha256').update(text).digest('hex'),
    },
    parentCriteria: ancestors.map((parent) => ({
      itemId: parent.record.itemId,
      revision: parent.work.revision,
      criteria: parent.record.acceptanceCriteria,
    })),
    overallGoal: {
      itemId: root.record.itemId,
      revision: root.work.revision,
      text: root.record.intent,
    },
    sources,
    artifacts,
    ...(leadConversationId ? { leadConversationId } : {}),
  });
  // Recheck each selected boundary after traversing independent SQLite reads.
  for (const boundary of [target, ...ancestors])
    if (readTarget(boundary.record.itemId).work.revision !== boundary.work.revision)
      throw new Error('Selected work context changed during review');
  renderTelosWorkRoleContext(selected);
  return selected;
}

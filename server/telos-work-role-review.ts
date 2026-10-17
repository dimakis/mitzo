import { createHash } from 'node:crypto';
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
  selectedSourceSnapshotIds: string[];
  selectedArtifactRefs: TelosWorkRoleContextSelection['artifacts'];
}
/** Read only canonical work and retained references. No transcript/provider port exists. */
export function reviewTelosWorkRoleContext(
  input: TelosWorkRoleReviewInput,
): TelosWorkRoleContextSelection {
  const { work, actor, itemId, role } = input;
  const target = work.readSourceTarget(itemId, actor);
  if (/^life[-_ ]?ops$/i.test(target.record.profile))
    throw new Error('Selected role context unavailable');
  const ancestors: Array<ReturnType<TelosWorkStore['readSourceTarget']>> = [];
  const seen = new Set([itemId]);
  let parentId = target.record.parentId;
  while (parentId !== null) {
    if (seen.has(parentId) || ancestors.length >= 100)
      throw new Error('Selected work ancestry unavailable');
    seen.add(parentId);
    const parent = work.readSourceTarget(parentId, actor);
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
      artifact.itemId !== itemId ||
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
    role,
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
    if (work.read(boundary.record.itemId, actor).revision !== boundary.work.revision)
      throw new Error('Selected work context changed during review');
  renderTelosWorkRoleContext(selected);
  return selected;
}

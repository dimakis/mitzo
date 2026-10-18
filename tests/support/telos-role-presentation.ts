import { createHash, randomUUID } from 'node:crypto';
import { TelosWorkRoleContextSelectionSchema } from '../../packages/protocol/src/telos-work-role-context';
import { TelosWorkRoleContextReviewSchema } from '../../packages/protocol/src/telos-work-role-presentation';

interface Material {
  id: string;
  revision: number;
  sha256: string;
  filename: string;
  title: string;
  createdAt: string;
  sourceKind?:
    'user_upload' | 'user_edit' | 'session_artifact' | 'external_codex_report' | 'source_capture';
}
/** Synthetic HTTP fixture metadata, supplied by its real retained source/material
 * fixture owners. This helper does not read work, allocate, or qualify runtime. */
export function offlineRoleReview(
  raw: unknown,
  labels: {
    itemTitle: string;
    goalTitle: string;
    parents?: Record<string, string>;
    sources?: Record<string, { title: string | null; createdAt: string | null }>;
    materials: readonly Material[];
  },
) {
  const selection = TelosWorkRoleContextSelectionSchema.parse(raw);
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const pins = [
    ...new Map(
      [...selection.artifacts, ...selection.sources.flatMap((source) => source.artifacts)].map(
        (pin) => [JSON.stringify(pin), pin],
      ),
    ).values(),
  ];
  const presentation = {
    version: 1 as const,
    contextSha256: hash(selection),
    reviewedAt: '2026-10-18T10:00:00Z',
    item: { itemId: selection.itemId, revision: selection.brief.revision, title: labels.itemTitle },
    overallGoal: {
      itemId: selection.overallGoal.itemId,
      revision: selection.overallGoal.revision,
      title: labels.goalTitle,
    },
    parents: selection.parentCriteria.map((parent) => {
      const title = labels.parents?.[parent.itemId];
      if (title === undefined) throw Error('Fixture must supply its actual parent label');
      return { itemId: parent.itemId, revision: parent.revision, title };
    }),
    sources: selection.sources.map((source) => {
      const retained = labels.sources?.[source.snapshotId];
      if (!retained) throw Error('Fixture must supply its retained source labels');
      return { snapshotId: source.snapshotId, ...retained };
    }),
    artifacts: pins.map((pin) => {
      const material = labels.materials.find(
        (value) =>
          value.id === pin.artifactId &&
          value.revision === pin.revision &&
          value.sha256 === pin.sha256,
      );
      if (!material) throw Error('Fixture must supply its exact retained material metadata');
      return {
        ...pin,
        filename: material.filename,
        title: material.title,
        createdAt: material.createdAt,
        ...(material.sourceKind ? { sourceKind: material.sourceKind } : {}),
      };
    }),
  };
  return TelosWorkRoleContextReviewSchema.parse({
    version: 1,
    selection,
    presentation,
    presentationRef: { id: randomUUID(), sha256: hash(presentation) },
  });
}

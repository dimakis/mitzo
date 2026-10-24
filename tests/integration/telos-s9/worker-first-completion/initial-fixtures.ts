import type { createJoinedOrdinaryApplication } from '../integrated-candidate/joined-ordinary-application';

// Exact already-retained artifact worker profile from the closed final-worker
// carrier. Publish before allocation; never change a lead or admitted profile.
export const artifactDefinition = {
  name: 'Reviewed artifact worker',
  descriptor: 'Synthetic native artifact boundary',
  role: 'agent' as const,
  instructions: 'Read only selected immutable material and retain canonical output for review.',
  expectedOutput: 'Canonical attributed report',
  acceptanceCriteria: ['Exact revision and hash'],
  modelPolicyRole: 'agent' as const,
  tools: [
    'Write',
    'TelosSaveArtifact',
    'TelosReadArtifact',
    'TaskStatus',
    'TaskArtifact',
    'TaskComplete',
    'TaskBlock',
  ].map((name) => ({ id: 'mitzo:' + name, version: 1 })),
};

export const initializeFirstCompletionFixtures: NonNullable<
  Parameters<typeof createJoinedOrdinaryApplication>[1]
> = ({ runtime, canonical }) => {
  canonical.db
    .prepare(
      `INSERT INTO items
    (id,summary,intent,rationale,acceptance_criteria,profile,priority,parent_id,
     context_hints,first_seen,last_seen,created_at,updated_at)
    VALUES('recording-slice','Record one acoustic sample','Retain one reviewed sample',
      'Exact smallest child only','["Retain sample evidence"]','manual',7,'studio','{}',?,?,?,?)`,
    )
    .run(canonical.stamp, canonical.stamp, canonical.stamp, canonical.stamp);
  canonical.db
    .prepare(
      `INSERT INTO history(item_id,old_status,new_status,changed_at)
    VALUES('recording-slice',NULL,'active',?)`,
    )
    .run(canonical.stamp);
  runtime.library.saveDraft('user', {
    profileId: 's9-artifact-worker',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 's9-artifact-worker-draft',
    definition: artifactDefinition,
  });
  runtime.library.publish('user', {
    profileId: 's9-artifact-worker',
    expectedVersion: 1,
    idempotencyKey: 's9-artifact-worker-publish',
  });
};

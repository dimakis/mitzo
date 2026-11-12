import {
  TelosWorkRoleContextSelectionSchema,
  type TelosWorkRoleContextReview,
  type TelosSessionLaunchScope,
} from '@mitzo/protocol';
import { sha256Hex } from '../lib/browser-crypto';

export function telosSessionLaunchFixture() {
  const telos: TelosSessionLaunchScope = {
    version: 1,
    parentItemId: 'outcome',
    parentAssignmentRevision: 1,
    itemId: 'feature',
    expectedRevision: 'a'.repeat(64),
    role: 'lead',
    sourceSnapshotIds: [],
    artifactRefs: [],
  };
  const selection = TelosWorkRoleContextSelectionSchema.parse({
    version: 1,
    itemId: telos.itemId,
    itemKind: 'outcome',
    role: telos.role,
    brief: {
      revision: telos.expectedRevision,
      text: 'Make supported runtime capabilities visible to the user.',
      sha256: 'b'.repeat(64),
    },
    parentCriteria: [],
    overallGoal: {
      itemId: 'outcome',
      revision: 'c'.repeat(64),
      text: 'Reliable agent work sessions',
    },
    sources: [],
    artifacts: [],
  });
  const presentation: TelosWorkRoleContextReview['presentation'] = {
    version: 1,
    contextSha256: sha256Hex(JSON.stringify(selection)),
    reviewedAt: '2026-11-12T10:00:00Z',
    item: { itemId: telos.itemId, revision: telos.expectedRevision, title: 'Capability baseline' },
    overallGoal: {
      itemId: 'outcome',
      revision: selection.overallGoal.revision,
      title: 'Reliable agent work sessions',
    },
    parents: [],
    sources: [],
    artifacts: [],
  };
  const telosReview: TelosWorkRoleContextReview = {
    version: 1,
    selection,
    presentation,
    presentationRef: {
      id: 'a6134e10-087f-461c-b15a-eb299cedbc72',
      sha256: sha256Hex(JSON.stringify(presentation)),
    },
  };
  return { telos, telosReview };
}

import { createHash } from 'node:crypto';
import type { SourceSnapshot } from '@mitzo/protocol';

const content = JSON.stringify({
  version: 1,
  source: {
    kind: 'draft',
    profileId: 'diagnostician',
    baseRevision: 2,
    draftVersion: null,
    expectedVersion: 3,
  },
  definition: {
    name: 'Diagnostician',
    role: 'agent',
    instructions: 'Prove root cause.',
    expectedOutput: 'Evidence',
    acceptanceCriteria: ['Cite sources'],
    modelPolicyRole: 'agent',
  },
});
export const agentLibrarySource: SourceSnapshot = {
  kind: 'agent-library',
  revision: createHash('sha256').update(content).digest('hex'),
  content,
};

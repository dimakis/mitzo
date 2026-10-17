import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createS9Fixture, cleanupS9Fixtures } from './fixture.js';
import { TelosWorkStore } from '../../../server/telos-work-store.js';

afterEach(cleanupS9Fixtures);

// Explicit executable red evidence, not skipped tests or a passing assertion of
// broken behavior. Invoke the dedicated red config until the S5a fix is accepted.
it.each(['refine', 'child'] as const)(
  'CT01 red: advisor %s writes the actual canonical schema without fixture-only columns',
  async (operation) => {
    const f = await createS9Fixture();
    const work = new TelosWorkStore(f.dbPath, { ordinaryConversation: () => true });
    const actor = { kind: 'operator' as const, id: 's9-offline-operator' };
    try {
      work.execute(
        {
          operation: 'classify',
          itemId: 'outcome',
          requestId: 'kind',
          expectedRevision: work.read('outcome', actor).revision,
          kind: 'outcome',
        },
        actor,
      );
      const revision = work.read('outcome', actor).revision;
      const parentRevision = work.read('goal', actor).revision;
      const input = {
        requestId: randomUUID(),
        operation,
        itemId: 'outcome',
        advisorConversationId: 'source',
        expectedRevision: revision,
        parentId: operation === 'child' ? 'outcome' : 'goal',
        expectedParentRevision: operation === 'child' ? revision : parentRevision,
        proposed: {
          name: 'Reviewed plan',
          desiredOutcome: 'Retain exact result',
          type: operation === 'child' ? 'work_item' : 'outcome',
          category: 'Job',
        },
        selection: {
          requestId: randomUUID(),
          expectedMembershipRevision: 0,
          sourceConversationId: 'source',
          mode: 'selected',
          boundary: { sequence: 1, messageId: 'review' },
          messageIds: ['review'],
          artifacts: [],
          purpose: 'Reviewed advisor change',
          joiningBrief: '',
        },
        previewSha256: 'a'.repeat(64),
      };
      expect(() =>
        work.saveAdvisorDraft(
          input,
          actor,
          (_database, itemId) => ({
            version: 1,
            snapshotId: randomUUID(),
            itemId,
            source: { namespace: 'mitzo', conversationId: 'source' },
            selection: {
              kind: 'selected',
              messageIds: ['review'],
              blockIds: [],
              throughSequence: 1,
            },
            adoptedBrief: null,
            artifacts: [],
            author: null,
            sourceCreatedAt: null,
            adoptedAt: null,
          }),
          () => {},
        ),
      ).not.toThrow();
    } finally {
      work.close();
    }
  },
);

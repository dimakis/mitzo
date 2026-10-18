import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createS9Fixture, cleanupS9Fixtures } from './fixture.js';
import { TelosWorkStore } from '../../../server/telos-work-store.js';

afterEach(cleanupS9Fixtures);

it.each(['refine', 'child'] as const)(
  'CT01 full-route red: reviewed %s advisor saves through actual setup, capture, HTTP and typed client',
  async (operation) => {
    const f = await createS9Fixture();
    await f.api.execute({
      operation: 'classify',
      itemId: 'outcome',
      requestId: 'kind',
      expectedRevision: (await f.api.read('outcome')).revision,
      kind: 'outcome',
    });
    const contextSelection = await f.api.roleContext({
      itemId: 'outcome',
      role: 'advisor',
      advisorPurpose: operation,
      sourceSnapshotIds: [],
      artifactRefs: [],
    });
    const prepared = await f.api.setupRole({
      itemId: 'outcome',
      role: 'advisor',
      requestId: 'advisor',
      expectedRevision: contextSelection.brief.revision,
      expectedAssignmentRevision: null,
      settings: f.ordinary.input.settings,
      contextSelection,
    });
    const advisorConversationId = prepared.work.links.find((link) => link.role === 'advisor')!
      .conversation.conversationId;
    const sequence = f.events.append(advisorConversationId, 'user_message', {
      messageId: 'reviewed-draft',
      text: 'Save this exact reviewed advisor proposal.',
    });
    const expectedRevision = (await f.api.read('outcome')).revision;
    const proposal = {
      requestId: randomUUID(),
      operation,
      itemId: 'outcome',
      advisorConversationId,
      expectedRevision,
      parentId: operation === 'child' ? 'outcome' : 'goal',
      expectedParentRevision:
        operation === 'child' ? expectedRevision : (await f.api.read('goal')).revision,
      proposed: {
        name: 'Reviewed proposal',
        desiredOutcome: 'Retain this exact result',
        type: operation === 'child' ? ('work_item' as const) : ('outcome' as const),
        category: 'Job',
      },
      selection: {
        requestId: randomUUID(),
        expectedMembershipRevision: 0,
        sourceConversationId: advisorConversationId,
        mode: 'selected' as const,
        boundary: { sequence, messageId: 'reviewed-draft' },
        messageIds: ['reviewed-draft'],
        artifacts: [],
        purpose: 'Save reviewed proposal',
        joiningBrief: '',
      },
    };
    const preview = await f.api.previewAdvisorDraft(proposal);
    await expect(
      f.api.saveAdvisorDraft({ ...proposal, previewSha256: preview.sha256 }),
    ).resolves.toMatchObject({ actorId: 'operator:s9-offline-operator' });
  },
);

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

import { mergeConfig } from 'vitest/config';
import base from './vitest.config';

export default mergeConfig(base, {
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    include: [
      'server/__tests__/symposium-acceptance-*.test.ts',
      ...(process.env.SYMPOSIUM_ARTIFACT_CANDIDATE === '1'
        ? [
            'tests/acceptance/*.candidate.ts',
            'server/__tests__/collaboration-forwarding.test.ts',
            'server/__tests__/collaboration-forward-save-fence.test.ts',
            'server/__tests__/collaboration-retained-artifact-source.test.ts',
            'packages/protocol/__tests__/collaboration-forward-storage.test.ts',
            'server/__tests__/collaboration-forward-contract.test.ts',
            'server/__tests__/collaboration-forward-browser-boundary.test.ts',
            'server/__tests__/collaboration-forward-ordinary-delivery.test.ts',
          ]
        : []),
      ...(process.env.SYMPOSIUM_OWNER_CONTRACTS === '1'
        ? [
            'server/__tests__/collaboration-review-owner.test.ts',
            'server/__tests__/collaboration-joining-owner.test.ts',
            'server/__tests__/collaboration-ordinary-delivery.test.ts',
            'server/__tests__/collaboration-ordinary-replies.test.ts',
            'server/__tests__/session-collaboration-joining-router.test.ts',
            'server/__tests__/collaboration-conversation-router.test.ts',
            'packages/protocol/__tests__/collaboration-conversation.test.ts',
            'packages/client/src/__tests__/collaboration-conversation.test.ts',
            'packages/client/src/__tests__/collaboration-associations.test.ts',
          ]
        : []),
      ...(process.env.SYMPOSIUM_REQUIRED_JOURNEYS === '1' ? ['tests/acceptance/*.repro.ts'] : []),
    ],
  },
});

import { mergeConfig } from 'vitest/config';
import base from '../../../../vitest.config';

// Reuse the published owner contracts unchanged. Each has one required macOS
// case; the runner rejects missing files, partial execution and platform skips.
export default mergeConfig(base, {
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    include: [
      'server/__tests__/telos-ordinary-canonical-journey.test.ts',
      'server/__tests__/agent-communication-nongit-app.test.ts',
      'server/__tests__/telos-coordinator-v2-native-journey.test.ts',
    ],
  },
});

import { mergeConfig } from 'vitest/config';
import base from '../../../../vitest.config';
export default mergeConfig(base, {
  test: {
    // Native repository and non-git journeys share the CI outer envelope.
    // Keep the tighter local bound and every inner operation deadline.
    testTimeout: process.env.CI ? 180_000 : 120_000,
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
    include: [
      'tests/integration/telos-s9/integrated-candidate/native-complete-non-git.contract.ts',
    ],
  },
});

import { mergeConfig } from 'vitest/config';
import base from '../../../../vitest.config';
export default mergeConfig(base, {
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
    testTimeout: 120_000,
    include: ['tests/integration/telos-s9/model-readiness/model-readiness.contract.ts'],
  },
});

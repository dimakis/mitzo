import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../../../../vitest.config.js';
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: [
        'tests/integration/telos-s9/coherent-final-preparation/coherent-app.contract.ts',
        'tests/integration/telos-s9/resume-acceptance/positive-purge-recovery.contract.ts',
      ],
      maxWorkers: 1,
      fileParallelism: false,
      retry: 0,
      testTimeout: 120_000,
    },
  }),
);

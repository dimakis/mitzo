import { mergeConfig, defineConfig } from 'vitest/config';
import base from '../../../../vitest.config.js';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tests/integration/telos-s9/coherent-final-preparation/coherent-app.contract.ts'],
      maxWorkers: 1,
      fileParallelism: false,
      testTimeout: 120_000,
      retry: 0,
    },
  }),
);

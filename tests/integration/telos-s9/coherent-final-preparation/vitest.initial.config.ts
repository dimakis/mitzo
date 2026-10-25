import { mergeConfig, defineConfig } from 'vitest/config';
import base from '../../../../vitest.config.js';
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tests/integration/telos-s9/coherent-final-preparation/initial-app.carrier.ts'],
      maxWorkers: 1,
      fileParallelism: false,
      testTimeout: 70_000,
      retry: 0,
    },
  }),
);

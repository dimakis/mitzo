import { mergeConfig, defineConfig } from 'vitest/config';
import base from '../../../vitest.config.js';

export default mergeConfig(
  base,
  defineConfig({
    test: { include: ['tests/integration/telos-s9/*.red-contract.ts'], maxWorkers: 1 },
  }),
);

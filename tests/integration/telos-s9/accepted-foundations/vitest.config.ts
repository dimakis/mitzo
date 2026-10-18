import { mergeConfig, defineConfig } from 'vitest/config';
import base from '../../../../vitest.config';
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: [
        'tests/integration/telos-s9/accepted-foundations/vertical.contract.ts',
        'tests/integration/telos-s9/accepted-foundations/recovery.contract.tsx',
      ],
      maxWorkers: 1,
    },
  }),
);

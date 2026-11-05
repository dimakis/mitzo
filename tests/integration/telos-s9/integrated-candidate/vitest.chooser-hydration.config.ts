import { mergeConfig } from 'vitest/config';
import base from './supplemental-vitest-base';
export default mergeConfig(base, {
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    include: [
      'tests/integration/telos-s9/integrated-candidate/chooser-hydration-browser.contract.ts',
    ],
  },
});

import { mergeConfig } from 'vitest/config';
import base from '../../../../vitest.config';
export default mergeConfig(base, {
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    include: [
      'tests/integration/telos-s9/integrated-candidate/legacy-backup-process-browser.contract.ts',
    ],
  },
});

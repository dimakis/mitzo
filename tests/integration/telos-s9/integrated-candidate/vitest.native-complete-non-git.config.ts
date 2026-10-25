import { mergeConfig } from 'vitest/config';
import base from '../../../../vitest.config';
export default mergeConfig(base, {
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
    include: [
      'tests/integration/telos-s9/integrated-candidate/native-complete-non-git.contract.ts',
    ],
  },
});

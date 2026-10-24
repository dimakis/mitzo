import { mergeConfig } from 'vitest/config';
import base from '../../../../vitest.config';

// Required red evidence is run explicitly and retained. No skip/xfail, guessed
// provider API or helper-only substitute may turn this into acceptance.
export default mergeConfig(base, {
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    include: [
      'tests/integration/telos-s9/integrated-candidate/peer-messaging.required-contract.ts',
    ],
  },
});

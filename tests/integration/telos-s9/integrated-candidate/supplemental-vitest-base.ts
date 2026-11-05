import { mergeConfig } from 'vitest/config';
import base from '../../../../vitest.config';

export default mergeConfig(base, {
  test: {
    setupFiles: ['tests/integration/telos-s9/integrated-candidate/portable-supplemental-setup.ts'],
  },
});

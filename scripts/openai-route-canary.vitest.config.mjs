import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const fromRoot = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@mitzo/protocol/event-store': fromRoot('packages/protocol/src/event-store.ts'),
      '@mitzo/protocol': fromRoot('packages/protocol/src/index.ts'),
      '@mitzo/client/hooks': fromRoot('packages/client/src/hooks/index.ts'),
      '@mitzo/client': fromRoot('packages/client/src/index.ts'),
      '@mitzo/harness': fromRoot('packages/harness/src/index.ts'),
      react: fromRoot('node_modules/react'),
      'react-dom': fromRoot('node_modules/react-dom'),
      'react-router-dom': fromRoot('node_modules/react-router-dom'),
      '@testing-library/react': fromRoot('node_modules/@testing-library/react'),
      '@testing-library/jest-dom': fromRoot('node_modules/@testing-library/jest-dom'),
      '@testing-library/user-event': fromRoot('node_modules/@testing-library/user-event'),
    },
  },
  test: {
    env: {
      NODE_ENV: 'test',
      AUTH_PASSPHRASE: 'test-passphrase-for-vitest',
      AUTH_SECRET: 'test-secret-that-is-definitely-long-enough-for-hs256',
      COOKIE_MAX_AGE_HOURS: '1',
    },
  },
});

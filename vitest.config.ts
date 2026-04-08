import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      AUTH_PASSPHRASE: 'test-passphrase-for-vitest',
      AUTH_SECRET: 'test-secret-that-is-definitely-long-enough-for-hs256',
      COOKIE_MAX_AGE_HOURS: '1',
    },
  },
});

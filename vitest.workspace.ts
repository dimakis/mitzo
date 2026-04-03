import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'server',
      include: ['server/__tests__/**/*.test.ts'],
      environment: 'node',
      env: {
        AUTH_PASSPHRASE: 'test-passphrase-for-vitest',
        AUTH_SECRET: 'test-secret-that-is-definitely-long-enough-for-hs256',
        COOKIE_MAX_AGE_HOURS: '1',
      },
    },
  },
  {
    test: {
      name: 'frontend',
      include: ['frontend/src/**/__tests__/**/*.test.{ts,tsx}'],
      environment: 'jsdom',
    },
  },
]);

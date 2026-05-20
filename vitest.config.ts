import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve workspace packages to local source (worktree-safe)
      '@mitzo/protocol/event-store': resolve(__dirname, 'packages/protocol/src/event-store.ts'),
      '@mitzo/protocol': resolve(__dirname, 'packages/protocol/src/index.ts'),
      // With npm workspaces, deps are hoisted to root node_modules
      react: resolve(__dirname, 'node_modules/react'),
      'react-dom': resolve(__dirname, 'node_modules/react-dom'),
      'react-router-dom': resolve(__dirname, 'node_modules/react-router-dom'),
      '@testing-library/react': resolve(__dirname, 'node_modules/@testing-library/react'),
      '@testing-library/jest-dom': resolve(__dirname, 'node_modules/@testing-library/jest-dom'),
      '@testing-library/user-event': resolve(__dirname, 'node_modules/@testing-library/user-event'),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, '**/.claude/worktrees/**', '**/.cursor/worktrees/**'],
    env: {
      NODE_ENV: 'test',
      AUTH_PASSPHRASE: 'test-passphrase-for-vitest',
      AUTH_SECRET: 'test-secret-that-is-definitely-long-enough-for-hs256',
      COOKIE_MAX_AGE_HOURS: '1',
    },
  },
});

import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'path';
import CiUnitSequencer from './scripts/ci-unit-sequencer';

export default defineConfig({
  resolve: {
    alias: {
      'vitest-environment-node-compatible-dom': resolve(
        __dirname,
        'tests/support/node-compatible-dom.ts',
      ),
      // Resolve workspace packages to local source (worktree-safe)
      '@mitzo/protocol/database-backup': resolve(
        __dirname,
        'packages/protocol/src/database-backup.ts',
      ),
      '@mitzo/protocol/telos-sqlite-owners': resolve(
        __dirname,
        'packages/protocol/src/telos-sqlite-owners.ts',
      ),
      '@mitzo/protocol/event-store': resolve(__dirname, 'packages/protocol/src/event-store.ts'),
      '@mitzo/protocol/collaboration-forward-custody': resolve(
        __dirname,
        'packages/protocol/src/collaboration-forward-custody.ts',
      ),
      '@mitzo/protocol': resolve(__dirname, 'packages/protocol/src/index.ts'),
      '@mitzo/client/hooks': resolve(__dirname, 'packages/client/src/hooks/index.ts'),
      '@mitzo/client': resolve(__dirname, 'packages/client/src/index.ts'),
      '@mitzo/harness': resolve(__dirname, 'packages/harness/src/index.ts'),
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
    sequence: { sequencer: CiUnitSequencer },
    // The native/configuration adapter reads literal values from the shared
    // stylesheet; do not replace its ?raw import with Vitest's empty CSS stub.
    css: { include: [/tokens\.css/] },
    exclude: [
      ...configDefaults.exclude,
      '**/dist/**', // Workspace builds emit test copies; run their source only.
      '**/.claude/worktrees/**',
      '**/.cursor/worktrees/**',
      'tests/browser/**',
      'tests/offline/**',
    ],
    env: {
      NODE_ENV: 'test',
      // Model metadata is offline test data; tests never fetch the public catalog.
      MITZO_MODEL_LIMITS_CATALOG_FILE: resolve(
        __dirname,
        'server/__tests__/fixtures/empty-model-limits.json',
      ),
      AUTH_PASSPHRASE: 'test-passphrase-for-vitest',
      AUTH_SECRET: 'test-secret-that-is-definitely-long-enough-for-hs256',
      COOKIE_MAX_AGE_HOURS: '1',
    },
  },
});

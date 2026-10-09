import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepositoryWorkspaceForConversation } from '../repository-workspace-runtime.js';
const root = mkdtempSync(join(tmpdir(), 'repository-ledger-loss-'));
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
it('refuses repository resume if the private claim database is absent and never creates a replacement ledger', () => {
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', root);
  expect(readRepositoryWorkspaceForConversation('ordinary-chat')).toBeUndefined();
  expect(() => readRepositoryWorkspaceForConversation('repository-chat', 'source-id')).toThrow(
    'Repository claim ledger is unavailable',
  );
  expect(existsSync(join(root, 'repository-sources', 'workspaces.db'))).toBe(false);
});

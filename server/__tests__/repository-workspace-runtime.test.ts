import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRepositoryWorkspaceForConversation,
  repositoryWorkspaceCatalog,
} from '../repository-workspace-runtime.js';
const runtime = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../connections-runtime.js', () => ({
  getConnectionsRuntime: () => ({ store: { list: runtime.list } }),
}));
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

it('offers only repositories whose account scope resolves to one publication connection', () => {
  vi.stubEnv('MITZO_REPOSITORY_WORKSPACES_ENABLED', '1');
  const connection = (id: string, repositories: string[], extra = {}) => ({
    id,
    label: id,
    templateId: 'github-readonly',
    status: 'active',
    desiredAccountIds: ['account'],
    identity: { login: 'operator' },
    publicConfig: { allowedRepositories: repositories },
    ...extra,
  });
  runtime.list.mockReturnValue([
    connection('one', ['Example/Overlap', 'example/unique', 'example/unique']),
    connection('two', ['example/overlap']),
    connection('other-account', ['example/unique'], { desiredAccountIds: ['other'] }),
    connection('inactive', ['example/unique'], { status: 'disabled' }),
    connection('no-identity', ['example/blocked'], { identity: null }),
    connection('identified', ['example/blocked']),
  ]);
  expect(repositoryWorkspaceCatalog({ accountId: 'account' } as never)).toEqual({
    available: true,
    repositories: [{ connectionId: 'one', label: 'one', repository: 'example/unique' }],
  });
});

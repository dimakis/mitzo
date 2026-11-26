import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRepositoryWorkspaceForConversation,
  repositoryWorkspaceBinding,
  repositoryWorkspaceCatalog,
  repositoryWorkspaceSourceInventory,
} from '../repository-workspace-runtime.js';
const runtime = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../connections-runtime.js', () => ({
  getConnectionsRuntime: () => ({ store: { list: runtime.list } }),
}));
const profiles = vi.hoisted(() => ({
  resolve: vi.fn(),
  ordinaryLocalVertexInventory: vi.fn(),
}));
vi.mock('../account-profiles.js', () => ({ loadAccountProfiles: () => profiles }));
const root = mkdtempSync(join(tmpdir(), 'repository-ledger-loss-'));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
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

/** Every local Claude provider is eligible on the same terms as Codex: the
 * connection's account scope decides, never the provider type. */
const claudeProviders = ['anthropic-claude', 'anthropic-vertex', 'anthropic-api'] as const;

function assignedGithubConnection(repositories: string[] = ['dimakis/mitzo']) {
  return {
    id: 'github',
    label: 'GitHub',
    templateId: 'github-readonly',
    status: 'active',
    desiredAccountIds: ['claude-account'],
    identity: { login: 'operator' },
    publicConfig: { allowedRepositories: repositories },
  };
}

it.each(claudeProviders)('offers a repository source to an assigned %s account', (provider) => {
  vi.stubEnv('MITZO_REPOSITORY_WORKSPACES_ENABLED', '1');
  runtime.list.mockReturnValue([assignedGithubConnection()]);
  const binding = { accountId: 'claude-account', provider };
  expect(repositoryWorkspaceSourceInventory(binding as never)).toEqual({
    available: true,
    repositories: [{ connectionId: 'github', label: 'GitHub', repository: 'dimakis/mitzo' }],
    reason: undefined,
  });
  expect(Object.keys(repositoryWorkspaceCatalog(binding as never))).toEqual([
    'available',
    'repositories',
  ]);
});

it.each(claudeProviders)('authorizes repository chats for an assigned %s account', (provider) => {
  vi.stubEnv('MITZO_ORDINARY_LOCAL_VERTEX_ENABLED', '1');
  const binding = { accountId: 'claude-account', provider, profileRevision: 'revision-1' };
  profiles.resolve.mockReturnValue(binding);
  profiles.ordinaryLocalVertexInventory.mockReturnValue([
    { account: { accountId: 'claude-account', profileRevision: 'revision-1' } },
  ]);
  expect(repositoryWorkspaceBinding('claude-account', 'model')).toBe(binding);
});

it('refuses repository chats for a Claude account the ordinary local gate has not admitted', () => {
  vi.stubEnv('MITZO_ORDINARY_LOCAL_VERTEX_ENABLED', '0');
  const binding = { accountId: 'claude-account', provider: 'anthropic-claude' };
  profiles.resolve.mockReturnValue(binding);
  profiles.ordinaryLocalVertexInventory.mockReturnValue([]);
  expect(() => repositoryWorkspaceBinding('claude-account', 'model')).toThrow(
    'Selected account is unavailable for repository chats',
  );
});

it('names an unassigned account as the reason it has no repository source', () => {
  vi.stubEnv('MITZO_REPOSITORY_WORKSPACES_ENABLED', '1');
  runtime.list.mockReturnValue([
    { ...assignedGithubConnection(), desiredAccountIds: ['another-account'] },
  ]);
  expect(
    repositoryWorkspaceSourceInventory({
      accountId: 'claude-account',
      provider: 'anthropic-claude',
    } as never),
  ).toEqual({
    available: true,
    repositories: [],
    reason: 'repository_scope_not_assigned',
  });
});

it('names the missing connection when no active GitHub connection is available', () => {
  vi.stubEnv('MITZO_REPOSITORY_WORKSPACES_ENABLED', '1');
  runtime.list.mockReturnValue([
    { ...assignedGithubConnection(), status: 'disabled' },
    { ...assignedGithubConnection(), templateId: 'custom' },
  ]);
  expect(repositoryWorkspaceSourceInventory({ accountId: 'claude-account' } as never)).toEqual({
    available: true,
    repositories: [],
    reason: 'repository_connection_unavailable',
  });
});

it('names an unverified assigned connection instead of offering it silently', () => {
  vi.stubEnv('MITZO_REPOSITORY_WORKSPACES_ENABLED', '1');
  runtime.list.mockReturnValue([{ ...assignedGithubConnection(), identity: null }]);
  expect(repositoryWorkspaceSourceInventory({ accountId: 'claude-account' } as never)).toEqual({
    available: true,
    repositories: [],
    reason: 'repository_connection_unverified',
  });
});

it('names ambiguous account scope when two assigned connections claim the same repository', () => {
  vi.stubEnv('MITZO_REPOSITORY_WORKSPACES_ENABLED', '1');
  runtime.list.mockReturnValue([
    assignedGithubConnection(),
    { ...assignedGithubConnection(), id: 'second', label: 'Second' },
  ]);
  expect(
    repositoryWorkspaceSourceInventory({ accountId: 'claude-account' } as never),
  ).toMatchObject({
    available: true,
    repositories: [],
    reason: 'repository_scope_ambiguous',
  });
});

it('names disabled repository workspaces when the feature is off', () => {
  vi.stubEnv('MITZO_REPOSITORY_WORKSPACES_ENABLED', '0');
  runtime.list.mockReturnValue([assignedGithubConnection()]);
  expect(repositoryWorkspaceSourceInventory({ accountId: 'claude-account' } as never)).toEqual({
    available: false,
    repositories: [],
    reason: 'repository_workspaces_disabled',
  });
});

// Cross-layer contracts belong outside the server-only TypeScript source root.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountBinding } from '@mitzo/protocol';
import { SessionRegistry } from '@mitzo/harness';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepositoryWorkspaces } from '../../server/repository-workspaces.js';
import {
  RepositorySourceLimitError,
  RepositorySpaceError,
} from '../../server/github-repository-source.js';
import { repositoryChatPreparationResultSchema } from '../../frontend/src/lib/repository-chat-preparation';

const runtime = vi.hoisted(() => ({
  enabled: vi.fn(),
  binding: vi.fn(),
  catalog: vi.fn(),
  service: vi.fn(),
  prepareChat: vi.fn(),
  chatPreparation: vi.fn(),
}));
vi.mock('../../server/repository-workspace-runtime.js', () => ({
  repositoryWorkspacesEnabled: runtime.enabled,
  repositoryWorkspaceBinding: runtime.binding,
  repositoryWorkspaceCatalog: runtime.catalog,
  getRepositoryWorkspaces: runtime.service,
}));
import { sessionRepositoryTools } from '../../server/repository-chat-tools.js';

const binding = {
  accountId: 'offline-account',
  provider: 'openai',
  model: 'offline-fixture',
  profileRevision: 'revision-1',
} as AccountBinding;
const id = 'bd2b2d1f-7fa1-430e-84b9-7e320ed02c34';
const draft = {
  id,
  sourceConversationId: 'session',
  repository: 'example/repo',
  baseBranch: 'main',
  baseOid: 'a'.repeat(40),
  featureBranch: 'mitzo/repo-task',
  state: 'ready',
  accountId: binding.accountId,
  model: binding.model,
  prompt: 'Fix the failing test',
  setupUrl: `/chat?repositoryPreparation=${id}`,
};
const registries: SessionRegistry[] = [];
const services: RepositoryWorkspaces[] = [];
const roots: string[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  runtime.enabled.mockReturnValue(true);
  runtime.binding.mockImplementation((accountId, model) => ({ ...binding, accountId, model }));
  runtime.catalog.mockReturnValue({
    available: true,
    repositories: [{ connectionId: 'github', label: 'Fixture', repository: 'example/repo' }],
  });
  runtime.service.mockReturnValue(runtime);
  runtime.prepareChat.mockResolvedValue(draft);
  runtime.chatPreparation.mockReturnValue(draft);
});
afterEach(async () => {
  registries.splice(0).forEach((registry) => registry.dispose());
  services.splice(0).forEach((service) => service.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fixture(prefix = '') {
  const registry = new SessionRegistry();
  registries.push(registry);
  registry.register('client', {
    sessionId: 'session',
    mode: 'agent',
    abortController: new AbortController(),
    accountBinding: { ...binding },
    model: binding.model,
    cwd: '/unchanged-workspace',
    activeSkillPolicy: null,
  } as never);
  const session = registry.get('client')!;
  return { session, registry, tools: sessionRepositoryTools('session', session, registry, prefix) };
}
const signal = () => new AbortController().signal;

it.each([
  [new RepositorySpaceError(), 'repository_space', '3 GiB'],
  [new RepositorySourceLimitError('storage'), 'repository_source_limit', '512 MiB'],
  [new RepositorySourceLimitError('expanded source'), 'repository_source_limit', '512 MiB'],
  [new Error('private credential /private/source'), undefined, undefined],
] as const)(
  'retains a sanitized acquisition failure through the real service and tool recovery (%s)',
  async (error, code, message) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-tool-preparation-')));
    roots.push(root);
    // Even an error's mutable message must not expose raw paths or credentials.
    error.message = 'private credential /private/source';
    const acquire = vi.fn(async () => {
      throw error;
    });
    const deps = {
      authorize: async () => ({ revision: 1, allowedBaseBranches: ['main'] }),
      inspect: async () => ({
        repository: 'example/repo',
        baseBranch: 'main',
        baseOid: 'a'.repeat(40),
      }),
      prepare: acquire,
    };
    const open = () => {
      const service = new RepositoryWorkspaces(join(root, 'private'), deps);
      services.push(service);
      runtime.service.mockReturnValue(service);
      return service;
    };
    const service = open();
    const { tools } = fixture();
    const input = { repository: 'example/repo', prompt: draft.prompt };
    const result = await tools.execute('PrepareRepositoryChat', input, signal());
    expect(result?.isError).toBe(true);
    const failed = JSON.parse(result!.content).repositoryChat;
    expect(
      repositoryChatPreparationResultSchema.safeParse({ repositoryChat: failed }).success,
    ).toBe(true);
    expect(failed.state).toBe('failed');
    if (code) expect(failed.failure).toEqual({ code, message: expect.stringContaining(message) });
    else expect(failed).not.toHaveProperty('failure');
    expect(failed.setupUrl).toContain(failed.id);
    expect(result!.content).not.toContain('private credential');
    service.close();
    services.splice(services.indexOf(service), 1);
    open();
    const recovered = await tools.execute('GetRepositoryChatPreparation', {}, signal());
    expect(JSON.parse(recovered!.content).repositoryChat).toEqual(failed);
    const retried = await tools.execute('PrepareRepositoryChat', input, signal());
    expect(retried).toEqual(result);
    expect(acquire).toHaveBeenCalledOnce();
  },
);

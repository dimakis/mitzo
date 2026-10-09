import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountBinding } from '@mitzo/protocol';
import { SessionRegistry } from '@mitzo/harness';
import { z } from 'zod';

const runtime = vi.hoisted(() => ({
  enabled: vi.fn(),
  binding: vi.fn(),
  catalog: vi.fn(),
  service: vi.fn(),
  prepareChat: vi.fn(),
  chatPreparation: vi.fn(),
}));
vi.mock('../repository-workspace-runtime.js', () => ({
  repositoryWorkspacesEnabled: runtime.enabled,
  repositoryWorkspaceBinding: runtime.binding,
  repositoryWorkspaceCatalog: runtime.catalog,
  getRepositoryWorkspaces: runtime.service,
}));
import {
  REPOSITORY_CHAT_INSTRUCTIONS,
  repositoryChatSchemas,
  repositoryChatToolDefinitions,
  sessionRepositoryTools,
} from '../repository-chat-tools.js';

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
afterEach(() => registries.splice(0).forEach((registry) => registry.dispose()));

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

it('exports the strict SDK schemas and matching runtime definitions', () => {
  const { tools } = fixture();
  expect(tools.definitions).toBe(repositoryChatToolDefinitions);
  expect(repositoryChatToolDefinitions.map((tool) => tool.name)).toEqual(
    Object.keys(repositoryChatSchemas),
  );
  for (const definition of repositoryChatToolDefinitions) {
    const schema = repositoryChatSchemas[definition.name as keyof typeof repositoryChatSchemas];
    expect(definition.input_schema).toEqual(z.toJSONSchema(schema));
    expect(schema.safeParse({ unexpected: 'forged-routing' }).success).toBe(false);
  }
  expect(repositoryChatSchemas.GetRepositoryChatPreparation.safeParse({}).success).toBe(true);
});

it('exposes strict tool definitions and concise separate-chat review instructions', () => {
  const { tools } = fixture();
  expect(tools.definitions.map((tool) => tool.name)).toEqual([
    'ListRepositories',
    'PrepareRepositoryChat',
    'GetRepositoryChatPreparation',
  ]);
  for (const definition of tools.definitions) {
    expect(definition.input_schema.additionalProperties).toBe(false);
    expect(Object.keys(definition.input_schema.properties ?? {})).not.toContain('accountId');
    expect(Object.keys(definition.input_schema.properties ?? {})).not.toContain('connectionId');
  }
  expect(REPOSITORY_CHAT_INSTRUCTIONS).toMatch(/separate chat/i);
  expect(REPOSITORY_CHAT_INSTRUCTIONS).toMatch(/review/i);
  expect(runtime.service).not.toHaveBeenCalled();
});

it('discovers the authorized catalog using the current session account and model', async () => {
  const { session, tools } = fixture();
  session.model = 'new-offline-fixture';
  const result = await tools.execute('ListRepositories', {}, signal());
  expect(result?.isError).toBe(false);
  expect(JSON.parse(result!.content)).toEqual(runtime.catalog.mock.results[0].value);
  expect(runtime.binding).toHaveBeenCalledWith(binding.accountId, session.model);
  expect(runtime.service).not.toHaveBeenCalled();
});

it.each(['agent', 'auto'] as const)(
  'prepares a canonical repository handoff in %s mode without changing the workspace',
  async (mode) => {
    const { session, tools } = fixture();
    session.mode = mode;
    const result = await tools.execute(
      'PrepareRepositoryChat',
      { repository: 'https://github.com/Example/Repo.git', prompt: draft.prompt },
      signal(),
    );
    expect(result?.isError).toBe(false);
    expect(JSON.parse(result!.content)).toEqual({ repositoryChat: draft });
    expect(runtime.prepareChat).toHaveBeenCalledWith(
      binding,
      'session',
      'github',
      'example/repo',
      draft.prompt,
      expect.any(AbortSignal),
    );
    expect(session.cwd).toBe('/unchanged-workspace');
  },
);

it('reads only a preparation owned by the current source chat and binding', async () => {
  const { tools } = fixture();
  const result = await tools.execute(
    'GetRepositoryChatPreparation',
    { preparationId: id },
    signal(),
  );
  expect(result?.isError).toBe(false);
  expect(runtime.chatPreparation).toHaveBeenCalledWith(id, binding, 'session');
  expect(runtime.prepareChat).not.toHaveBeenCalled();
});

it('recovers the latest owned preparation when a lost response omitted its ID', async () => {
  const { tools } = fixture();
  const result = await tools.execute('GetRepositoryChatPreparation', {}, signal());
  expect(result?.isError).toBe(false);
  expect(JSON.parse(result!.content)).toEqual({ repositoryChat: draft });
  expect(runtime.chatPreparation).toHaveBeenCalledWith(undefined, binding, 'session');
  expect(runtime.prepareChat).not.toHaveBeenCalled();
  expect(REPOSITORY_CHAT_INSTRUCTIONS).toMatch(/once.*(?:missing|lost).*ID/i);
});

it.each(['owner', 'binding', 'model', 'cancel'])(
  'fences missing-ID recovery if %s changes while reading the owned draft',
  async (condition) => {
    const { tools, session, registry } = fixture();
    runtime.chatPreparation.mockImplementation(() => {
      if (condition === 'owner')
        registry.register('client', {
          sessionId: 'session',
          abortController: new AbortController(),
        } as never);
      if (condition === 'binding') session.accountBinding = { ...binding, accountId: 'other' };
      if (condition === 'model') session.model = 'different';
      if (condition === 'cancel') session.abortController.abort();
      return draft;
    });
    const result = await tools.execute('GetRepositoryChatPreparation', {}, signal());
    expect(runtime.chatPreparation).toHaveBeenCalledWith(undefined, binding, 'session');
    expect(result?.isError).toBe(true);
    expect(result?.content).not.toContain(draft.setupUrl);
  },
);

it.each(['accountId', 'connectionId', 'cwd', 'model'])(
  'refuses caller-supplied routing input %s',
  async (key) => {
    const { tools } = fixture();
    const result = await tools.execute(
      'PrepareRepositoryChat',
      { repository: 'example/repo', prompt: draft.prompt, [key]: 'forged' },
      signal(),
    );
    expect(result?.isError).toBe(true);
    expect(runtime.service).not.toHaveBeenCalled();
  },
);
it.each([
  ['PrepareRepositoryChat', { repository: 'example/repo', prompt: '' }],
  ['PrepareRepositoryChat', { repository: 'example/repo', prompt: 'x'.repeat(8001) }],
  ['GetRepositoryChatPreparation', { preparationId: 'not-a-uuid' }],
  ['ListRepositories', { cwd: '/forged' }],
])('refuses malformed %s input before acquiring a service', async (name, input) => {
  const { tools } = fixture();
  expect(
    (await tools.execute(name as string, input as Record<string, unknown>, signal()))?.isError,
  ).toBe(true);
  expect(runtime.service).not.toHaveBeenCalled();
});

it.each(['ask', 'pending-ask'])(
  'refuses preparation in %s with a mode remedy before catalog or service access',
  async (mode) => {
    const { session, tools } = fixture();
    if (mode === 'ask') session.mode = 'ask';
    else session.pendingPermissionModes = new Map([[Symbol(), 'ask']]);
    const result = await tools.execute(
      'PrepareRepositoryChat',
      { repository: 'example/repo', prompt: draft.prompt },
      signal(),
    );
    expect(result?.isError).toBe(true);
    expect(result?.content).toMatch(/Agent.*Auto/i);
    expect(runtime.catalog).not.toHaveBeenCalled();
    expect(runtime.service).not.toHaveBeenCalled();
  },
);

it.each(['disabled', 'unsupported', 'missing-binding'])(
  'gives a useful result without acquisition when %s',
  async (condition) => {
    const { session, tools } = fixture();
    if (condition === 'disabled') runtime.enabled.mockReturnValue(false);
    if (condition === 'unsupported')
      runtime.binding.mockImplementation(() => {
        throw new Error('Native Symposium accounts are unavailable');
      });
    if (condition === 'missing-binding') session.accountBinding = undefined;
    const result = await tools.execute(
      'PrepareRepositoryChat',
      { repository: 'example/repo', prompt: draft.prompt },
      signal(),
    );
    expect(result?.isError).toBe(true);
    expect(result!.content.length).toBeGreaterThan(15);
    expect(runtime.service).not.toHaveBeenCalled();
  },
);

it.each(['none', 'ambiguous', 'invalid-host'])(
  'refuses a %s repository selection before preparation',
  async (condition) => {
    const { tools } = fixture();
    if (condition === 'none')
      runtime.catalog.mockReturnValue({ available: true, repositories: [] });
    if (condition === 'ambiguous')
      runtime.catalog.mockReturnValue({
        available: true,
        repositories: [
          { connectionId: 'one', repository: 'example/repo' },
          { connectionId: 'two', repository: 'https://github.com/Example/Repo.git' },
        ],
      });
    const result = await tools.execute(
      'PrepareRepositoryChat',
      {
        repository:
          condition === 'invalid-host' ? 'https://evil.test/example/repo' : 'example/repo',
        prompt: draft.prompt,
      },
      signal(),
    );
    expect(result?.isError).toBe(true);
    expect(runtime.prepareChat).not.toHaveBeenCalled();
  },
);

it.each(['owner', 'cancel', 'skill', 'closing', 'user-close', 'suspended'])(
  'fences every known tool when the source session is %s',
  async (condition) => {
    const { registry, session, tools } = fixture('mcp__repository__');
    if (condition === 'owner')
      registry.register('client', {
        sessionId: 'session',
        abortController: new AbortController(),
      } as never);
    if (condition === 'cancel') session.abortController.abort();
    if (condition === 'skill') session.activeSkillPolicy = new Set(['ListRepositories']);
    if (condition === 'closing') vi.spyOn(registry, 'isClosingOut').mockReturnValue(true);
    if (condition === 'user-close') registry.markUserClose('client');
    if (condition === 'suspended') vi.spyOn(registry, 'isSuspended').mockReturnValue(true);
    for (const [name, input] of [
      ['ListRepositories', {}],
      ['PrepareRepositoryChat', { repository: 'example/repo', prompt: draft.prompt }],
      ['GetRepositoryChatPreparation', { preparationId: id }],
      ['GetRepositoryChatPreparation', {}],
    ] as const)
      expect((await tools.execute(name, input, signal()))?.isError).toBe(true);
    expect(runtime.catalog).not.toHaveBeenCalled();
    expect(runtime.service).not.toHaveBeenCalled();
  },
);

it.each(['model', 'binding', 'profile', 'scope', 'skill', 'owner', 'ask', 'disabled', 'cancel'])(
  'suppresses a prepared handoff when %s changes across acquisition',
  async (condition) => {
    const { registry, session, tools } = fixture();
    runtime.prepareChat.mockImplementation(async (...args) => {
      const combined = args.at(-1) as AbortSignal;
      if (condition === 'model') session.model = 'changed-model';
      if (condition === 'binding') session.accountBinding = { ...binding, accountId: 'other' };
      if (condition === 'profile')
        runtime.binding.mockReturnValue({ ...binding, profileRevision: 'changed' });
      if (condition === 'scope')
        runtime.catalog.mockReturnValue({ available: true, repositories: [] });
      if (condition === 'skill') session.activeSkillPolicy = new Set(['ListRepositories']);
      if (condition === 'owner')
        registry.register('client', {
          sessionId: 'session',
          abortController: new AbortController(),
        } as never);
      if (condition === 'ask') session.mode = 'ask';
      if (condition === 'disabled') runtime.enabled.mockReturnValue(false);
      if (condition === 'cancel') {
        session.abortController.abort();
        expect(combined.aborted).toBe(true);
      }
      return draft;
    });
    const result = await tools.execute(
      'PrepareRepositoryChat',
      { repository: 'example/repo', prompt: draft.prompt },
      signal(),
    );
    expect(result?.isError).toBe(true);
    expect(result?.content).not.toContain(draft.setupUrl);
  },
);

it('propagates tool cancellation to preparation and suppresses returned links', async () => {
  const { tools } = fixture();
  const controller = new AbortController();
  runtime.prepareChat.mockImplementation(async (...args) => {
    controller.abort();
    expect((args.at(-1) as AbortSignal).aborted).toBe(true);
    return draft;
  });
  expect(
    (
      await tools.execute(
        'PrepareRepositoryChat',
        { repository: 'example/repo', prompt: draft.prompt },
        controller.signal,
      )
    )?.isError,
  ).toBe(true);
});

it('projects a public handoff and does not return store paths or private profile metadata', async () => {
  const { tools } = fixture();
  runtime.chatPreparation.mockReturnValue({
    ...draft,
    directory: '/private/source',
    binding,
    secret: 'fixture-secret',
  });
  const result = await tools.execute(
    'GetRepositoryChatPreparation',
    { preparationId: id },
    signal(),
  );
  expect(JSON.parse(result!.content)).toEqual({ repositoryChat: draft });
});
it('keeps unknown tool dispatch available to other handlers', async () => {
  const { tools } = fixture();
  expect(await tools.execute('OtherTool', {}, signal())).toBeUndefined();
  expect(runtime.binding).not.toHaveBeenCalled();
});

import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AccountProfiles } from '../account-profiles.js';
import { AgentContextRecipeSchema, type AgentContextRecipe } from '@mitzo/protocol';
import { ContextPackStore } from '../context-pack-store.js';
import { sdkFixtureBoundary } from './fixtures/sdk-query-peer.js';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: vi.fn(),
}));
vi.mock('../session-index.js', async (original) => ({
  ...(await original<object>()),
  registerSession: vi.fn(),
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../hook-bridge.js', async (original) => ({
  ...(await original<object>()),
  loadProjectHooks: vi.fn(),
}));
vi.mock('../prompt-compare.js', () => ({
  capturePromptComparison: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../auto-rename.js', async (original) => ({
  ...(await original<object>()),
  shouldAutoRename: () => false,
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup(contextRecipe?: AgentContextRecipe, withFixtureMcp = false) {
  vi.clearAllMocks();
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-context-startup-'));
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'AGENTS.md'), '# Rules\nPreserve the task workspace.');
  await writeFile(
    join(root, 'docs/architecture.md'),
    '# Architecture\n## Choices\nUse immutable context bundles.',
  );
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({ boot: { content: 'Unexpected default context', sources: [], tokens: 8 } }),
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const definition = {
    name: 'Bob',
    descriptor: 'The architect',
    role: 'agent',
    instructions: 'Challenge assumptions.',
    expectedOutput: 'Decision brief',
    acceptanceCriteria: ['Use evidence'],
    modelPolicyRole: 'agent',
    contextRecipe: contextRecipe
      ? AgentContextRecipeSchema.parse(contextRecipe)
      : {
          version: 1 as const,
          source: 'workspace' as const,
          files: ['docs/architecture.md'],
          tokenBudget: 1000,
          required: [['docs/architecture.md', 'Architecture', 'Choices']],
          excluded: [],
        },
  };
  const profile = {
    profileId: 'bob',
    revision: 3,
    definition,
    contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
  };
  const transport = { send: vi.fn(), isOpen: () => true };
  const library = await import('../agent-library-transport.js');
  const unbind = library.bindAgentLibraryTransport('operator', {
    id: 'fixture-login',
    expiresAt: Date.now() + 60000,
  });
  vi.spyOn(library, 'readAgentLibraryProfile').mockResolvedValue(profile);
  if (withFixtureMcp) {
    const mcp = await import('../mcp-config.js');
    vi.spyOn(mcp, 'loadMcpServers').mockReturnValue({
      fixture: { command: '/bin/echo', args: ['offline MCP'] },
    });
  }
  const compiler = await import('../agent-context-compiler.js');
  const chat = await import('../chat.js');
  return { root, profile, transport, compiler, chat, fetcher, unbind };
}
const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-565656565656';

it.each(['retired Responses', 'retired Responses with native API disabled', 'Gemini', 'Claude'])(
  'preserves the context compilation boundary on the %s route',
  async (route) => {
    const { root, chat, transport, compiler, unbind } = await setup({
      version: 2,
      source: 'packs',
      tokenBudget: 1000,
      packs: [{ id: 'review', revision: 1, hash: 'a'.repeat(64) }],
    });
    const contextPacks = new ContextPackStore(':memory:');
    const { installContextPackRuntime } = await import('../context-pack-runtime.js');
    const release = installContextPackRuntime(async () => ({
      contextPacks,
      sourceIdentity: 'fixture-accepted',
      source: { allowed: () => true, authorize: vi.fn(), read: vi.fn() },
    }));
    try {
      vi.stubEnv(
        'MITZO_OPENSHELL_ENABLED',
        route === 'retired Responses with native API disabled' ? '1' : '0',
      );
      vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', '');
      vi.stubEnv('MITZO_OPENSHELL_OPENAI_API_ENABLED', '0');
      const profiles = new AccountProfiles([
        route === 'Gemini'
          ? {
              id: 'fixture',
              label: 'Offline Gemini',
              provider: 'google-vertex',
              projectId: 'fixture-project',
              region: 'europe-west1',
              credentialRef: '/test/adc.json',
              models: [{ id: 'luna', label: 'Fixture' }],
            }
          : route === 'Claude'
            ? {
                id: 'fixture',
                label: 'Offline Claude',
                provider: 'anthropic-vertex',
                projectId: 'fixture-project',
                region: 'europe-west1',
                credentialRef: '/test/adc.json',
                models: [{ id: 'luna', label: 'Fixture' }],
              }
            : {
                id: 'fixture',
                label: 'Offline Responses',
                provider: 'openai',
                credentialRef: { provider: 'keychain', service: 'fixture', account: 'fixture' },
                models: [{ id: 'luna', label: 'Fixture' }],
              },
      ]);
      const { credentials } = await import('../credentials.js');
      const credential = vi.spyOn(credentials, 'resolve').mockResolvedValue('offline-key');
      const { GoogleAuth } = await import('google-auth-library');
      vi.spyOn(GoogleAuth.prototype, 'getAccessToken').mockResolvedValue('offline-token');
      const compile = vi
        .spyOn(compiler, 'compileAgentContext')
        .mockRejectedValue(Error('Supported pack compilation reached'));
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const codex = await import('../codex-chat-session.js');
      const open = vi
        .spyOn(codex, 'openCodexChat')
        .mockRejectedValue(Error('Unexpected native dispatch'));
      const starting = chat.startChat(transport, 'supported-pack-route', 'Review', {
        cwd: root,
        isolation: false,
        accountId: 'fixture',
        model: 'luna',
        accountProfiles: profiles,
        initialSessionId: sessionId,
        agentProfile: { profileId: 'bob', revision: 3 },
        operatorConnectionId: 'operator',
      });
      if (route.startsWith('retired')) {
        await expect(starting).rejects.toThrow(/Responses execution is retired/);
        expect(compile).not.toHaveBeenCalled();
        expect(credential).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(chat.eventStore.getSession(sessionId)).toBeNull();
        return;
      }
      await starting;
      expect(compile).toHaveBeenCalledOnce();
      expect(transport.send.mock.calls).toContainEqual([
        expect.objectContaining({ type: 'error', error: 'Supported pack compilation reached' }),
      ]);
      expect(query).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    } finally {
      release();
      unbind();
      chat.registry.dispose();
      chat.eventStore.close();
      contextPacks.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  ['host Codex', false, false, false, false],
  ['sandbox Codex', true, false, false, false],
  ['sandbox API', true, true, false, false],
  ['retained host Codex', false, false, true, false],
  ['retained sandbox Codex', true, false, true, false],
  ['retained sandbox API', true, true, true, false],
  ['retained after profile await', false, false, true, true],
  ['retained initial identity', false, false, true, false],
] as const)(
  'refuses packs before common startup side effects (%s)',
  async (_name, sandbox, api, retained, afterAwait) => {
    const packRecipe = {
      version: 2 as const,
      source: 'packs' as const,
      tokenBudget: 1000,
      packs: [{ id: 'review', revision: 1, hash: 'a'.repeat(64) }],
    };
    const { root, chat, profile, transport, compiler, unbind } = await setup(
      afterAwait ? undefined : packRecipe,
    );
    try {
      vi.stubEnv('MITZO_OPENSHELL_ENABLED', sandbox ? '1' : '0');
      vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', '');
      const profiles = new AccountProfiles(
        [
          api
            ? {
                id: 'fixture',
                label: 'Offline API',
                provider: 'openai',
                credentialRef: { provider: 'keychain', service: 'fixture', account: 'fixture' },
                sandboxProvider: 'fixture-openai',
                models: [{ id: 'luna', label: 'Luna fixture' }],
              }
            : {
                id: 'fixture',
                label: 'Offline Codex',
                provider: 'openai-codex',
                email: 'fixture@example.com',
                planType: 'pro',
                ...(sandbox
                  ? {
                      sandboxProvider: 'fixture-openai',
                      sandboxProviderType: 'openai-codex-oauth',
                      sandboxProviderId: 'provider-id',
                      sandboxGrantId: 'grant-id',
                    }
                  : { credentialRef: '/test/codex' }),
                models: [{ id: 'luna', label: 'Luna fixture' }],
              },
        ],
        { codexEnabled: true },
      );
      let retainedVisible = !afterAwait;
      if (afterAwait) {
        const libraryBinding = await import('../agent-library-binding.js');
        const original = libraryBinding.resolveChatAgentProfile;
        vi.spyOn(libraryBinding, 'resolveChatAgentProfile').mockImplementation(async (input) => {
          const selected = await original(input);
          retainedVisible = true;
          return selected;
        });
      }
      if (retained) {
        chat.eventStore.upsertSession({
          sessionId,
          accountBinding: profiles.resolve('fixture', 'luna'),
          ...(afterAwait ? { agentProfile: profile } : {}),
        });
        const get = chat.eventStore.getSession.bind(chat.eventStore);
        vi.spyOn(chat.eventStore, 'getSession').mockImplementation((id) => {
          const meta = get(id);
          return retainedVisible && id === sessionId && meta
            ? { ...meta, agentContext: { source: 'packs' } as never }
            : meta;
        });
      }
      const { CodexAppServerClient } = await import('../codex-app-server-client.js');
      const launch = vi
        .spyOn(CodexAppServerClient, 'launch')
        .mockReturnValue({ initialize: async () => {}, close: vi.fn() } as never);
      const account = await import('../codex-account.js');
      const verify = vi
        .spyOn(account, 'verifyCodexAccount')
        .mockResolvedValue(profiles.resolve('fixture', 'luna') as never);
      const { credentials } = await import('../credentials.js');
      const credential = vi
        .spyOn(credentials, 'resolve')
        .mockRejectedValue(Error('Unexpected credentials'));
      const worktrees = await import('../worktree.js');
      const worktree = vi.spyOn(worktrees, 'createWorktree').mockImplementation(() => {
        throw Error('Unexpected workspace');
      });
      const worktreeAsync = vi
        .spyOn(worktrees, 'createWorktreeAsync')
        .mockRejectedValue(Error('Unexpected workspace'));
      const repository = await import('../repository-chat-startup.js');
      const repositoryRuntime = await import('../repository-workspace-runtime.js');
      vi.spyOn(repositoryRuntime, 'getRepositoryWorkspaces').mockReturnValue({} as never);
      const workspace = vi
        .spyOn(repository, 'selectRepositoryChatWorkspace')
        .mockRejectedValue(Error('Unexpected repository workspace'));
      const compile = vi
        .spyOn(compiler, 'compileAgentContext')
        .mockRejectedValue(Error('Unexpected compilation'));
      const persist = vi.spyOn(chat.eventStore, 'upsertSession');
      const register = vi.spyOn(chat.registry, 'register');
      const codex = await import('../codex-chat-session.js');
      const open = vi
        .spyOn(codex, 'openCodexChat')
        .mockRejectedValue(Error('Unexpected native dispatch'));
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      await chat.startChat(transport, 'early-pack-refusal', 'Review', {
        cwd: root,
        accountId: 'fixture',
        model: 'luna',
        accountProfiles: profiles,
        ...(retained
          ? _name === 'retained initial identity'
            ? { initialSessionId: sessionId }
            : { resume: sessionId }
          : {
              agentProfile: { profileId: 'bob', revision: 3 },
              repositoryWorkspaceId: 'fixture-repository',
            }),
        operatorConnectionId: 'operator',
      });
      expect(transport.send.mock.calls).toContainEqual([
        expect.objectContaining({
          type: 'error',
          error: expect.stringContaining('trusted native continuation barrier'),
        }),
      ]);
      for (const sideEffect of [
        launch,
        verify,
        credential,
        worktree,
        worktreeAsync,
        workspace,
        compile,
        persist,
        register,
        open,
        query,
      ])
        expect(sideEffect).not.toHaveBeenCalled();
    } finally {
      unbind();
      chat.registry.dispose();
      chat.eventStore.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  [true, true],
  [false, true],
  [false, false],
])(
  'records first SDK delivery with supplied session identity=%s and command identity=%s',
  async (suppliedIdentity, suppliedCommand) => {
    const { root, chat, transport, unbind } = await setup();
    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      vi.mocked(query).mockImplementation(
        () =>
          ({
            close: vi.fn(),
            interrupt: vi.fn(),
            async *[Symbol.asyncIterator]() {
              const providerSessionId = vi.mocked(query).mock.calls[0][0].options!.sessionId!;
              yield {
                type: 'system',
                subtype: 'init',
                session_id: providerSessionId,
                uuid: 'fixture-init',
              };
              expect(
                JSON.parse(chat.eventStore.getSession(providerSessionId)!.bootContext!).receipt
                  .status,
              ).toBe('prepared');
              yield {
                type: 'stream_event',
                session_id: providerSessionId,
                uuid: 'fixture-stream',
                event: {
                  type: 'message_start',
                  message: {
                    id: 'provider-message',
                    role: 'assistant',
                    model: 'luna',
                    content: [],
                    usage: { input_tokens: 1, output_tokens: 0 },
                  },
                },
              };
              expect(
                JSON.parse(chat.eventStore.getSession(providerSessionId)!.bootContext!).receipt,
              ).toMatchObject({ status: 'accepted' });
              expect(
                chat.eventStore
                  .getSessionEvents(providerSessionId)
                  .filter((event) => event.type === 'agent_context_accepted'),
              ).toMatchObject([
                {
                  payload: {
                    providerTurnId: 'provider-message',
                    commandId: suppliedCommand ? 'context-command' : expect.any(String),
                    providerThreadId: providerSessionId,
                  },
                },
              ]);
              yield {
                type: 'assistant',
                session_id: providerSessionId,
                uuid: 'fixture-assistant',
                message: {
                  id: 'provider-message',
                  role: 'assistant',
                  model: 'luna',
                  content: [{ type: 'text', text: 'done' }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              };
              yield {
                type: 'stream_event',
                session_id: providerSessionId,
                uuid: 'fixture-later-stream',
                event: {
                  type: 'message_start',
                  message: {
                    id: 'later-provider-message',
                    role: 'assistant',
                    model: 'luna',
                    content: [],
                    usage: { input_tokens: 1, output_tokens: 0 },
                  },
                },
              };
              yield {
                type: 'result',
                subtype: 'success',
                session_id: providerSessionId,
                uuid: 'fixture-result',
                result: 'done',
                is_error: false,
                usage: { input_tokens: 1, output_tokens: 0 },
                num_turns: 1,
                total_cost_usd: 0,
                duration_ms: 1,
                duration_api_ms: 1,
              };
            },
          }) as never,
      );
      await chat.startChat(transport, 'sdk-receipt', 'Review', {
        cwd: root,
        isolation: false,
        model: 'luna',
        operatorConnectionId: 'operator',
        ...(suppliedIdentity ? { initialSessionId: sessionId } : {}),
        ...(suppliedCommand ? { clientMsgId: 'context-command' } : {}),
        agentProfile: { profileId: 'bob', revision: 3 },
      });
      const session = chat.eventStore.getSession(
        vi.mocked(query).mock.calls[0][0].options!.sessionId!,
      )!;
      expect(JSON.parse(session.bootContext!).receipt).toMatchObject({
        status: 'accepted',
        payloadHash: session.agentContext?.payloadHash,
        profileId: 'bob',
        profileRevision: 3,
      });
      expect(session.agentContext?.context.fullMarkdown).toContain(
        'Use immutable context bundles.',
      );
      const events = chat.eventStore.getSessionEvents(session.sessionId);
      const acceptances = events.filter((event) => event.type === 'agent_context_accepted');
      expect(acceptances).toHaveLength(1);
      const userMessage = events.find((event) => event.type === 'user_message');
      expect(userMessage?.payload.messageId).toBe(acceptances[0].payload.commandId);
    } finally {
      unbind();
      chat.registry.dispose();
      chat.eventStore.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([false, true])(
  'compiles a profile pack from accepted Knowledge with runtime-only fence=%s',
  async (runtimeOnly) => {
    const contextPacks = new ContextPackStore(':memory:');
    const draft = contextPacks.create({
      version: 1,
      id: 'review',
      name: 'Review',
      description: '',
      tokenBudget: 1000,
      documents: [
        {
          path: 'review.md',
          revision: 'a'.repeat(40),
          mode: 'required',
          headings: [],
          priority: 100,
        },
      ],
      retrievalGuidance: 'Use Jira for current status.',
    });
    const pack = contextPacks.publish(draft.id, draft.version);
    const fixture = await setup({
      version: 2,
      source: 'packs',
      tokenBudget: 1000,
      packs: [{ id: pack.id, revision: pack.revision, hash: pack.hash }],
    });
    const { root, chat, transport, unbind } = fixture;
    const { installContextPackRuntime } = await import('../context-pack-runtime.js');
    const sourceRead = vi.fn(async (path: string, revision: string) => ({
      path,
      revision,
      content: '# Review\nAccepted review guidance.',
    }));
    const release = installContextPackRuntime(async () => ({
      contextPacks,
      sourceIdentity: 'github:owner/knowledge@main',
      source: {
        authorize: async (path: string, revision: string) => ({
          path,
          revision,
          blob: 'b'.repeat(40),
        }),
        allowed: () => true,
        read: sourceRead,
      },
    }));
    const projectStartup = vi.fn(async () => ({}));
    const protectedRunner = vi
      .fn()
      .mockResolvedValue({ stdout: 'Unexpected fallback', stderr: '' });
    const child = sdkFixtureBoundary().spawnClaudeCodeProcess();
    const outerSpawn = vi.fn(() => child);
    if (runtimeOnly) {
      const boundary = await import('../credential-sdk-boundary.js');
      vi.spyOn(boundary, 'credentialSdkBoundary').mockReturnValue({
        credentialIsolation: false,
        deniedRoots: [],
        spawnClaudeCodeProcess: outerSpawn,
      });
      const protectedCommands = await import('../protected-sdk-command.js');
      vi.spyOn(protectedCommands, 'createWorkspaceRuntimeCommandRunner').mockReturnValue(
        protectedRunner,
      );
    }
    const hooks = await import('../hook-bridge.js');
    vi.mocked(hooks.loadProjectHooks).mockReturnValue({
      SessionStart: [{ hooks: [projectStartup] }],
      Stop: [],
    });
    try {
      await writeFile(
        join(root, 'review.md'),
        'Unaccepted task instruction must not enter context.',
      );
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      vi.mocked(query).mockImplementation((args) => {
        if (runtimeOnly) {
          const launch = {
            command: 'offline-fixture',
            args: [],
            env: {},
            signal: new AbortController().signal,
          };
          expect(args.options!.spawnClaudeCodeProcess!(launch)).toBe(child);
          expect(outerSpawn).toHaveBeenCalledWith(launch);
        }
        throw Error('Mocked provider dispatch');
      });
      await chat.startChat(transport, 'pack-context', 'Review', {
        cwd: root,
        isolation: false,
        model: 'luna',
        operatorConnectionId: 'operator',
        initialSessionId: sessionId,
        agentProfile: { profileId: 'bob', revision: 3 },
      });
      expect(
        transport.send.mock.calls
          .filter(([message]) => message.type === 'error')
          .map(([message]) => message.error),
      ).toEqual(['Mocked provider dispatch']);
      expect(query).toHaveBeenCalledOnce();
      const append = (vi.mocked(query).mock.calls[0][0].options?.systemPrompt as { append: string })
        .append;
      expect(append).toContain('Accepted review guidance.');
      expect(append).toContain('Use Jira for current status.');
      expect(append).not.toContain('Unaccepted task instruction');
      expect(append).not.toContain('At cold start, use TelosFindArtifacts');
      expect(append).not.toContain('Read CLAUDE.md and .cursor/rules/');
      expect(vi.mocked(query).mock.calls[0][0].options?.settingSources).toEqual([]);
      expect(
        vi.mocked(query).mock.calls[0][0].options?.hooks?.PostToolBatch?.length,
      ).toBeGreaterThan(0);
      if (runtimeOnly) {
        expect(vi.mocked(query).mock.calls[0][0].options?.spawnClaudeCodeProcess).toBeTypeOf(
          'function',
        );
        expect(vi.mocked(query).mock.calls[0][0].options?.strictMcpConfig).toBeUndefined();
        expect(hooks.loadProjectHooks).toHaveBeenCalledWith(
          root,
          expect.any(Object),
          protectedRunner,
        );
        expect(protectedRunner).not.toHaveBeenCalled();
      }
      expect(
        vi
          .mocked(query)
          .mock.calls[0][0].options?.hooks?.SessionStart?.some((group) =>
            group.hooks.includes(projectStartup),
          ),
      ).not.toBe(true);
      const retained = chat.eventStore.getSession(sessionId)!;
      expect(retained.agentContext?.provenance?.documents[0]?.storeId).toBe(
        'github:owner/knowledge@main',
      );
      expect(JSON.parse(retained.bootContext!).receipt).toMatchObject({
        status: 'prepared',
        profileId: 'bob',
        profileRevision: 3,
        payloadHash: retained.agentContext?.payloadHash,
      });
      expect(sourceRead).toHaveBeenCalledWith('review.md', 'a'.repeat(40), expect.any(AbortSignal));
    } finally {
      release();
      unbind();
      chat.registry.dispose();
      chat.eventStore.close();
      contextPacks.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([false, true])(
  'pins compiled context before mocked SDK dispatch and reuses it on cold resume (resume=%s)',
  async (resume) => {
    const fixture = await setup();
    const { root, profile, compiler, chat, transport, fetcher, unbind } = fixture;
    try {
      if (resume) {
        const compiled = await compiler.compileAgentContext(profile.definition.contextRecipe, {
          workspaceRoot: root,
        });
        chat.eventStore.upsertSession({
          sessionId,
          cwd: root,
          agentProfile: profile,
          agentContext: {
            ...compiled,
            profileId: profile.profileId,
            revision: profile.revision,
            profileHash: profile.contentHash,
          },
        });
        await writeFile(
          join(root, 'docs/architecture.md'),
          'Changed live source must not replace the pinned bundle.',
        );
      }
      const compile = vi.spyOn(compiler, 'compileAgentContext');
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const capture: { session?: ReturnType<typeof chat.eventStore.getSession> } = {};
      vi.mocked(query).mockImplementation((args) => {
        capture.session = chat.eventStore.getSession(
          args.options!.resume ?? args.options!.sessionId!,
        );
        throw Error('Mocked SDK dispatch intercepted; no model call');
      });
      await chat.startChat(transport, 'compiled-profile', 'Review this', {
        cwd: root,
        isolation: false,
        model: 'luna',
        operatorConnectionId: 'operator',
        ...(resume
          ? { resume: sessionId }
          : { initialSessionId: sessionId, agentProfile: { profileId: 'bob', revision: 3 } }),
      });
      expect(query).toHaveBeenCalledOnce();
      const append = (vi.mocked(query).mock.calls[0][0].options?.systemPrompt as { append: string })
        .append;
      expect(append).toContain('Bob · The architect');
      expect(append).toContain('Use immutable context bundles.');
      expect(append).toContain('Preserve the task workspace.');
      expect(append).not.toContain('Unexpected default context');
      expect(append).not.toContain('Changed live source');
      expect(capture.session?.agentContext?.profileHash).toBe(profile.contentHash);
      expect(capture.session?.agentContext?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(capture.session?.bootContext ?? 'null')).toMatchObject(
        capture.session!.agentContext!.context,
      );
      expect(compile).toHaveBeenCalledTimes(resume ? 0 : 1);
      expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/context'))).toHaveLength(
        0,
      );
    } finally {
      unbind();
      chat.registry.dispose();
      chat.eventStore.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
it('fails before provider dispatch when a required context document is missing, and cleans the registered startup', async () => {
  const { root, chat, transport, unbind } = await setup();
  try {
    await rm(join(root, 'docs/architecture.md'));
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    vi.mocked(query).mockImplementation(() => {
      throw Error('Unexpected provider dispatch');
    });
    await chat
      .startChat(transport, 'missing-context', 'Review this', {
        cwd: root,
        isolation: false,
        model: 'luna',
        initialSessionId: sessionId,
        operatorConnectionId: 'operator',
        agentProfile: { profileId: 'bob', revision: 3 },
      })
      .catch(() => {});
    expect(query).not.toHaveBeenCalled();
    expect(transport.send.mock.calls).toContainEqual([
      expect.objectContaining({ type: 'error', error: expect.stringContaining('architecture.md') }),
    ]);
    expect(chat.registry.get('missing-context')).toBeUndefined();
    expect(chat.eventStore.getSession(sessionId)?.agentContext).toBeUndefined();
  } finally {
    unbind();
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('routes recipe profiles to authenticated sandbox admission without compiling host files', async () => {
  const { root, chat, transport, compiler, unbind } = await setup();
  try {
    vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
    const profiles = new AccountProfiles(
      [
        {
          id: 'fixture',
          label: 'Offline account',
          provider: 'openai-codex',
          email: 'fixture@example.com',
          planType: 'pro',
          sandboxProvider: 'fixture-openai',
          sandboxProviderType: 'openai-codex-oauth',
          sandboxProviderId: 'provider-id',
          sandboxGrantId: 'grant-id',
          models: [{ id: 'luna', label: 'Luna fixture' }],
        },
      ],
      { codexEnabled: true },
    );
    const account = await import('../codex-account.js');
    const verify = vi
      .spyOn(account, 'verifyCodexAccount')
      .mockRejectedValue(Error('Unexpected account preflight'));
    const codex = await import('../codex-chat-session.js');
    const open = vi.spyOn(codex, 'openCodexChat').mockImplementation(async (options) => {
      expect(options.assertAgentContextAuthorization).toBeTypeOf('function');
      expect(() => options.assertAgentContextAuthorization!()).not.toThrow();
      throw Error('Offline sandbox admission intercepted; no model call');
    });
    const compile = vi.spyOn(compiler, 'compileAgentContext');
    await chat.startChat(transport, 'sandbox-context', 'Review this', {
      cwd: root,
      accountId: 'fixture',
      model: 'luna',
      accountProfiles: profiles,
      agentProfile: { profileId: 'bob', revision: 3 },
      operatorConnectionId: 'operator',
    });
    expect(verify).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    expect(compile).not.toHaveBeenCalled();
    expect(open.mock.calls[0][0]).toMatchObject({
      agentProfile: expect.objectContaining({ profileId: 'bob', revision: 3 }),
      assertAgentContextAuthorization: expect.any(Function),
    });
    expect(() => open.mock.calls[0][0].assertAgentContextAuthorization!()).toThrow(/released/i);
    unbind();
    expect(() => open.mock.calls[0][0].assertAgentContextAuthorization!()).toThrow(/revoked/i);
  } finally {
    unbind();
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rechecks operator authorization after compilation before saving context or dispatching a model', async () => {
  const { root, chat, transport, compiler, unbind } = await setup();
  try {
    const original = compiler.compileAgentContext;
    vi.spyOn(compiler, 'compileAgentContext').mockImplementation(async (recipe, options) => {
      const result = await original(recipe, options);
      unbind();
      return result;
    });
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    vi.mocked(query).mockImplementation(() => {
      throw Error('Unexpected provider dispatch');
    });
    await chat.startChat(transport, 'revoked-context', 'Review this', {
      cwd: root,
      isolation: false,
      model: 'luna',
      initialSessionId: sessionId,
      agentProfile: { profileId: 'bob', revision: 3 },
      operatorConnectionId: 'operator',
    });
    expect(query).not.toHaveBeenCalled();
    expect(transport.send.mock.calls).toContainEqual([
      expect.objectContaining({ type: 'error', error: expect.stringContaining('revoked') }),
    ]);
    expect(chat.eventStore.getSession(sessionId)?.agentContext).toBeUndefined();
  } finally {
    unbind();
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { event: 'PostToolUse' },
  { event: 'PostToolUseFailure' },
  { event: 'PermissionDenied' },
  { event: 'PermissionRequest', permissionWait: true },
  { event: 'PostToolBatch' },
  { event: 'PostToolBatch', nested: true },
  { event: 'PostToolBatch', projectRefresh: true },
  { event: 'PostToolBatch', projectRefresh: true, runtimeOnly: true },
  { event: 'PostToolBatch', keepAccepted: true },
  { event: 'PreCompact' },
  { event: 'SubagentStart', nested: true },
] as const)(
  'aborts SDK continuation when retained Knowledge is revoked at $event (nested=$nested, projectRefresh=$projectRefresh)',
  async (boundary) => {
    const packs = new ContextPackStore(':memory:');
    const draft = packs.create({
      version: 1,
      id: 'continuation',
      name: 'Continuation',
      description: '',
      tokenBudget: 1000,
      documents: [
        {
          path: 'accepted.md',
          revision: 'a'.repeat(40),
          mode: 'required',
          headings: [],
          priority: 100,
        },
      ],
      retrievalGuidance: '',
    });
    const pack = packs.publish(draft.id, draft.version);
    const { root, chat, transport, unbind } = await setup(
      {
        version: 2,
        source: 'packs',
        tokenBudget: 1000,
        packs: [{ id: pack.id, revision: pack.revision, hash: pack.hash }],
      },
      'runtimeOnly' in boundary,
    );
    const { installContextPackRuntime } = await import('../context-pack-runtime.js');
    let current = true;
    const authorize = vi.fn(async (path: string, revision: string) => {
      if (!current)
        throw Error('Pinned accepted Knowledge revision was revoked during tool execution');
      return { path, revision, blob: 'b'.repeat(40) };
    });
    const release = installContextPackRuntime(async () => ({
      contextPacks: packs,
      sourceIdentity: 'accepted-store',
      source: {
        authorize,
        allowed: () => true,
        read: async (path: string, revision: string) => ({
          path,
          revision,
          content: '# Accepted\nPinned instructions.',
        }),
      },
    }));
    const project = vi.fn(async () => {
      await Promise.resolve();
      if ('projectRefresh' in boundary) current = false;
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolBatch' as const,
          additionalContext: 'Retained project hook output',
        },
      };
    });
    const unmatchedProject = vi.fn(async () => ({}));
    const hooks = await import('../hook-bridge.js');
    vi.mocked(hooks.loadProjectHooks).mockReturnValue({
      PostToolBatch: [
        { matcher: 'Read', hooks: [project] },
        { matcher: 'Bash', hooks: [unmatchedProject] },
      ],
    });
    if ('permissionWait' in boundary) {
      const permissions = await import('../permission-handler.js');
      vi.spyOn(permissions, 'buildPermissionHandler').mockReturnValue(async (_name, input) => {
        await Promise.resolve();
        current = false;
        return { behavior: 'allow', updatedInput: input };
      });
    }
    const sdkBoundary = await import('../credential-sdk-boundary.js');
    const protectedRunner = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const child = sdkFixtureBoundary().spawnClaudeCodeProcess();
    const outerSpawn = vi.fn(() => child);
    if ('runtimeOnly' in boundary) {
      vi.stubEnv('WORKSPACE_RUNTIME_FIXTURE_ENV', 'preserved');
      vi.spyOn(sdkBoundary, 'credentialSdkBoundary').mockReturnValue({
        credentialIsolation: false,
        deniedRoots: [],
        spawnClaudeCodeProcess: outerSpawn,
      });
      const protectedCommands = await import('../protected-sdk-command.js');
      vi.spyOn(protectedCommands, 'createWorkspaceRuntimeCommandRunner').mockReturnValue(
        protectedRunner,
      );
    } else vi.spyOn(sdkBoundary, 'credentialSdkBoundary').mockReturnValue(undefined);
    let providerRequests = 0;
    let aborted = false;
    let continuationStopped = false;
    let projectOutputPreserved = false;
    let abortedAfterPermission = false;
    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      vi.mocked(query).mockImplementation(
        (args) =>
          ({
            close: vi.fn(),
            interrupt: vi.fn(),
            async *[Symbol.asyncIterator]() {
              if ('runtimeOnly' in boundary) {
                const launch = {
                  command: 'offline-fixture',
                  args: [],
                  env: {},
                  signal: new AbortController().signal,
                };
                expect(args.options!.spawnClaudeCodeProcess!(launch)).toBe(child);
                expect(outerSpawn).toHaveBeenCalledWith(launch);
                expect(args.options?.settingSources).toEqual([]);
                expect(args.options?.strictMcpConfig).toBeUndefined();
                expect(args.options?.mcpServers).toHaveProperty('fixture');
                expect(args.options?.allowedTools).toContain('mcp__fixture__*');
                expect(args.options?.env?.WORKSPACE_RUNTIME_FIXTURE_ENV).toBe('preserved');
              }
              const prompt = args.prompt as AsyncIterable<unknown>;
              await prompt[Symbol.asyncIterator]().next();
              providerRequests++;
              yield { type: 'system', subtype: 'init', session_id: sessionId, uuid: 'init' };
              yield {
                type: 'stream_event',
                session_id: sessionId,
                uuid: 'start',
                event: {
                  type: 'message_start',
                  message: {
                    id: 'initial-provider-turn',
                    model: 'luna',
                    role: 'assistant',
                    content: [],
                    usage: { input_tokens: 1, output_tokens: 0 },
                  },
                },
              };
              const callHooks = async (
                event: import('@anthropic-ai/claude-agent-sdk').HookEvent,
              ) => {
                const input = {
                  hook_event_name: event,
                  session_id: sessionId,
                  cwd: root,
                  transcript_path: '/fixture',
                  ...('nested' in boundary ? { agent_id: 'nested-worker' } : {}),
                  ...(event === 'PostToolBatch'
                    ? {
                        tool_calls: [
                          {
                            tool_name: 'Read',
                            tool_input: {},
                            tool_use_id: 'tool-1',
                            tool_response: 'first result',
                          },
                          {
                            tool_name: 'Read',
                            tool_input: {},
                            tool_use_id: 'tool-2',
                            tool_response: 'second result',
                          },
                        ],
                      }
                    : event === 'PreCompact'
                      ? { trigger: 'auto', custom_instructions: null }
                      : event === 'SubagentStart'
                        ? { agent_id: 'nested-worker', agent_type: 'Explore' }
                        : {
                            tool_name: 'Read',
                            tool_input: { file_path: 'task.md' },
                            tool_use_id: 'tool-2',
                            ...(event === 'PostToolUseFailure'
                              ? { error: 'tool failed', is_interrupt: false }
                              : event === 'PermissionDenied'
                                ? { reason: 'permission denied' }
                                : { tool_response: 'result' }),
                          }),
                } as unknown as import('@anthropic-ai/claude-agent-sdk').HookInput;
                const matchers = args.options!.hooks?.[event] ?? [];
                return Promise.all(
                  matchers
                    .filter(
                      (matcher) =>
                        !matcher.matcher ||
                        matcher.matcher === '*' ||
                        new RegExp(matcher.matcher).test('Read'),
                    )
                    .flatMap((matcher) =>
                      matcher.hooks.map(async (hook) => {
                        // The SDK may treat a thrown hook as recoverable diagnostics.
                        try {
                          return await hook(input, 'tool-2', {
                            signal: new AbortController().signal,
                          });
                        } catch {
                          return {};
                        }
                      }),
                    ),
                );
              };
              if (boundary.event === 'PostToolBatch') await callHooks('PostToolUse');
              if (
                !('projectRefresh' in boundary) &&
                !('keepAccepted' in boundary) &&
                !('permissionWait' in boundary)
              )
                current = false;
              if ('permissionWait' in boundary) {
                try {
                  await args.options!.canUseTool!(
                    'Read',
                    { file_path: 'task.md' },
                    { signal: new AbortController().signal, toolUseID: 'permission-tool' },
                  );
                } catch {
                  /* SDK may continue after permission diagnostics. */
                }
                abortedAfterPermission = args.options!.abortController!.signal.aborted;
              }
              const outputs = await callHooks(boundary.event);
              projectOutputPreserved = outputs.some(
                (output) =>
                  'hookSpecificOutput' in output &&
                  output.hookSpecificOutput &&
                  'additionalContext' in output.hookSpecificOutput &&
                  output.hookSpecificOutput.additionalContext === 'Retained project hook output',
              );
              aborted = args.options!.abortController!.signal.aborted;
              continuationStopped = outputs.some(
                (output) => 'continue' in output && output.continue === false,
              );
              if (!aborted && !continuationStopped) providerRequests++;
            },
          }) as never,
      );
      await chat.startChat(transport, 'sdk-continuation', 'Review', {
        cwd: root,
        isolation: false,
        model: 'luna',
        initialSessionId: sessionId,
        operatorConnectionId: 'operator',
        agentProfile: { profileId: 'bob', revision: 3 },
      });
      const revoked = !('keepAccepted' in boundary);
      expect(providerRequests).toBe(revoked ? 1 : 2);
      expect(aborted).toBe(revoked);
      expect(continuationStopped).toBe(revoked);
      expect(JSON.parse(chat.eventStore.getSession(sessionId)!.bootContext!).receipt.status).toBe(
        'accepted',
      );
      if ('permissionWait' in boundary) expect(abortedAfterPermission).toBe(true);
      if ('projectRefresh' in boundary) expect(project).toHaveBeenCalledOnce();
      if ('keepAccepted' in boundary) {
        expect(project).toHaveBeenCalledOnce();
        expect(projectOutputPreserved).toBe(true);
      }
      expect(unmatchedProject).not.toHaveBeenCalled();
      if ('runtimeOnly' in boundary) {
        expect(hooks.loadProjectHooks).toHaveBeenCalledWith(
          root,
          expect.any(Object),
          protectedRunner,
        );
        expect(protectedRunner).not.toHaveBeenCalled();
      }
    } finally {
      release();
      unbind();
      chat.registry.dispose();
      chat.eventStore.close();
      packs.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('preserves legacy SDK hook matchers and outputs when no pack context is selected', async () => {
  const { root, chat, transport, unbind } = await setup();
  const boundary = await import('../credential-sdk-boundary.js');
  vi.spyOn(boundary, 'credentialSdkBoundary').mockReturnValue(undefined);
  const project = [
    {
      matcher: 'Read',
      timeout: 17,
      hooks: [vi.fn(async () => ({ systemMessage: 'legacy hook' }))],
    },
  ];
  const hooks = await import('../hook-bridge.js');
  vi.mocked(hooks.loadProjectHooks).mockReturnValue({ PostToolBatch: project });
  let legacyOutput: unknown;
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    vi.mocked(query).mockImplementation((args) => {
      expect(args.options?.hooks?.PostToolBatch?.[0]).toMatchObject({
        matcher: 'Read',
        timeout: 17,
      });
      expect(args.options?.hooks?.PreCompact).toBeUndefined();
      return {
        close: vi.fn(),
        interrupt: vi.fn(),
        async *[Symbol.asyncIterator]() {
          const input = {
            hook_event_name: 'PostToolBatch',
            session_id: sessionId,
            cwd: root,
            transcript_path: '/fixture',
            tool_calls: [],
          } as unknown as import('@anthropic-ai/claude-agent-sdk').HookInput;
          legacyOutput = await args.options!.hooks!.PostToolBatch![0].hooks[0](input, undefined, {
            signal: new AbortController().signal,
          });
          yield* [];
        },
      } as never;
    });
    await chat.startChat(transport, 'legacy-sdk', 'Review', {
      cwd: root,
      isolation: false,
      model: 'luna',
    });
    expect(query).toHaveBeenCalledOnce();
    expect(project[0].hooks[0]).toHaveBeenCalledOnce();
    expect(legacyOutput).toEqual({ systemMessage: 'legacy hook' });
  } finally {
    unbind();
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('retains historical context acceptance after a later failed sandbox refresh', async () => {
  const { root, chat, profile, transport, unbind } = await setup();
  try {
    vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
    const profiles = new AccountProfiles(
      [
        {
          id: 'fixture',
          label: 'Offline account',
          provider: 'openai-codex',
          email: 'fixture@example.com',
          planType: 'pro',
          sandboxProvider: 'fixture-openai',
          sandboxProviderType: 'openai-codex-oauth',
          sandboxProviderId: 'provider-id',
          sandboxGrantId: 'grant-id',
          models: [{ id: 'luna', label: 'Luna fixture' }],
        },
      ],
      { codexEnabled: true },
    );
    const { contextDigest } = await import('../agent-context-compiler.js');
    const codex = await import('../codex-chat-session.js');
    let admittedSessionId: string | undefined;
    vi.spyOn(codex, 'openCodexChat').mockImplementation(async (options) => {
      options.assertAgentContextAuthorization!();
      admittedSessionId = options.conversationId;
      const context = {
        type: 'boot_context' as const,
        source: 'contexgin' as const,
        sourceCount: 1,
        tokenCount: 10,
        tokenBudget: 1000,
        sources: [{ path: 'AGENTS.md', kind: 'governance' }],
        included: [],
        trimmed: [],
        fullMarkdown: 'Accepted immutable sandbox guidance.',
      };
      const snapshot = {
        source: 'workspace' as const,
        compilerRevision: 'sandbox-fixture',
        recipeHash: contextDigest(profile.definition.contextRecipe),
        payloadHash: contextDigest(context),
        workspaceIdentity: contextDigest('/sandbox/workspaces/mgmt'),
        profileId: profile.profileId,
        revision: profile.revision,
        profileHash: profile.contentHash,
        context,
        sandbox: {
          sandboxId: 'sandbox-id',
          sandboxName: 'sandbox-name',
          workspaceRoot: '/sandbox/workspaces/mgmt',
          runtimeContractImageDigest: 'sha256:' + 'a'.repeat(64),
          compilerSha256: 'b'.repeat(64),
          entrypointSha256: 'c'.repeat(64),
          recipeSha256: 'd'.repeat(64),
          runtimeInputsSha256: 'e'.repeat(64),
          effectiveRecipeHash: contextDigest(profile.definition.contextRecipe),
        },
      };
      chat.eventStore.upsertSession({ sessionId: options.conversationId, agentContext: snapshot });
      options.onBootContext!({ ...context, scope: 'sandbox' });
      options.onAgentContextAccepted!(
        'first-command',
        'provider-thread',
        'first-turn',
        'f'.repeat(64),
      );
      expect(
        JSON.parse(chat.eventStore.getSession(options.conversationId)!.bootContext!).receipt.status,
      ).toBe('accepted');
      options.onBootContext!({ ...context, scope: 'sandbox' });
      throw Error('Later source authorization denied before provider acceptance');
    });
    await chat.startChat(transport, 'refresh-receipt', 'Review this', {
      cwd: root,
      accountId: 'fixture',
      model: 'luna',
      accountProfiles: profiles,
      agentProfile: { profileId: 'bob', revision: 3 },
      operatorConnectionId: 'operator',
    });
    const session = chat.eventStore.getSession(admittedSessionId!)!;
    expect(JSON.parse(session.bootContext!).receipt.status).toBe('accepted');
    expect(
      chat.eventStore
        .getSessionEvents(admittedSessionId!)
        .filter((event) => event.type === 'agent_context_accepted'),
    ).toHaveLength(1);
  } finally {
    unbind();
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

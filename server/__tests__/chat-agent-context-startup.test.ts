import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AccountProfiles } from '../account-profiles.js';
import { AgentContextRecipeSchema, type AgentContextRecipe } from '@mitzo/protocol';
import { ContextPackStore } from '../context-pack-store.js';

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

async function setup(contextRecipe?: AgentContextRecipe) {
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
  const compiler = await import('../agent-context-compiler.js');
  const chat = await import('../chat.js');
  return { root, profile, transport, compiler, chat, fetcher, unbind };
}
const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-565656565656';

it('records SDK delivery only after the provider starts a message, preserving the compiled snapshot', async () => {
  const { root, chat, transport, unbind } = await setup();
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    vi.mocked(query).mockImplementation(
      () =>
        ({
          close: vi.fn(),
          interrupt: vi.fn(),
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: sessionId, uuid: 'fixture-init' };
            expect(
              JSON.parse(chat.eventStore.getSession(sessionId)!.bootContext!).receipt.status,
            ).toBe('prepared');
            yield {
              type: 'stream_event',
              session_id: sessionId,
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
            yield {
              type: 'result',
              subtype: 'success',
              session_id: sessionId,
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
      initialSessionId: sessionId,
      clientMsgId: 'context-command',
      agentProfile: { profileId: 'bob', revision: 3 },
    });
    const session = chat.eventStore.getSession(sessionId)!;
    expect(JSON.parse(session.bootContext!).receipt).toMatchObject({
      status: 'accepted',
      payloadHash: session.agentContext?.payloadHash,
      profileId: 'bob',
      profileRevision: 3,
    });
    expect(session.agentContext?.context.fullMarkdown).toContain('Use immutable context bundles.');
  } finally {
    unbind();
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('compiles a profile pack from accepted Knowledge instead of the writable task checkout', async () => {
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
  const hooks = await import('../hook-bridge.js');
  vi.mocked(hooks.loadProjectHooks).mockReturnValue({
    SessionStart: [{ hooks: [projectStartup] }],
    Stop: [],
  });
  try {
    await writeFile(join(root, 'review.md'), 'Unaccepted task instruction must not enter context.');
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    vi.mocked(query).mockImplementation(() => {
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
});

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
it('refuses host recipe compilation for OpenShell before provider preflight or sandbox launch', async () => {
  const { root, chat, transport, unbind } = await setup();
  try {
    vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
    const profiles = new AccountProfiles(
      [
        {
          id: 'fixture',
          label: 'Offline account',
          provider: 'openai-codex',
          credentialRef: '/test/codex',
          email: 'fixture@example.com',
          planType: 'pro',
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
    const open = vi
      .spyOn(codex, 'openCodexChat')
      .mockRejectedValue(Error('Unexpected sandbox launch'));
    await chat.startChat(transport, 'sandbox-context', 'Review this', {
      cwd: root,
      accountId: 'fixture',
      model: 'luna',
      accountProfiles: profiles,
      agentProfile: { profileId: 'bob', revision: 3 },
      operatorConnectionId: 'operator',
    });
    expect(verify).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(transport.send.mock.calls).toContainEqual([
      expect.objectContaining({
        type: 'error',
        error: expect.stringMatching(/context.*local chat/i),
      }),
    ]);
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

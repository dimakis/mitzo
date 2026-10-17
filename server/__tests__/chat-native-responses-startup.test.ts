import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountProfiles } from '../account-profiles.js';
import type { NativeResponsesStore } from '../native-responses-store.js';

const fixture = vi.hoisted(() => ({ stores: [] as NativeResponsesStore[] }));
vi.mock('../native-responses-store.js', async (original) => {
  const actual = await original<typeof import('../native-responses-store.js')>();
  return {
    ...actual,
    NativeResponsesStore: class extends actual.NativeResponsesStore {
      constructor(path: string) {
        super(path);
        fixture.stores.push(this);
      }
    },
  };
});
vi.mock('../credentials.js', async (original) => ({
  ...(await original<object>()),
  credentials: { resolve: vi.fn(async () => 'offline-fixture-key') },
}));
vi.mock('../codex-mcp-tools.js', () => ({
  connectCodexMcpTools: async () => ({
    definitions: [],
    close: async () => {},
    displayName: (name: string) => name,
  }),
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../native-hooks.js', () => ({
  createNativeHooks: () => ({
    hooks: { run: async () => ({ context: '', forcePrompt: false }) },
    dispose() {},
  }),
}));
vi.mock('../prompt-compare.js', () => ({ capturePromptComparison: vi.fn(async () => {}) }));
vi.mock('../session-index.js', async (original) => ({
  ...(await original<object>()),
  registerSession: vi.fn(),
}));
vi.mock('../account-session-name.js', () => ({ accountSessionName: vi.fn(async () => null) }));
vi.mock('../account-use-store.js', () => ({ getAccountUseStore: () => ({ record() {} }) }));

function response() {
  const events = [
    { type: 'response.created', response: { id: 'offline-response', model: 'fixture-selected' } },
    {
      type: 'response.content_part.added',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text' },
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      delta: 'Fixture answer',
    },
    { type: 'response.content_part.done', output_index: 0, content_index: 0 },
    {
      type: 'response.completed',
      response: {
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Fixture answer' }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

afterEach(() => {
  fixture.stores.splice(0).forEach((store) => store.close());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  { name: 'initial text', resume: false, image: false },
  { name: 'initial image', resume: false, image: true },
  { name: 'cold-resume text', resume: true, image: false },
  { name: 'cold-resume image', resume: true, image: true },
])(
  'dispatches admitted $name through the real native runner exactly once',
  async ({ resume, image }) => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), 'mitzo-real-responses-startup-'));
    const privateRoot = join(root, 'private');
    await mkdir(privateRoot, { mode: 0o700 });
    await writeFile(join(root, '.mitzo.json'), '{}');
    vi.stubEnv('REPO_PATH', root);
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', privateRoot);
    vi.stubEnv('MITZO_OPENSHELL_ENABLED', '0');
    vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', '');
    const accountProfiles = new AccountProfiles([
      {
        id: 'fixture-api',
        label: 'Offline fixture',
        provider: 'openai',
        credentialRef: { provider: 'keychain', service: 'offline-fixture', account: 'fixture' },
        models: [
          { id: 'fixture-base', label: 'Base', reasoningEfforts: ['high'] },
          { id: 'fixture-selected', label: 'Selected', reasoningEfforts: ['high'] },
        ],
      },
    ]);
    const conversationId = '66666666-6666-4666-8666-666666666666';
    const commandId = 'exact-startup-command';
    const prompt = 'Inspect this startup';
    const images = image ? [{ data: 'cG5n', mediaType: 'image/png' }] : undefined;
    const expectedContent = image
      ? [
          { type: 'text', text: prompt },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cG5n' } },
        ]
      : prompt;
    const providerBodies: Record<string, unknown>[] = [];
    const dispatchEvidence: unknown[] = [];
    const persistenceEvidence: Array<{ phase?: string; promptCount: number }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === 'https://api.openai.com/v1/responses') {
          const receipt = chat.eventStore.getExecutionAdmission(conversationId, commandId);
          const binding = chat.eventStore.getSession(conversationId)!.accountBinding!;
          const state = fixture.stores.at(-1)!.load(conversationId, binding);
          dispatchEvidence.push({
            attempts: receipt ? chat.eventStore.getProviderAttempts(receipt.token) : [],
            history: state?.history,
          });
          providerBodies.push(JSON.parse(String(init?.body)));
          return response();
        }
        if (/\/api\/agents\/[^/]+\/context$/.test(String(url)))
          return Response.json({ boot: { tokens: 1, content: 'Offline boot fixture' } });
        throw new Error(`Unexpected offline fetch: ${String(url)}`);
      }),
    );
    const chat = await import('../chat.js');
    const responses = await import('../responses-chat-session.js');
    const openChat = vi.spyOn(responses, 'openResponsesChat');
    const { NativeResponsesRunner } = await import('../native-responses-runner.js');
    const prepare = vi.spyOn(NativeResponsesRunner.prototype, 'prepare');
    const runnerErrors: unknown[] = [];
    const run = NativeResponsesRunner.prototype.run;
    vi.spyOn(NativeResponsesRunner.prototype, 'run').mockImplementation(async function* (
      this: InstanceType<typeof NativeResponsesRunner>,
      ...args
    ) {
      try {
        yield* run.apply(this, args);
      } catch (error) {
        runnerErrors.push(error);
        throw error;
      }
    });
    const transport = { send: vi.fn(), isOpen: () => true };
    const onTurnResult = vi.fn();
    let running: Promise<void> | undefined;
    try {
      if (resume) {
        const binding = accountProfiles.resolve('fixture-api', 'fixture-base');
        chat.eventStore.upsertSession({
          sessionId: conversationId,
          cwd: root,
          accountBinding: binding,
          selectedModel: 'fixture-selected',
          reasoningEffort: 'high',
        });
        const { NativeResponsesStore } = await import('../native-responses-store.js');
        const seed = new NativeResponsesStore(join(privateRoot, 'responses.db'));
        const history = [
          { role: 'user' as const, content: 'Previous request' },
          { role: 'assistant' as const, content: 'Previous answer' },
        ];
        seed.save(conversationId, binding, {
          status: 'idle',
          history,
          checkpoint: {
            accountId: binding.accountId,
            model: binding.model,
            history,
            input: [
              { role: 'user', content: [{ type: 'input_text', text: 'Previous request' }] },
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Previous answer' }],
              },
            ],
          },
        });
        fixture.stores.pop()!.close();
        expect(chat.registry.findBySessionId(conversationId)).toBeNull();
      }
      const { NativeResponsesStore } = await import('../native-responses-store.js');
      const saveState = NativeResponsesStore.prototype.save;
      vi.spyOn(NativeResponsesStore.prototype, 'save').mockImplementation(function (
        this: NativeResponsesStore,
        id,
        binding,
        state,
      ) {
        const promptCount = state.history.filter(
          (message) =>
            message.role === 'user' &&
            JSON.stringify(message.content) === JSON.stringify(expectedContent),
        ).length;
        if (id === conversationId && promptCount) {
          const receipt = chat.eventStore.getExecutionAdmission(id, commandId);
          persistenceEvidence.push({
            phase: receipt
              ? chat.eventStore.getProviderAttempts(receipt.token)[0]?.phase
              : undefined,
            promptCount,
          });
        }
        return saveState.call(this, id, binding, state);
      });
      running = chat.startChat(transport, 'real-startup-client', prompt, {
        ...(resume
          ? { resume: conversationId }
          : { initialSessionId: conversationId, accountId: 'fixture-api' }),
        cwd: root,
        isolation: false,
        model: 'fixture-selected',
        reasoningEffort: 'high',
        accountProfiles,
        images,
        clientMsgId: commandId,
        onTurnResult,
      });
      await vi.waitFor(() => expect(onTurnResult).toHaveBeenCalledOnce());
      expect(runnerErrors).toEqual([]);
      expect(providerBodies).toHaveLength(1);
      expect(persistenceEvidence.length).toBeGreaterThan(0);
      for (const write of persistenceEvidence)
        expect(write).toEqual({ phase: 'RUNNING', promptCount: 1 });
      expect(prepare).toHaveBeenCalledExactlyOnceWith(commandId, expectedContent);
      expect(onTurnResult.mock.calls[0][0].is_error).not.toBe(true);
      expect(providerBodies[0]).toMatchObject({
        model: 'fixture-selected',
        reasoning: { effort: 'high' },
      });
      const providerInput = providerBodies[0].input as Array<{ role?: string; content?: unknown }>;
      expect(providerInput.filter((item) => item.role === 'user')).toHaveLength(resume ? 2 : 1);
      expect(providerInput.at(-1)).toMatchObject({
        role: 'user',
        content: image
          ? [
              { type: 'input_text', text: prompt },
              { type: 'input_image', image_url: 'data:image/png;base64,cG5n', detail: 'auto' },
            ]
          : prompt,
      });
      expect(dispatchEvidence).toEqual([
        {
          attempts: [expect.objectContaining({ phase: 'RUNNING' })],
          history: [
            ...(resume
              ? [
                  { role: 'user', content: 'Previous request' },
                  { role: 'assistant', content: 'Previous answer' },
                ]
              : []),
            { role: 'user', content: expectedContent },
          ],
        },
      ]);
      const receipt = chat.eventStore.getExecutionAdmission(conversationId, commandId)!;
      expect(chat.eventStore.getProviderAttempts(receipt.token)).toMatchObject([
        { phase: 'TERMINAL', terminalReason: 'completed' },
      ]);
      const binding = chat.eventStore.getSession(conversationId)!.accountBinding!;
      const state = fixture.stores.at(-1)!.load(conversationId, binding)!;
      expect(state.status).toBe('idle');
      expect(state.history.filter((message) => message.role === 'user')).toHaveLength(
        resume ? 2 : 1,
      );
      expect(state.history.at(-2)).toEqual({ role: 'user', content: expectedContent });
      expect(JSON.stringify(state)).not.toContain('offline-fixture-key');
      expect(openChat).toHaveBeenCalled();
      for (const [options] of openChat.mock.calls) {
        expect(options.configuredSourceEnv).toBeDefined();
        expect(options.configuredSourceEnv).toEqual(chat.nativeExecutionEnv());
        expect(options.env.MITZO_SESSION_ID).toBeDefined();
      }
    } finally {
      chat.stopChat('real-startup-client');
      await running;
      chat.registry.dispose();
      chat.eventStore.close();
      fixture.stores.splice(0).forEach((store) => store.close());
      await rm(root, { recursive: true, force: true });
    }
  },
);

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: vi.fn(),
  listSessions: vi.fn(),
  getSessionInfo: vi.fn(),
  getSessionMessages: vi.fn(),
  renameSession: vi.fn(),
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('keeps a fully persisted SDK search owned by its parent across discovery, admission and restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-internal-boundary-'));
  const parentId = randomUUID();
  const externalId = randomUUID();
  const operationId = 'parent-web-search-tool-call';
  const workspaceRoot = join(root, 'private-sdk-tools');
  const histories = new Map<string, { info: SDKSessionInfo; transcriptPath: string }>();
  let chat: typeof import('../chat.js') | undefined;
  try {
    vi.resetModules();
    vi.stubEnv('REPO_PATH', root);
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    chat = await import('../chat.js');
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    vi.mocked(sdk.renameSession).mockResolvedValue(undefined);
    const { searchSdk } = await import('../web-search-adapters.js');
    const { admitProviderDispatch } = await import('../provider-execution.js');
    vi.mocked(sdk.listSessions).mockImplementation(async () =>
      [...histories.values()].map(({ info }) => info),
    );
    vi.mocked(sdk.getSessionInfo).mockImplementation(async (id) => histories.get(id)?.info);
    vi.mocked(sdk.getSessionMessages).mockImplementation(async (id) => {
      const history = histories.get(id);
      return history ? JSON.parse(readFileSync(history.transcriptPath, 'utf8')) : [];
    });
    // The provider advertises real messages, not the title-only artifact fixed by #768.
    const persistHistory = (id: string, cwd: string, prompt: string) => {
      const transcriptPath = join(root, `${id}.json`);
      writeFileSync(
        transcriptPath,
        JSON.stringify([
          { type: 'user', uuid: `${id}-user`, message: { role: 'user', content: prompt } },
          {
            type: 'assistant',
            uuid: `${id}-assistant`,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Saved answer https://example.com' }],
            },
          },
        ]),
      );
      histories.set(id, {
        transcriptPath,
        info: {
          sessionId: id,
          summary: prompt,
          firstPrompt: prompt,
          lastModified: Date.now(),
          cwd,
        },
      });
    };
    chat.eventStore.upsertSession({
      sessionId: parentId,
      conversationSource: 'mitzo',
      summary: 'Document verification',
      cwd: root,
      numTurns: 1,
    });
    chat.eventStore.append(parentId, 'user_message', {
      v: 2,
      type: 'user_message',
      sessionId: parentId,
      messageId: 'parent-user',
      text: 'Verify the pricing in this document',
    });
    const parentEvents = chat.eventStore.getSessionEvents(parentId);
    const accountEnv = {
      ANTHROPIC_API_KEY: 'mock-selected-account-key',
      CLAUDE_CONFIG_DIR: join(root, 'mock-account'),
      MITZO_SESSION_ID: parentId,
      MITZO_REPO_PRIMARY: root,
      MITZO_INTERNAL_TOKEN: 'parent-only-token',
    };
    let internalId = '';
    vi.mocked(sdk.query).mockImplementation((request) => {
      internalId = request.options!.sessionId!;
      const cwd = request.options!.cwd!;
      expect(internalId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(chat!.eventStore.getInternalSdkExecution(internalId)).toEqual({
        sdkSessionId: internalId,
        parentSessionId: parentId,
        operationId,
        purpose: 'web_search',
        cwd,
      });
      expect(cwd).toBe(join(workspaceRoot, internalId));
      expect(statSync(cwd).mode & 0o777).toBe(0o700);
      expect(request.options!.env).toEqual({
        ANTHROPIC_API_KEY: accountEnv.ANTHROPIC_API_KEY,
        CLAUDE_CONFIG_DIR: accountEnv.CLAUDE_CONFIG_DIR,
      });
      // Simulate a provider ignoring persistSession:false and retaining a full history.
      persistHistory(internalId, cwd, 'Internal pricing search');
      return (async function* () {
        yield {
          type: 'assistant',
          session_id: internalId,
          message: { content: [{ type: 'tool_use', name: 'WebSearch', id: 'search' }] },
        };
        yield {
          type: 'user',
          session_id: internalId,
          message: { content: [{ type: 'tool_result', tool_use_id: 'search' }] },
        };
        yield {
          type: 'result',
          session_id: internalId,
          subtype: 'success',
          result: 'Saved answer https://example.com',
        };
      })() as ReturnType<typeof sdk.query>;
    });
    await expect(
      searchSdk('Internal pricing search', new AbortController().signal, {
        executionStore: chat.eventStore,
        parentSessionId: parentId,
        operationId,
        workspaceRoot,
        env: accountEnv,
        model: 'mock-search-model',
      }),
    ).resolves.toContain('https://example.com');
    expect(accountEnv.MITZO_SESSION_ID).toBe(parentId);
    persistHistory(externalId, root, 'Genuine external CLI conversation');
    expect(histories.get(internalId)!.info.firstPrompt).toBeTruthy();
    expect(await sdk.getSessionMessages(internalId)).toHaveLength(2);

    const assertBoundary = async (controller: typeof import('../chat.js')) => {
      vi.mocked(sdk.renameSession).mockClear();
      const upsert = vi.spyOn(controller.eventStore, 'upsertSession');
      upsert.mockClear();
      for (const id of [internalId, externalId]) {
        await expect(controller.renameSessionById(id, 'Illegal chat rename')).rejects.toThrow(
          /registered|import|internal/i,
        );
      }
      expect(sdk.renameSession).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
      await expect(
        controller.renameSessionById(parentId, 'Document verification'),
      ).resolves.toBeUndefined();
      expect(sdk.renameSession).toHaveBeenCalledWith(
        parentId,
        'Document verification',
        expect.any(Object),
      );
      expect(controller.eventStore.getSession(parentId)?.summary).toBe('Document verification');
      upsert.mockRestore();
      expect((await controller.getSessions()).sessions.map(({ id }) => id)).toEqual([parentId]);
      expect(controller.getSessionsCached().sessions.map(({ id }) => id)).toEqual([parentId]);
      expect((await controller.listImportableSdkConversations()).map(({ id }) => id)).toEqual([
        externalId,
      ]);
      expect(await controller.importSdkConversation(internalId)).toBeNull();
      expect(await controller.getMessages(internalId)).toEqual([]);
      expect(await controller.getMessages(externalId)).toEqual([]);
      expect(controller.eventStore.getSession(externalId)).toBeNull();
      const dispatchCount = vi.mocked(sdk.query).mock.calls.length;
      for (const options of [{ resume: internalId }, { initialSessionId: internalId }]) {
        await expect(
          controller.startChat(
            { send() {}, isOpen: () => true },
            randomUUID(),
            'continue',
            options,
          ),
        ).rejects.toThrow(/conversation|import/i);
      }
      await expect(
        controller.startChat({ send() {}, isOpen: () => true }, randomUUID(), 'continue', {
          resume: externalId,
        }),
      ).rejects.toThrow(/import/i);
      expect(sdk.query).toHaveBeenCalledTimes(dispatchCount);
      const prepare = vi.fn();
      expect(() =>
        admitProviderDispatch({
          store: controller.eventStore,
          request: {
            sessionId: internalId,
            clientMsgId: 'illegal-internal-send',
            effectivePrompt: 'continue',
          },
          prepare,
        }),
      ).toThrow();
      expect(prepare).not.toHaveBeenCalled();
      expect(
        controller.eventStore.getExecutionAdmission(internalId, 'illegal-internal-send'),
      ).toBeUndefined();
      expect(() => controller.eventStore.upsertSession({ sessionId: internalId })).toThrow();
      expect(() =>
        controller.eventStore.append(internalId, 'user_message', { text: 'continue' }),
      ).toThrow();
      expect(controller.eventStore.getSession(internalId)).toBeNull();
      expect(controller.eventStore.getSessionEvents(internalId)).toEqual([]);
      expect(controller.eventStore.getSessionEvents(parentId)).toEqual(parentEvents);
      expect(await controller.getMessages(parentId)).toEqual([
        expect.objectContaining({
          role: 'user',
          blocks: [expect.objectContaining({ content: 'Verify the pricing in this document' })],
        }),
      ]);
    };
    await assertBoundary(chat);

    chat.registry.dispose();
    chat.eventStore.close();
    vi.resetModules();
    chat = await import('../chat.js');
    expect(chat.eventStore.getInternalSdkExecution(internalId)).toMatchObject({
      parentSessionId: parentId,
      operationId,
      purpose: 'web_search',
    });
    await assertBoundary(chat);

    expect(await chat.importSdkConversation(externalId)).toMatchObject({
      sessionId: externalId,
      conversationSource: 'external_import',
    });
    expect((await chat.getSessions()).sessions.map(({ id }) => id)).toEqual(
      expect.arrayContaining([parentId, externalId]),
    );
    expect(await chat.listImportableSdkConversations()).toEqual([]);
    expect(await chat.getMessages(externalId)).toHaveLength(2);
    await expect(chat.renameSessionById(externalId, 'Imported CLI chat')).resolves.toBeUndefined();
    expect(sdk.renameSession).toHaveBeenCalledWith(
      externalId,
      'Imported CLI chat',
      expect.any(Object),
    );
    expect(chat.eventStore.getSession(externalId)?.summary).toBe('Imported CLI chat');
    expect(chat.eventStore.getSession(internalId)).toBeNull();
  } finally {
    chat?.registry.dispose();
    chat?.eventStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

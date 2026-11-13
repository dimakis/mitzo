import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConversation } from '../codex-conversation.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);

it.each(['mitzo_api', 'openai', undefined])(
  'keeps transport provider %s through startup, turns and cold continuation',
  async (selectedProvider) => {
    const root = mkdtempSync(join(tmpdir(), 'codex-provider-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const store = new CodexConversationStore(join(root, 'private.db'));
    cleanup.push(() => store.close());
    const binding = {
      accountId: 'selected-api',
      accountLabel: 'Selected API',
      provider: 'openai' as const,
      model: 'test-model',
      profileRevision: 'selected-api-v1',
    };
    let callbacks: CodexLifecycleTransport;
    let turn = 0;
    const rpc = {
      modelProvider: selectedProvider,
      initialize: async () => {},
      close: () => {},
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method === 'config/read') return { config: {} };
        if (method.startsWith('thread/'))
          return {
            thread: { id: 'native-thread' },
            model: binding.model,
            modelProvider: params.modelProvider,
          };
        if (method === 'turn/start') {
          const id = `turn-${++turn}`;
          callbacks.onNotification('turn/started', { threadId: 'native-thread', turn: { id } });
          return { turn: { id } };
        }
        return {};
      }),
    };
    const create = () => {
      const conversation = new CodexConversation({
        conversationId: 'custom-api',
        cwd: root,
        store,
        profile: {
          ...binding,
          credentialRef: '/synthetic/private-home',
          planType: 'api',
          email: 'synthetic@example.test',
        },
        storedBinding: binding,
        verifyBinding: async () => binding,
        systemPrompt: 'Synthetic offline provider fixture.',
        tools: [],
        createClient: (owner) => {
          callbacks = owner;
          return rpc;
        },
        emit: () => {},
        executeTool: async () => ({ content: 'ok', isError: false }),
      });
      cleanup.push(() => conversation.close());
      return conversation;
    };
    const first = create();
    await first.initialize();
    expect(rpc.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        modelProvider: selectedProvider ?? 'openai',
      }),
    );
    await first.send({ id: 'first-command', prompt: 'First synthetic request.' });
    callbacks!.onNotification('turn/completed', {
      threadId: 'native-thread',
      turn: { id: 'turn-1', status: 'completed' },
    });
    await vi.waitFor(() =>
      expect(store.commands('custom-api', binding)[0].status).toBe('completed'),
    );
    first.close();
    const resumed = create();
    await resumed.initialize();
    expect(rpc.request).toHaveBeenCalledWith(
      'thread/resume',
      expect.objectContaining({
        threadId: 'native-thread',
        modelProvider: selectedProvider ?? 'openai',
        excludeTurns: true,
      }),
    );
    await resumed.send({ id: 'follow-up', prompt: 'Continue the synthetic request.' });
    expect(store.commands('custom-api', binding).map((command) => command.model)).toEqual([
      binding.model,
      binding.model,
    ]);
  },
);

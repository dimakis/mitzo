import './fixtures/offline-user-home.js';
import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'owned-sdk-naming-'));
vi.stubEnv('REPO_PATH', root);
vi.stubEnv('WORKTREE_ENABLED', 'false');
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('Live provider calls forbidden');
  },
  renameSession: vi.fn(async () => {}),
}));
const chat = await import('../chat.js');
afterAll(() => {
  chat.registry.dispose();
  chat.eventStore.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it.each(['anthropic-claude', 'anthropic-vertex', 'anthropic-api'] as const)(
  'names owned %s commands once from public text and preserves manual names',
  async (provider) => {
    const id = `owned-${provider}`;
    const transport = { send: vi.fn(), isOpen: () => true };
    chat.eventStore.upsertSession({
      sessionId: id,
      conversationSource: 'mitzo',
      accountBinding: {
        accountId: 'fixture',
        accountLabel: 'Offline',
        provider,
        model: 'fixture',
        profileRevision: 'offline',
      },
    });
    chat.registry.register(id, {
      sessionId: id,
      transport,
      abortController: new AbortController(),
      mode: 'auto',
      cwd: root,
      sessionAllowList: new Set(),
    });
    const payload = { text: 'Fix Claude calendar sync' };
    const fullHistory = vi.spyOn(chat.eventStore, 'getSessionEvents').mockImplementation(() => {
      throw Error('Naming must use the bounded public history projection');
    });
    chat.echoOwnedSdkCommand(id, 'first', payload);
    await vi.waitFor(() => expect(chat.eventStore.getSession(id)?.summary).toBe(payload.text));
    expect(fullHistory).not.toHaveBeenCalled();
    fullHistory.mockRestore();
    expect(chat.eventStore.getSession(id)?.promptCount).toBe(1);
    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_renamed', name: payload.text }),
    );
    chat.echoOwnedSdkCommand(id, 'first', payload);
    expect(chat.eventStore.getSession(id)?.promptCount).toBe(1);
    await chat.renameSessionById(id, 'My calendar task', true);
    for (const commandId of ['second', 'third', 'fourth'])
      chat.echoOwnedSdkCommand(id, commandId, { text: 'Replace the task title' });
    await Promise.resolve();
    expect(chat.eventStore.getSession(id)?.summary).toBe('My calendar task');
    expect(
      chat.eventStore.getSessionEvents(id).filter((event) => event.type === 'user_message'),
    ).toHaveLength(4);
  },
);

it('names a substantive request after a generic start and a long tool history', async () => {
  const id = 'owned-sdk-late-request';
  const transport = { send: vi.fn(), isOpen: () => true };
  chat.eventStore.upsertSession({
    sessionId: id,
    conversationSource: 'mitzo',
    initialPrompt: 'Continue',
    accountBinding: {
      accountId: 'fixture',
      accountLabel: 'Offline',
      provider: 'anthropic-claude',
      model: 'fixture',
      profileRevision: 'offline',
    },
  });
  chat.registry.register(id, {
    sessionId: id,
    transport,
    abortController: new AbortController(),
    mode: 'auto',
    cwd: root,
    sessionAllowList: new Set(),
  });
  chat.echoOwnedSdkCommand(id, 'first', { text: 'Continue' });
  for (let i = 0; i < 300; i++)
    chat.eventStore.append(id, 'tool_result', { result: 'PRIVATE tool output '.repeat(100) });
  chat.echoOwnedSdkCommand(id, 'second', { text: 'Continue' });
  chat.echoOwnedSdkCommand(id, 'third', { text: 'Continue' });
  chat.echoOwnedSdkCommand(id, 'fourth', { text: 'Repair delayed calendar notifications' });
  await vi.waitFor(() =>
    expect(chat.eventStore.getSession(id)?.summary).toBe('Repair delayed calendar notifications'),
  );
  expect(chat.eventStore.getSession(id)?.promptCount).toBe(4);
});

import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConversation } from '../codex-conversation.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { AdviserTaskScope } from '../adviser-task-scope.js';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function fixture(bad = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'adviser-native-')));
  const store = new CodexConversationStore(join(directory, 'history.db'));
  const scope = new AdviserTaskScope(
    {
      authSessionId: 'operator',
      feature: { kind: 'terminal', terminalId: 'term' },
      accountId: 'work',
      model: 'gpt-6-luna',
      instructions: 'Reviewed task',
      messages: [{ role: 'user', content: 'Explain' }],
    },
    () => {},
    new AbortController().signal,
  );
  scope.bindCommand('task', 'command');
  const request = vi.fn(async (method: string) => {
    if (method === 'config/read') return { config: { mcp_servers: { inherited: {} } } };
    if (method === 'skills/list')
      return {
        data: [
          {
            cwd: directory,
            skills: [{ path: '/unreviewed/SKILL.md' }],
            errors: bad ? ['unavailable'] : [],
          },
        ],
      };
    return { thread: { id: 'native' }, model: 'gpt-6-luna', modelProvider: 'openai' };
  });
  const policy = codexNativeExecutionPolicy({
    bindingRevision: 'bound',
    cwd: directory,
    mode: 'ask',
    readableRoots: scope.nativeReadRoots(directory),
    writableRoots: [directory],
    deniedRoots: ['/unreviewed'],
  });
  const c = new CodexConversation({
    conversationId: 'task',
    cwd: directory,
    profile: {
      accountId: 'work',
      accountLabel: 'Work',
      credentialRef: '/synthetic',
      email: 'test@example.invalid',
      planType: 'test',
      model: 'gpt-6-luna',
    },
    storedBinding: {
      accountId: 'work',
      accountLabel: 'Work',
      provider: 'openai-codex',
      profileRevision: 'revision',
      model: 'gpt-6-luna',
    },
    store,
    systemPrompt: scope.instructions(),
    tools: [],
    adviserScope: scope,
    disableProjectDocuments: true,
    disableWebSearch: true,
    nativeExecution: policy,
    assertNativeExecutionCurrent: () => {},
    requestNativeApproval: async () => ({ decision: 'decline' }),
    verifyBinding: async () => ({
      accountId: 'work',
      accountLabel: 'Work',
      provider: 'openai-codex',
      profileRevision: 'revision',
      model: 'gpt-6-luna',
    }),
    createClient: () => ({ initialize: async () => {}, request, close: () => {} }),
    emit: () => {},
    executeTool: async () => {
      throw Error('No product tools');
    },
  });
  cleanup.push(() => {
    c.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { c, request, policy, directory };
}
it('sends disabled discovered skills and a read-only task-only profile before native thread creation', async () => {
  const f = fixture();
  await f.c.initialize();
  expect(f.request.mock.calls.map(([method]) => method)).toEqual([
    'config/read',
    'skills/list',
    'thread/start',
  ]);
  const params = (
    f.request.mock.calls.find(([method]) => method === 'thread/start') as unknown as [
      string,
      Record<string, unknown>,
    ]
  )[1];
  expect(params).toMatchObject({
    permissions: 'mitzo-native-ask',
    runtimeWorkspaceRoots: [f.directory],
    config: {
      web_search: 'disabled',
      project_doc_max_bytes: 0,
      'skills.config': [{ path: '/unreviewed/SKILL.md', enabled: false }],
      'mcp_servers.inherited.enabled': false,
    },
  });
  expect(f.policy.readableRoots).toEqual([f.directory]);
  expect(f.policy.writableRoots).toEqual([]);
});
it('refuses an unavailable skill scope before any native thread is allocated', async () => {
  const f = fixture(true);
  await expect(f.c.initialize()).rejects.toThrow();
  expect(f.request.mock.calls.map(([method]) => method)).not.toContain('thread/start');
});

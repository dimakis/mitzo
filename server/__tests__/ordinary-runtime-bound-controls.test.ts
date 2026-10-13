import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectionRegistry } from '@mitzo/harness';
import { NativeCommandRegistry } from '../native-commands.js';
import { permissionRevision } from '../session-permission-revision.js';

const native = vi.hoisted(() => ({
  admitExplicitSend: vi.fn(async () => ({ model: 'fixture-model' })),
  resumeAfterExplicitSend: vi.fn(async () => {}),
  interrupt: vi.fn(async () => {}),
  validateModel: vi.fn(),
}));
vi.mock('../codex-chat-session.js', () => ({
  getCodexRuntime: () => native,
  publicCodexRuntimeError: (error: Error) => error.message,
}));
vi.mock('../responses-chat-session.js', () => ({ getResponsesRuntime: () => undefined }));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../auto-rename.js', () => ({ shouldAutoRename: () => false }));
vi.mock('../app.js', () => ({
  buildSkillRegistry: () => new Map(),
  isAllowedPath: () => true,
  NATIVE_COMMAND_NAMES: new Set(),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => {
    throw Error('Real model calls are forbidden');
  }),
}));

let chat: typeof import('../chat.js');
let ws: typeof import('../ws-handler-v2.js');
let root: string;
let sequence = 0;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-runtime-controls-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No network in runtime control fixture');
    }),
  );
  chat = await import('../chat.js');
  ws = await import('../ws-handler-v2.js');
});
afterAll(() => {
  chat?.eventStore.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function fixture(bound = true, live = true) {
  vi.clearAllMocks();
  const id = `runtime-controls-${++sequence}`;
  const binding = {
    version: 2,
    account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'profile-1' },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'target-1' },
  } as const;
  const accountBinding = { ...binding.account, accountLabel: 'Personal', model: 'fixture-model' };
  const meta = {
    sessionId: id,
    cwd: root,
    mode: 'agent',
    accountBinding,
    repositoryWorkspaceId: id,
  } as const;
  const commandId = `${id}-first`;
  if (bound)
    chat.eventStore.admitOrdinaryLocalCommand(meta, binding, {
      clientMsgId: commandId,
      requestFingerprint: `${id}-fingerprint`,
      payload: { prompt: 'first' },
      selection: {
        version: 1,
        agent: { profileId: 'agent', revision: 1 },
        context: { source: 'none', revision: null },
        permission: { mode: 'agent', revision: 0 },
        model: 'fixture-model',
        thinking: null,
      },
    });
  else chat.eventStore.upsertSession(meta);
  const transport = { send: vi.fn(), isOpen: () => true };
  const close = vi.fn();
  const queue = { push: vi.fn(), close: vi.fn() };
  const query = {
    interrupt: native.interrupt,
    close,
    setPermissionMode: vi.fn(async () => {}),
    stopTask: vi.fn(async () => {}),
  };
  if (live) {
    chat.registry.register(id, {
      transport,
      abortController: new AbortController(),
      sessionId: id,
      sessionAllowList: new Set(),
      mode: 'agent',
      cwd: root,
      accountBinding,
      ownerConnectionId: 'browser',
    });
    const session = chat.registry.get(id)!;
    session.inputQueue = queue;
    session.queryInstance = query;
    chat.eventStore.setSessionState(id, 'ACTIVE');
  }
  const connections = new ConnectionRegistry();
  connections.register('browser', transport);
  const context = {
    connRegistry: connections,
    sessionRegistry: chat.registry,
    eventStore: chat.eventStore,
    nativeCommands: new NativeCommandRegistry(),
  };
  return { id, commandId, transport, queue, query, context };
}

it('refuses runtime-bound hot sends before native queue, transcript or model selection effects', async () => {
  const f = fixture();
  await expect(
    chat.sendToChat(f.id, 'next', undefined, undefined, `${f.id}-next`, 'other-model', 'high'),
  ).rejects.toThrow('Runtime-bound commands require guarded admission');
  expect(native.admitExplicitSend).not.toHaveBeenCalled();
  expect(native.resumeAfterExplicitSend).not.toHaveBeenCalled();
  expect(f.queue.push).not.toHaveBeenCalled();
  expect(f.transport.send).not.toHaveBeenCalled();
  expect(chat.eventStore.hasUserMessage(f.id, `${f.id}-next`)).toBe(false);
  expect(chat.registry.get(f.id)?.model).not.toBe('other-model');
});

it('refuses an exact first-command retry on the legacy hot send path', async () => {
  const f = fixture();
  await expect(chat.sendToChat(f.id, 'first', undefined, undefined, f.commandId)).rejects.toThrow(
    'Runtime-bound commands require guarded admission',
  );
  expect(native.admitExplicitSend).not.toHaveBeenCalled();
  expect(chat.eventStore.getOrdinaryLocalCommandAdmission(f.commandId)?.state).toBe('reserved');
});

it('preflights runtime-bound Codex even without a message ID, before the Responses-only shortcut', () => {
  const f = fixture();
  expect(() => chat.preflightChatCommand(f.id, 'next')).toThrow(
    'Runtime-bound commands require guarded admission',
  );
  expect(() => chat.preflightChatCommand(f.id, 'first', undefined, undefined, f.commandId)).toThrow(
    'Runtime-bound commands require guarded admission',
  );
});

it('keeps legacy Codex hot send behavior', async () => {
  const f = fixture(false);
  expect(chat.preflightChatCommand(f.id, 'next')).toBe(false);
  await expect(chat.sendToChat(f.id, 'next', undefined, undefined, `${f.id}-next`)).resolves.toBe(
    true,
  );
  expect(native.admitExplicitSend).toHaveBeenCalledOnce();
  expect(chat.eventStore.hasUserMessage(f.id, `${f.id}-next`)).toBe(true);
});

it('interrupts runtime-bound execution without admitting accompanying replacement input', async () => {
  const f = fixture();
  await expect(
    chat.interruptChat(
      f.id,
      'replacement',
      undefined,
      undefined,
      `${f.id}-replacement`,
      'other-model',
    ),
  ).resolves.toBe(false);
  expect(native.interrupt).toHaveBeenCalledOnce();
  expect(native.validateModel).not.toHaveBeenCalled();
  expect(native.admitExplicitSend).not.toHaveBeenCalled();
  expect(f.queue.push).not.toHaveBeenCalled();
  expect(chat.eventStore.hasUserMessage(f.id, `${f.id}-replacement`)).toBe(false);
  expect(f.transport.send).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'error',
      error: 'Execution interrupted. Runtime-bound commands require guarded admission',
    }),
  );
});

it('allows a plain runtime-bound interrupt and ordinary Stop', async () => {
  const f = fixture();
  await expect(chat.interruptChat(f.id, '')).resolves.toBe(true);
  expect(native.interrupt).toHaveBeenCalledOnce();
  expect(f.transport.send).not.toHaveBeenCalled();
  chat.stopChat(f.id);
  expect(f.query.close).toHaveBeenCalledOnce();
  expect(f.queue.close).toHaveBeenCalledOnce();
});

it('routes bound WS interruption directly to cancellation without takeover or new input', async () => {
  const f = fixture();
  const requester = { send: vi.fn(), isOpen: () => true };
  await ws.handleInterruptV2(
    'another-browser',
    requester,
    {
      type: 'interrupt',
      sessionId: f.id,
      clientMsgId: `${f.id}-replacement`,
      prompt: 'replacement',
    },
    f.context,
  );
  expect(native.interrupt).toHaveBeenCalledOnce();
  expect(native.admitExplicitSend).not.toHaveBeenCalled();
  expect(chat.registry.get(f.id)?.ownerConnectionId).toBe('browser');
  expect(chat.eventStore.getSendCommand(`${f.id}-replacement`)).toBeUndefined();
  expect(f.transport.send).not.toHaveBeenCalled();
  expect(requester.send).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'error',
      error: 'Execution interrupted. Runtime-bound commands require guarded admission',
    }),
  );
});

it('allows blank WS interrupt but never cold-starts a bound runtime for interruption', async () => {
  const live = fixture();
  await ws.handleInterruptV2(
    'browser',
    live.transport,
    { type: 'interrupt', sessionId: live.id, clientMsgId: `${live.id}-interrupt`, prompt: '' },
    live.context,
  );
  expect(native.interrupt).toHaveBeenCalledOnce();
  expect(live.transport.send).not.toHaveBeenCalled();
  const cold = fixture(true, false);
  await ws.handleInterruptV2(
    'browser',
    cold.transport,
    {
      type: 'interrupt',
      sessionId: cold.id,
      clientMsgId: `${cold.id}-replacement`,
      prompt: 'replacement',
    },
    cold.context,
  );
  expect(native.interrupt).not.toHaveBeenCalled();
  expect(native.admitExplicitSend).not.toHaveBeenCalled();
  expect(chat.registry.findBySessionId(cold.id)).toBeNull();
  expect(cold.transport.send).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'error',
      error: 'Runtime-bound commands require guarded admission',
    }),
  );
});

it('refuses input attachments or model edits on a blank interrupt without persisting a user command', async () => {
  const f = fixture();
  await expect(
    chat.interruptChat(
      f.id,
      '',
      undefined,
      ['attached'],
      `${f.id}-replacement`,
      'other-model',
      'high',
    ),
  ).resolves.toBe(false);
  expect(native.interrupt).toHaveBeenCalledOnce();
  expect(native.validateModel).not.toHaveBeenCalled();
  expect(native.admitExplicitSend).not.toHaveBeenCalled();
  expect(chat.eventStore.getSendCommand(`${f.id}-replacement`)).toBeUndefined();
  expect(chat.eventStore.getOrdinaryLocalCommandAdmission(f.commandId)?.state).toBe('reserved');
});

it.each([true, false])(
  'refuses bound permission edits before live or historical policy effects (live=%s)',
  async (live) => {
    const f = fixture(true, live);
    const result = await ws.handleSetModeV2(
      'browser',
      { type: 'set_mode', sessionId: f.id, mode: 'auto' },
      f.context,
    );
    expect(result).toMatchObject({
      ok: false,
      applied: false,
      persisted: false,
      error: 'Runtime-bound settings require guarded admission',
    });
    expect(f.query.setPermissionMode).not.toHaveBeenCalled();
    expect(chat.eventStore.getSession(f.id)?.mode).toBe('agent');
    expect(permissionRevision(chat.eventStore, f.id)).toBeUndefined();
  },
);

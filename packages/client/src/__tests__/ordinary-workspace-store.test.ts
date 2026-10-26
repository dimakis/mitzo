import { expect, it, vi } from 'vitest';
import { createMitzoStore } from '../store.js';
import { OrdinaryWorkspaceFirstCommandSchema } from '@mitzo/protocol';
const channel = vi.hoisted(() => ({
  listener: (_event: Record<string, unknown>) => {},
  id: null as string | null,
  send: vi.fn(),
}));
vi.mock('../sse-connection.js', () => ({
  SseConnection: class {
    onMessage(fn: typeof channel.listener) {
      channel.listener = fn;
    }
    connect() {}
    getConnectionId() {
      return channel.id;
    }
    isConnected() {
      return !!channel.id;
    }
    send = channel.send;
    getLastSeq() {
      return 0;
    }
    trackSeq() {}
    commitTranscriptCursor() {}
    getTrackedSessions() {
      return [];
    }
    clearSession() {}
    clearPendingSends() {}
    advanceSendScope() {}
    blockAuthentication() {}
    invalidateAuthentication() {}
    restoreAuthentication() {}
    checkAndReconnect() {}
    sendSuspend() {}
  },
}));
const command = OrdinaryWorkspaceFirstCommandSchema.parse({
  version: 2,
  runOn: 'local',
  sessionId: 'prepared-ordinary',
  workspace: { kind: 'ordinary', workspaceId: '11111111-1111-4111-8111-111111111111' },
  clientMsgId: 'original-ordinary-command',
  capabilityRevision: 'caps-r1',
  runtime: {
    account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'r1' },
    harness: 'codex',
    targetId: 'mac',
    mode: 'agent',
  },
  selection: {
    version: 1,
    agent: { profileId: 'worker', revision: 1 },
    model: 'fixture-model',
    thinking: 'low',
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
  },
  payload: { text: 'Original ordinary draft' },
});
const ack = (sessionId = command.sessionId) =>
  new Response(
    JSON.stringify({
      ok: true,
      clientMsgId: command.clientMsgId,
      sessionId,
      state: 'consumed',
      dispatched: true,
    }),
    { status: 202 },
  );
function fixture(raw: string | null = null) {
  channel.id = null;
  channel.send.mockReset();
  const fetch = vi
    .fn()
    .mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('/api/ordinary/workspaces/commands/') ? ack() : new Response('[]'),
      ),
    );
  const storage = {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      raw = value;
    },
  };
  const store = createMitzoStore({
    transport: { fetch },
    wsConfig: {
      buildUrl: () => '',
      createWebSocket: () => {
        throw Error('No WebSocket');
      },
    },
    sseConfig: { baseUrl: '', fetch },
    localFirstCommandConfig: { url: '/local/send', storage },
  });
  return { store, fetch, saved: () => JSON.parse(raw ?? '[]') };
}
it.each(['first', 'continue'] as const)(
  'uses the exact %s V2 route only with current SSE and the active prepared session',
  async (phase) => {
    const f = fixture(),
      delivered = vi.fn();
    expect(f.store.getState().sendOrdinaryWorkspaceCommand(command, phase)).toBe(false);
    channel.id = 'current-sse';
    expect(f.store.getState().sendOrdinaryWorkspaceCommand(command, phase)).toBe(false);
    await f.store.getState().switchSession(command.sessionId);
    expect(
      f.store.getState().sendOrdinaryWorkspaceCommand(command, phase, { onDelivery: delivered }),
    ).toBe(true);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith('accepted'));
    const calls = f.fetch.mock.calls.filter(([url]) =>
      url.startsWith('/api/ordinary/workspaces/commands/'),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/api/ordinary/workspaces/commands/' + phase);
    expect(JSON.parse(calls[0][1].body)).toEqual(command);
    expect(calls[0][1].headers['X-Connection-ID']).toBe('current-sse');
    expect(f.store.getState().localCommand).toMatchObject({
      request: command,
      ordinaryPhase: phase,
      state: 'consumed',
    });
    expect(channel.send.mock.calls.some(([body]) => body.type === 'send')).toBe(false);
  },
);
it('keeps the original payload and phase through lost response, logout and reload, with deliberate exact recovery', async () => {
  const f = fixture();
  channel.id = 'initial-sse';
  await f.store.getState().switchSession(command.sessionId);
  f.fetch.mockRejectedValue(Error('lost'));
  expect(
    f.store
      .getState()
      .sendOrdinaryWorkspaceCommand(command, 'first', { draftId: 'original-draft' }),
  ).toBe(true);
  await vi.waitFor(() => expect(f.store.getState().localCommand?.state).toBe('uncertain'));
  f.store.getState().invalidateAuthentication();
  channel.id = 'reattached-sse';
  f.store.getState().restoreAuthentication();
  expect(
    f.fetch.mock.calls.filter(
      ([path]) =>
        path.startsWith('/api/ordinary/workspaces/commands/') && !path.endsWith('/receipt'),
    ),
  ).toHaveLength(1);
  const restored = fixture(JSON.stringify(f.saved()));
  channel.id = 'reloaded-sse';
  await restored.store.getState().switchSession(command.sessionId);
  expect(restored.store.getState().localCommand).toMatchObject({
    request: command,
    ordinaryPhase: 'first',
    originDraftId: 'original-draft',
    state: 'uncertain',
  });
  expect(
    restored.fetch.mock.calls.filter(
      ([path]) =>
        path.startsWith('/api/ordinary/workspaces/commands/') && !path.endsWith('/receipt'),
    ),
  ).toHaveLength(0);
  expect(
    restored.store
      .getState()
      .sendOrdinaryWorkspaceCommand({ ...command, clientMsgId: 'replacement' }, 'continue'),
  ).toBe(false);
  expect(restored.store.getState().recoverLocalCommand()).toBe(true);
  await vi.waitFor(() => expect(restored.store.getState().localCommand?.state).toBe('consumed'));
  const call = restored.fetch.mock.calls.find(
    ([path]) => path === '/api/ordinary/workspaces/commands/first',
  )!;
  expect(JSON.parse(call[1].body)).toEqual(command);
  expect(call[1].headers['X-Connection-ID']).toBe('reloaded-sse');
});
it('does not adopt a delayed receipt into a different conversation or erase its newer draft', async () => {
  const f = fixture();
  channel.id = 'current-sse';
  await f.store.getState().switchSession(command.sessionId);
  let complete!: (value: Response) => void;
  f.fetch.mockImplementation((path: string) =>
    path.startsWith('/api/ordinary/workspaces/commands/')
      ? new Promise<Response>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(new Response('[]')),
  );
  const delivered = vi.fn(),
    assigned = vi.fn();
  expect(
    f.store.getState().sendOrdinaryWorkspaceCommand(command, 'first', {
      onDelivery: delivered,
      onSessionAssigned: assigned,
      draftId: 'original-draft',
    }),
  ).toBe(true);
  await f.store.getState().switchSession('different-conversation');
  complete(ack());
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith('accepted'));
  expect(f.store.getState().sessions.active).toBe('different-conversation');
  expect(assigned).not.toHaveBeenCalled();
  expect(f.store.getState().messages.messages).toEqual([]);
});
it('preserves strict legacy entry and refuses forged paths, mismatched session and invalid phase before POST', async () => {
  const f = fixture();
  channel.id = 'current-sse';
  await f.store.getState().switchSession(command.sessionId);
  expect(f.store.getState().sendLocalFirstCommand(command as never)).toBe(false);
  expect(
    f.store
      .getState()
      .sendOrdinaryWorkspaceCommand({ ...command, cwd: '/forged' } as never, 'first'),
  ).toBe(false);
  expect(
    f.store.getState().sendOrdinaryWorkspaceCommand({ ...command, sessionId: 'other' }, 'first'),
  ).toBe(false);
  expect(f.store.getState().sendOrdinaryWorkspaceCommand(command, 'unknown' as never)).toBe(false);
  expect(
    f.fetch.mock.calls.filter(([path]) => path.startsWith('/api/ordinary/workspaces/commands/')),
  ).toHaveLength(0);
  expect(f.saved()).toEqual([]);
});

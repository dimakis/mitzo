// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMitzoStore } from '@mitzo/client';
import { OrdinaryWorkspaceFirstCommandSchema } from '@mitzo/protocol';
const channel = vi.hoisted(() => ({
  listener: (_event: Record<string, unknown>) => {},
  id: null as string | null,
  send: vi.fn(),
}));
vi.mock('../../../packages/client/src/sse-connection.js', () => ({
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

import { agentBuilderCommandHandoff, openAgentBuilderChat } from './agent-builder-chat';
import { getChatDraft, saveChatDraft } from './chat-drafts';
import { newAgentDefinition } from './agent-library';
import { apiFetch } from './api-fetch';
import { createReviewedOutboxStorage } from './reviewed-outbox-storage';
const productionLocalStorage = () =>
  createReviewedOutboxStorage(
    localStorage,
    new URL('/api/chat/local-codex/send', window.location.href).href,
    'local',
  );
vi.mock('./api-fetch', async (original) => ({ ...(await original<object>()), apiFetch: vi.fn() }));
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  channel.id = 'live-sse';
  channel.send.mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    Response.json({ sessionId: String(url).split('/')[3], isHidden: false }),
  );
});
afterEach(() => vi.clearAllMocks());
const input = {
  profileId: 'bob',
  definition: { ...newAgentDefinition(), name: 'Working Bob' },
  expectedVersion: 2,
  baseRevision: 3,
  publishedRevision: 3,
};
async function fixture() {
  const path = await openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.test').searchParams.get('draft')!)!;
  const request = {
    ...command,
    payload: { ...command.payload, sourceSnapshots: draft.settings.sourceSnapshots },
  };
  const source = draft.settings.sourceSnapshots![0];
  const ack = (sessionId = request.sessionId, status = 202) =>
    Response.json(
      {
        ok: true,
        clientMsgId: request.clientMsgId,
        sessionId,
        state: 'consumed',
        dispatched: true,
      },
      { status },
    );
  let accept = true;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/ordinary/workspaces/commands/')) {
      expect(JSON.parse(String(init?.body))).toEqual(request);
      if (!accept) throw Error('Offline acknowledgement loss');
      return ack();
    }
    return Response.json([]);
  });
  const launches = {
    pending: vi.fn(() => false),
    prepare: vi.fn(() => true),
    assign: vi.fn(),
    settle: vi.fn(),
  };
  const create = () =>
    createMitzoStore({
      transport: { fetch },
      sendHandoff: agentBuilderCommandHandoff,
      launchDrafts: launches,
      wsConfig: {
        buildUrl: () => '',
        createWebSocket: () => {
          throw Error('No WebSocket');
        },
      },
      sseConfig: { baseUrl: '', fetch },
      localFirstCommandConfig: {
        url: '/api/chat/local-codex/send',
        storage: productionLocalStorage(),
      },
    });
  const store = create();
  await store.getState().switchSession(request.sessionId);
  return {
    store,
    create,
    fetch,
    request,
    source,
    path,
    draft,
    ack,
    launches,
    lose: () => {
      accept = false;
    },
    accept: () => {
      accept = true;
    },
  };
}
it.each(['first'] as const)(
  'finalizes the actual durable Builder source on an acknowledged bound ordinary %s without assigning a launch',
  async (phase) => {
    const f = await fixture(),
      assigned = vi.fn();
    expect(
      f.store
        .getState()
        .sendOrdinaryWorkspaceCommand(f.request, phase, { onSessionAssigned: assigned }),
    ).toBe(true);
    await vi.waitFor(() => expect(f.store.getState().localCommand?.state).toBe('consumed'));
    expect(await openAgentBuilderChat(input, true)).toBe('/chat/' + f.request.sessionId);
    expect(
      JSON.parse(
        localStorage.getItem('mitzo-agent-builder-chat:command:' + f.request.clientMsgId)!,
      ),
    ).toEqual({ revision: f.source.revision, sessionId: f.request.sessionId });
    expect(assigned).not.toHaveBeenCalled();
    expect(f.launches.assign).not.toHaveBeenCalled();
  },
);
it('restores the original source handoff after an uncertain V2 first command and exact cold outbox retry', async () => {
  const f = await fixture();
  f.lose();
  expect(f.store.getState().sendOrdinaryWorkspaceCommand(f.request, 'first')).toBe(true);
  await vi.waitFor(() => expect(f.store.getState().localCommand?.state).toBe('uncertain'));
  expect(JSON.parse(productionLocalStorage().getItem('queue')!)).toEqual([
    expect.objectContaining({
      body: f.request,
      ordinaryDelivery: { version: 2, phase: 'first' },
      uncertain: true,
    }),
  ]);
  expect(await openAgentBuilderChat(input, true)).toBe(f.path);
  expect(agentBuilderCommandHandoff.prepare({ ...f.request, clientMsgId: 'replacement' })).toBe(
    false,
  );
  f.store.getState().invalidateAuthentication();
  f.accept();
  const restored = f.create();
  await restored.getState().switchSession(f.request.sessionId);
  expect(
    f.fetch.mock.calls.filter(([url]) => url.startsWith('/api/ordinary/workspaces/commands/')),
  ).toHaveLength(1);
  expect(restored.getState().recoverLocalCommand()).toBe(true);
  await vi.waitFor(() => expect(restored.getState().localCommand?.state).toBe('consumed'));
  expect(await openAgentBuilderChat(input, true)).toBe('/chat/' + f.request.sessionId);
  const posts = f.fetch.mock.calls.filter(([url]) =>
    url.startsWith('/api/ordinary/workspaces/commands/'),
  );
  expect(posts).toHaveLength(2);
  expect(JSON.parse(productionLocalStorage().getItem('queue')!)).toEqual([]);
  expect(f.launches.assign).not.toHaveBeenCalled();
});
it('finalizes a delayed source receipt while preserving another active conversation and the newer actual draft', async () => {
  const f = await fixture();
  let finish!: (value: Response) => void;
  f.fetch.mockImplementation(async (url: string) =>
    url.startsWith('/api/ordinary/workspaces/commands/')
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : Response.json([]),
  );
  const assigned = vi.fn();
  expect(
    f.store
      .getState()
      .sendOrdinaryWorkspaceCommand(f.request, 'first', { onSessionAssigned: assigned }),
  ).toBe(true);
  f.draft.text = 'Newer unsent Builder question';
  saveChatDraft(f.draft);
  await f.store.getState().switchSession('different-conversation');
  finish(f.ack());
  await vi.waitFor(() => expect(f.store.getState().localCommand?.state).toBe('consumed'));
  expect(await openAgentBuilderChat(input, true)).toBe('/chat/' + f.request.sessionId);
  expect(f.store.getState().sessions.active).toBe('different-conversation');
  expect(getChatDraft(f.draft.id)?.text).toBe('Newer unsent Builder question');
  expect(assigned).not.toHaveBeenCalled();
  expect(f.launches.assign).not.toHaveBeenCalled();
});
it.each([409, 202])(
  'retains pending source ownership for HTTP%s without an exact acknowledgement',
  async (status) => {
    const f = await fixture();
    f.fetch.mockImplementation(async (url: string) =>
      url.startsWith('/api/ordinary/workspaces/commands/')
        ? f.ack('foreign-session', status)
        : Response.json([]),
    );
    expect(f.store.getState().sendOrdinaryWorkspaceCommand(f.request, 'first')).toBe(true);
    await vi.waitFor(() => expect(f.store.getState().localCommand?.state).not.toBe('pending'));
    expect(f.store.getState().localCommand?.state).not.toBe('consumed');
    expect(await openAgentBuilderChat(input, true)).toBe(f.path);
    expect(
      JSON.parse(
        localStorage.getItem('mitzo-agent-builder-chat:command:' + f.request.clientMsgId)!,
      ),
    ).toEqual({ revision: f.source.revision });
  },
);

it('does not treat a continuation receipt as first-command source assignment', async () => {
  const f = await fixture();
  expect(f.store.getState().sendOrdinaryWorkspaceCommand(f.request, 'continue')).toBe(true);
  await vi.waitFor(() => expect(f.store.getState().localCommand?.state).toBe('consumed'));
  expect(await openAgentBuilderChat(input, true)).toBe(f.path);
  expect(
    JSON.parse(localStorage.getItem('mitzo-agent-builder-chat:command:' + f.request.clientMsgId)!),
  ).toEqual({ revision: f.source.revision });
  expect(f.launches.assign).not.toHaveBeenCalled();
});

it('retains the exact command when durable source assignment fails, then completes the same handoff on explicit retry', async () => {
  const f = await fixture();
  let finish!: (value: Response) => void;
  f.fetch.mockImplementation(async (url: string) =>
    url.startsWith('/api/ordinary/workspaces/commands/')
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : Response.json([]),
  );
  const delivered = vi.fn();
  expect(
    f.store.getState().sendOrdinaryWorkspaceCommand(f.request, 'first', { onDelivery: delivered }),
  ).toBe(true);
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (key === 'mitzo-agent-builder-chat:' + f.source.revision && JSON.parse(value).sessionId)
      throw Error('Injected source assignment quota failure');
    return original.call(this, key, value);
  };
  try {
    finish(f.ack());
    await vi.waitFor(() => expect(f.store.getState().localCommand?.state).toBe('uncertain'));
    expect(delivered).not.toHaveBeenCalledWith('accepted');
    expect(await openAgentBuilderChat(input, true)).toBe(f.path);
  } finally {
    Storage.prototype.setItem = original;
  }
  f.fetch.mockImplementation(async (url: string) =>
    url.startsWith('/api/ordinary/workspaces/commands/') ? f.ack() : Response.json([]),
  );
  expect(f.store.getState().recoverLocalCommand()).toBe(true);
  await vi.waitFor(() => expect(f.store.getState().localCommand?.state).toBe('consumed'));
  expect(await openAgentBuilderChat(input, true)).toBe('/chat/' + f.request.sessionId);
  const posts = f.fetch.mock.calls.filter(([url]) =>
    url.startsWith('/api/ordinary/workspaces/commands/'),
  );
  expect(posts.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([f.request, f.request]);
  expect(f.launches.assign).not.toHaveBeenCalled();
});

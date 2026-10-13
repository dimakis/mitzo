import { expect, it, vi } from 'vitest';
import { createMitzoStore } from '../store.js';
const channel = vi.hoisted(() => ({
  listener: (_event: Record<string, unknown>) => {},
  id: null as string | null,
  send: vi.fn(),
  cursors: new Map<string, number>(),
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
    getLastSeq(id: string) {
      return channel.cursors.get(id) ?? 0;
    }
    trackSeq() {}
    commitTranscriptCursor(id: string, cursor: number) {
      channel.cursors.set(id, cursor);
    }
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
const request = {
  runOn: 'local' as const,
  repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
  clientMsgId: 'local-first',
  capabilityRevision: 'caps-r1',
  runtime: {
    account: { accountId: 'personal', provider: 'openai-codex' as const, profileRevision: 'r1' },
    harness: 'codex' as const,
    targetId: 'mac',
    mode: 'agent' as const,
  },
  selection: {
    version: 1 as const,
    agent: { profileId: 'agent', revision: 1 },
    model: 'luna-fixture',
    thinking: 'low',
    context: { source: 'none' as const, revision: null },
    permission: { mode: 'agent' as const, revision: 0 as const },
  },
  payload: { text: 'Inspect' },
};
function setup(saved: string | null = null) {
  let raw: string | null = saved;
  channel.id = null;
  channel.send.mockReset();
  channel.cursors.clear();
  const fetch = vi.fn().mockImplementation((path: string) =>
    Promise.resolve(
      path === '/local/send'
        ? new Response(
            JSON.stringify({
              ok: true,
              clientMsgId: 'local-first',
              sessionId: 'owned-session',
              dispatched: true,
              state: 'consumed',
            }),
            { status: 202 },
          )
        : new Response('[]'),
    ),
  );
  const store = createMitzoStore({
    transport: { fetch },
    wsConfig: {
      buildUrl: () => '',
      createWebSocket: () => {
        throw Error('Unexpected WebSocket');
      },
    },
    sseConfig: { baseUrl: '', fetch },
    localFirstCommandConfig: {
      url: '/local/send',
      storage: {
        getItem: () => raw,
        setItem: (_: string, value: string) => {
          raw = value;
        },
      },
    },
  });
  return { store, fetch, readStorage: () => JSON.parse(raw ?? '[]') };
}
it('requires authenticated live SSE and then uses only exact dedicated POST with current connection identity', async () => {
  const { store, fetch } = setup();
  expect(store.getState().sendLocalFirstCommand(request)).toBe(false);
  expect(fetch).not.toHaveBeenCalledWith('/local/send', expect.anything());
  channel.id = 'live-operator-sse';
  const assigned = vi.fn();
  const delivered = vi.fn();
  expect(
    store
      .getState()
      .sendLocalFirstCommand(request, { onSessionAssigned: assigned, onDelivery: delivered }),
  ).toBe(true);
  await vi.waitFor(() => expect(assigned).toHaveBeenCalledWith('owned-session'));
  const call = fetch.mock.calls.find(([url]) => url === '/local/send')!;
  expect(JSON.parse(call[1].body)).toEqual(request);
  expect(call[1].headers['X-Connection-ID']).toBe('live-operator-sse');
  expect(delivered).toHaveBeenCalledWith('accepted');
  expect(store.getState().sessions.active).toBe('owned-session');
  expect(channel.send.mock.calls.some(([body]) => body.type === 'send')).toBe(false);
  expect(store.getState().sendLocalFirstCommand({ ...request, clientMsgId: 'followup' })).toBe(
    false,
  );
});
it('retains request after logout and never automatically retries on a new authenticated connection', async () => {
  const { store, fetch } = setup();
  channel.id = 'first-sse';
  fetch.mockRejectedValue(Error('lost'));
  store.getState().sendLocalFirstCommand(request);
  await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe('uncertain'));
  store.getState().invalidateAuthentication();
  channel.id = 'new-sse';
  store.getState().restoreAuthentication();
  expect(fetch.mock.calls.filter(([path]) => path === '/local/send')).toHaveLength(1);
  expect(store.getState().localCommand?.request).toEqual(request);
});
it('keeps delayed assignment with its originating draft after New and exposes recovery without adopting the new composer', async () => {
  const { store, fetch } = setup();
  channel.id = 'live-sse';
  let complete!: (response: Response) => void;
  fetch.mockImplementation((path) =>
    path === '/local/send'
      ? new Promise<Response>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(new Response('[]')),
  );
  const assigned = vi.fn();
  store
    .getState()
    .sendLocalFirstCommand(request, { draftId: 'original-draft', onSessionAssigned: assigned });
  store.getState().newSession();
  complete(
    new Response(
      JSON.stringify({
        ok: true,
        clientMsgId: request.clientMsgId,
        sessionId: 'original-session',
        dispatched: true,
        state: 'consumed',
      }),
      { status: 202 },
    ),
  );
  await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe('consumed'));
  expect(store.getState().sessions.active).toBeNull();
  expect(store.getState().localCommand?.originDraftId).toBe('original-draft');
  expect(store.getState().localCommand?.sessionId).toBe('original-session');
  expect(assigned).toHaveBeenCalledWith('original-session');
});

it.each(['consumed', 'uncertain', 'reserved'])(
  'retains a strict409 %s observation without assignment, then assigns only the exact202 recovery',
  async (state) => {
    const { store, fetch, readStorage } = setup();
    channel.id = 'live-sse';
    const assigned = vi.fn();
    const delivered = vi.fn();
    fetch.mockImplementation((path) =>
      Promise.resolve(
        path === '/local/send'
          ? new Response(
              JSON.stringify({
                ok: false,
                code: 'retained_command',
                error: 'Local Codex entry unavailable',
                clientMsgId: request.clientMsgId,
                sessionId: 'observed-session',
                state,
              }),
              { status: 409 },
            )
          : new Response('[]'),
      ),
    );
    expect(
      store.getState().sendLocalFirstCommand(request, {
        draftId: 'original-draft',
        onSessionAssigned: assigned,
        onDelivery: delivered,
      }),
    ).toBe(true);
    await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe('retained'));
    expect(store.getState().localCommand).toEqual({
      request,
      state: 'retained',
      sessionId: 'observed-session',
      originDraftId: 'original-draft',
    });
    expect(assigned).not.toHaveBeenCalled();
    expect(store.getState().sessions.active).toBeNull();
    expect(channel.send.mock.calls.some(([body]) => body.type === 'switch_session')).toBe(false);
    expect(delivered).not.toHaveBeenCalledWith('accepted');
    expect(readStorage()).toEqual([
      expect.objectContaining({
        body: request,
        localDraftId: 'original-draft',
        localReceipt: { sessionId: 'observed-session', state },
      }),
    ]);
    // A failed retry retains the observation's IDs but creates no new acknowledgement.
    fetch.mockRejectedValueOnce(Error('lost recovery response'));
    expect(store.getState().recoverLocalCommand()).toBe(true);
    await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe('uncertain'));
    expect(assigned).not.toHaveBeenCalled();
    expect(store.getState().sessions.active).toBeNull();
    expect(readStorage()[0].body).toEqual(request);
    fetch.mockImplementation((path) =>
      Promise.resolve(
        path === '/local/send'
          ? new Response(
              JSON.stringify({
                ok: true,
                clientMsgId: request.clientMsgId,
                sessionId: 'owned-session',
                dispatched: true,
                state: 'consumed',
              }),
              { status: 202 },
            )
          : new Response('[]'),
      ),
    );
    expect(store.getState().recoverLocalCommand()).toBe(true);
    await vi.waitFor(() => expect(assigned).toHaveBeenCalledWith('owned-session'));
    expect(assigned).toHaveBeenCalledTimes(1);
    expect(store.getState().sessions.active).toBe('owned-session');
    expect(store.getState().localCommand?.originDraftId).toBe('original-draft');
    expect(delivered).toHaveBeenCalledWith('accepted');
    expect(readStorage()).toEqual([]);
    expect(
      fetch.mock.calls
        .filter(([path]) => path === '/local/send')
        .map(([, init]) => JSON.parse(init.body)),
    ).toEqual([request, request, request]);
  },
);

it.each(['reserved', 'uncertain'])(
  'keeps validated202 %s assignment while retaining the exact command for recovery',
  async (state) => {
    const { store, fetch, readStorage } = setup();
    channel.id = 'live-sse';
    const assigned = vi.fn();
    const delivered = vi.fn();
    fetch.mockImplementation((path) =>
      Promise.resolve(
        path === '/local/send'
          ? new Response(
              JSON.stringify({
                ok: true,
                clientMsgId: request.clientMsgId,
                sessionId: 'owned-session',
                dispatched: false,
                state,
              }),
              { status: 202 },
            )
          : new Response('[]'),
      ),
    );
    expect(
      store.getState().sendLocalFirstCommand(request, {
        draftId: 'original-draft',
        onSessionAssigned: assigned,
        onDelivery: delivered,
      }),
    ).toBe(true);
    await vi.waitFor(() => expect(assigned).toHaveBeenCalledWith('owned-session'));
    expect(store.getState().sessions.active).toBe('owned-session');
    expect(delivered).toHaveBeenCalledWith('uncertain');
    expect(delivered).not.toHaveBeenCalledWith('accepted');
    expect(readStorage()[0]).toMatchObject({ body: request, localDraftId: 'original-draft' });
  },
);

it.each([true, false])(
  'keeps Local draft unassigned through early SSE (correlated=%s) and retained409 until exact202 recovery',
  async (correlated) => {
    const { store, fetch, readStorage } = setup();
    channel.id = 'live-sse';
    let complete!: (response: Response) => void;
    fetch.mockImplementation((path) =>
      path === '/local/send'
        ? new Promise<Response>((resolve) => {
            complete = resolve;
          })
        : Promise.resolve(new Response('[]')),
    );
    const assigned = vi.fn();
    const delivered = vi.fn();
    expect(
      store.getState().sendLocalFirstCommand(request, {
        draftId: 'original-draft',
        onSessionAssigned: assigned,
        onDelivery: delivered,
      }),
    ).toBe(true);
    channel.listener({
      type: 'session_id',
      sessionId: 'owned-session',
      ...(correlated ? { clientMsgId: request.clientMsgId } : {}),
    });
    channel.listener({
      type: 'user_message',
      sessionId: 'owned-session',
      messageId: request.clientMsgId,
      text: request.payload.text,
    });
    expect(assigned).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalledWith('accepted');
    expect(store.getState().sessions.active).toBeNull();
    expect(readStorage()[0]).toMatchObject({ body: request, localDraftId: 'original-draft' });
    complete(
      new Response(
        JSON.stringify({
          ok: false,
          code: 'retained_command',
          error: 'Local Codex entry unavailable',
          clientMsgId: request.clientMsgId,
          sessionId: 'owned-session',
          state: 'uncertain',
        }),
        { status: 409 },
      ),
    );
    await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe('retained'));
    expect(assigned).not.toHaveBeenCalled();
    expect(delivered).toHaveBeenCalledWith('uncertain');
    expect(delivered).not.toHaveBeenCalledWith('accepted');
    expect(store.getState().sessions.active).toBeNull();
    expect(store.getState().localCommand?.originDraftId).toBe('original-draft');
    expect(store.getState().messages.messages).toEqual([
      expect.objectContaining({ messageId: request.clientMsgId, role: 'user' }),
    ]);
    expect(store.getState().recoverLocalCommand()).toBe(true);
    complete(
      new Response(
        JSON.stringify({
          ok: true,
          clientMsgId: request.clientMsgId,
          sessionId: 'owned-session',
          dispatched: true,
          state: 'consumed',
        }),
        { status: 202 },
      ),
    );
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith('accepted'));
    expect(assigned).toHaveBeenCalledExactlyOnceWith('owned-session');
    expect(delivered.mock.calls.filter(([state]) => state === 'accepted')).toHaveLength(1);
    expect(store.getState().sessions.active).toBe('owned-session');
    expect(readStorage()).toEqual([]);
    expect(
      fetch.mock.calls
        .filter(([path]) => path === '/local/send')
        .map(([, init]) => JSON.parse(init.body)),
    ).toEqual([request, request]);
    expect(channel.send.mock.calls.some(([body]) => body.type === 'send')).toBe(false);
  },
);

it('keeps validated202 uncertain delivery recoverable despite its persisted SSE echo', async () => {
  const { store, fetch, readStorage } = setup();
  channel.id = 'live-sse';
  fetch.mockImplementation((path) =>
    Promise.resolve(
      path === '/local/send'
        ? new Response(
            JSON.stringify({
              ok: true,
              clientMsgId: request.clientMsgId,
              sessionId: 'owned-session',
              dispatched: false,
              state: 'uncertain',
            }),
            { status: 202 },
          )
        : new Response('[]'),
    ),
  );
  const assigned = vi.fn();
  const delivered = vi.fn();
  store
    .getState()
    .sendLocalFirstCommand(request, { onSessionAssigned: assigned, onDelivery: delivered });
  await vi.waitFor(() => expect(assigned).toHaveBeenCalledWith('owned-session'));
  channel.listener({
    type: 'session_id',
    sessionId: 'owned-session',
    clientMsgId: request.clientMsgId,
  });
  channel.listener({
    type: 'user_message',
    sessionId: 'owned-session',
    messageId: request.clientMsgId,
    text: request.payload.text,
  });
  expect(assigned).toHaveBeenCalledTimes(1);
  expect(delivered).toHaveBeenCalledWith('uncertain');
  expect(delivered).not.toHaveBeenCalledWith('accepted');
  expect(readStorage()[0].body).toEqual(request);
  expect(store.getState().localCommand?.state).toBe('uncertain');
});

it('hydrates fast successful output after the validated202 without accepting its earlier SSE echo', async () => {
  const { store, fetch } = setup();
  channel.id = 'live-sse';
  let complete!: (response: Response) => void;
  const output = {
    messageId: 'fast-answer',
    role: 'assistant',
    blocks: [{ blockId: 'answer-text', blockType: 'text', content: 'Finished before HTTP.' }],
    timestamp: 2,
  };
  fetch.mockImplementation((path) =>
    path === '/local/send'
      ? new Promise<Response>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(
          path === '/api/sessions/owned-session/messages?transcript=1'
            ? new Response(JSON.stringify({ messages: [output], current: null, cursor: 5 }))
            : new Response('[]'),
        ),
  );
  // The existing switch handler emits current durable state even after completion.
  channel.send.mockImplementation((body) => {
    if (body.type === 'switch_session')
      channel.listener({ type: 'session_state_changed', sessionId: body.sessionId, state: 'idle' });
    return true;
  });
  const assigned = vi.fn();
  const delivered = vi.fn();
  store
    .getState()
    .sendLocalFirstCommand(request, { onSessionAssigned: assigned, onDelivery: delivered });
  channel.listener({
    type: 'session_id',
    sessionId: 'owned-session',
    clientMsgId: request.clientMsgId,
  });
  channel.listener({
    type: 'user_message',
    sessionId: 'owned-session',
    messageId: request.clientMsgId,
    text: request.payload.text,
  });
  channel.listener({
    type: 'message_end',
    sessionId: 'owned-session',
    messageId: output.messageId,
  });
  expect(
    channel.listener({ type: 'session_state_changed', sessionId: 'owned-session', state: 'idle' }),
  ).toBe(true);
  expect(delivered).not.toHaveBeenCalledWith('accepted');
  expect(assigned).not.toHaveBeenCalled();
  complete(
    new Response(
      JSON.stringify({
        ok: true,
        clientMsgId: request.clientMsgId,
        sessionId: 'owned-session',
        dispatched: true,
        state: 'consumed',
      }),
      { status: 202 },
    ),
  );
  await vi.waitFor(() => expect(store.getState().messages.messages).toContainEqual(output));
  expect(store.getState().messages.running).toBe(false);
  expect(assigned).toHaveBeenCalledExactlyOnceWith('owned-session');
  expect(delivered.mock.calls.filter(([state]) => state === 'accepted')).toHaveLength(1);
  expect(channel.send).toHaveBeenCalledWith({
    type: 'switch_session',
    sessionId: 'owned-session',
    historyCursor: 5,
  });
});

it('preserves generic uncorrelated assignment and echo acceptance without a pending Local launch', () => {
  const { store } = setup();
  channel.id = 'live-sse';
  channel.send.mockReturnValue(true);
  const assigned = vi.fn();
  const delivered = vi.fn();
  store
    .getState()
    .sendMessage('Ordinary draft', { onSessionAssigned: assigned, onDelivery: delivered });
  const send = channel.send.mock.calls.find(([body]) => body.type === 'send')![0];
  channel.listener({ type: 'session_id', sessionId: 'ordinary-session' });
  channel.listener({
    type: 'user_message',
    sessionId: 'ordinary-session',
    messageId: send.clientMsgId,
    text: 'Ordinary draft',
  });
  expect(assigned).toHaveBeenCalledExactlyOnceWith('ordinary-session');
  expect(delivered).toHaveBeenCalledExactlyOnceWith('accepted');
  expect(store.getState().sessions.active).toBe('ordinary-session');
});

it('does not import late receipt-driven history into a newer conversation draft', async () => {
  const { store, fetch } = setup();
  channel.id = 'live-sse';
  let restore!: (response: Response) => void;
  fetch.mockImplementation((path) =>
    path === '/api/sessions/owned-session/messages?transcript=1'
      ? new Promise<Response>((resolve) => {
          restore = resolve;
        })
      : Promise.resolve(
          path === '/local/send'
            ? new Response(
                JSON.stringify({
                  ok: true,
                  clientMsgId: request.clientMsgId,
                  sessionId: 'owned-session',
                  dispatched: true,
                  state: 'consumed',
                }),
                { status: 202 },
              )
            : new Response('[]'),
        ),
  );
  const assigned = vi.fn();
  store
    .getState()
    .sendLocalFirstCommand(request, { draftId: 'original-draft', onSessionAssigned: assigned });
  await vi.waitFor(() => expect(restore).toBeDefined());
  store.getState().newSession();
  restore(
    new Response(
      JSON.stringify({
        messages: [{ messageId: 'late-answer', role: 'assistant', blocks: [], timestamp: 2 }],
        current: null,
        cursor: 5,
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(store.getState().sessions.active).toBeNull();
  expect(store.getState().messages.messages).toEqual([]);
  expect(channel.cursors.has('owned-session')).toBe(false);
  expect(assigned).toHaveBeenCalledExactlyOnceWith('owned-session');
  expect(store.getState().localCommand?.originDraftId).toBe('original-draft');
});

it('does not let an offscreen pending Local launch block a newer ordinary uncorrelated assignment', async () => {
  const { store, fetch } = setup();
  channel.id = 'live-sse';
  fetch.mockRejectedValueOnce(Error('Local response lost'));
  store.getState().sendLocalFirstCommand(request);
  await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe('uncertain'));
  store.getState().newSession();
  channel.send.mockReturnValue(true);
  const assigned = vi.fn();
  const delivered = vi.fn();
  store
    .getState()
    .sendMessage('New ordinary draft', { onSessionAssigned: assigned, onDelivery: delivered });
  const send = channel.send.mock.calls.find(([body]) => body.type === 'send')![0];
  channel.listener({ type: 'session_id', sessionId: 'new-ordinary' });
  channel.listener({
    type: 'user_message',
    sessionId: 'new-ordinary',
    messageId: send.clientMsgId,
    text: 'New ordinary draft',
  });
  expect(assigned).toHaveBeenCalledExactlyOnceWith('new-ordinary');
  expect(delivered).toHaveBeenCalledExactlyOnceWith('accepted');
  expect(store.getState().sessions.active).toBe('new-ordinary');
  expect(store.getState().localCommand?.request).toEqual(request);
});

it('keeps cold restored Local observation unassigned when uncorrelated SSE arrives before recovery202', () => {
  const { store, fetch } = setup(
    JSON.stringify([
      {
        body: request,
        scope: 1,
        uncertain: true,
        localDraftId: 'original-draft',
        localReceipt: { sessionId: 'old-local', state: 'uncertain' },
      },
    ]),
  );
  channel.id = 'live-sse';
  channel.listener({ type: 'session_id', sessionId: 'old-local' });
  channel.listener({
    type: 'user_message',
    sessionId: 'old-local',
    messageId: request.clientMsgId,
    text: request.payload.text,
  });
  expect(store.getState().sessions.active).toBeNull();
  expect(store.getState().localCommand?.state).toBe('uncertain');
  expect(fetch.mock.calls.some(([path]) => path === '/local/send')).toBe(false);
});

it.each(['session_id', 'user_message'])(
  'defers the exact Local %s stream after stale uncorrelated observations until validated202 recovery',
  async (correlatedType) => {
    const { store, fetch, readStorage } = setup();
    channel.id = 'live-sse';
    let complete!: (response: Response) => void;
    const output = {
      messageId: 'fast-recovered-answer',
      role: 'assistant',
      blocks: [{ blockId: 'answer-text', blockType: 'text', content: 'Completed before receipt.' }],
      timestamp: 2,
    };
    fetch.mockImplementation((path) =>
      path === '/local/send'
        ? new Promise<Response>((resolve) => {
            complete = resolve;
          })
        : Promise.resolve(
            path === '/api/sessions/actual-local/messages?transcript=1'
              ? new Response(JSON.stringify({ messages: [output], current: null, cursor: 7 }))
              : new Response('[]'),
          ),
    );
    const assigned = vi.fn();
    const delivered = vi.fn();
    store.getState().sendLocalFirstCommand(request, {
      draftId: 'original-draft',
      onSessionAssigned: assigned,
      onDelivery: delivered,
    });
    expect(channel.listener({ type: 'session_id', sessionId: 'stale-old-session' })).toBe(true);
    expect(
      channel.listener(
        correlatedType === 'session_id'
          ? { type: correlatedType, sessionId: 'actual-local', clientMsgId: request.clientMsgId }
          : {
              type: correlatedType,
              sessionId: 'actual-local',
              messageId: request.clientMsgId,
              text: request.payload.text,
            },
      ),
    ).toBe(true);
    // A later uncorrelated ID must not displace the exact command observation.
    expect(channel.listener({ type: 'session_id', sessionId: 'later-unrelated-session' })).toBe(
      true,
    );
    expect(
      channel.listener({
        type: 'message_start',
        sessionId: 'actual-local',
        messageId: output.messageId,
      }),
    ).toBe(true);
    expect(
      channel.listener({
        type: 'message_end',
        sessionId: 'actual-local',
        messageId: output.messageId,
      }),
    ).toBe(true);
    expect(
      channel.listener({ type: 'session_state_changed', sessionId: 'actual-local', state: 'idle' }),
    ).toBe(true);
    expect(assigned).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalledWith('accepted');
    expect(store.getState().sessions.active).toBeNull();
    complete(
      new Response(
        JSON.stringify({
          ok: false,
          code: 'retained_command',
          error: 'Local Codex entry unavailable',
          clientMsgId: request.clientMsgId,
          sessionId: 'actual-local',
          state: 'uncertain',
        }),
        { status: 409 },
      ),
    );
    await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe('retained'));
    expect(assigned).not.toHaveBeenCalled();
    expect(store.getState().recoverLocalCommand()).toBe(true);
    complete(
      new Response(
        JSON.stringify({
          ok: true,
          clientMsgId: request.clientMsgId,
          sessionId: 'actual-local',
          dispatched: true,
          state: 'consumed',
        }),
        { status: 202 },
      ),
    );
    await vi.waitFor(() => expect(store.getState().messages.messages).toContainEqual(output));
    expect(assigned).toHaveBeenCalledExactlyOnceWith('actual-local');
    expect(delivered.mock.calls.filter(([state]) => state === 'accepted')).toHaveLength(1);
    expect(store.getState().sessions.active).toBe('actual-local');
    expect(readStorage()).toEqual([]);
    expect(channel.send).toHaveBeenCalledWith({
      type: 'switch_session',
      sessionId: 'actual-local',
      historyCursor: 7,
    });
    expect(
      fetch.mock.calls.some(
        ([path]) =>
          path.includes('/stale-old-session/') || path.includes('/later-unrelated-session/'),
      ),
    ).toBe(false);
    expect(
      fetch.mock.calls
        .filter(([path]) => path === '/local/send')
        .map(([, init]) => JSON.parse(init.body)),
    ).toEqual([request, request]);
  },
);

it.each(['session_id', 'user_message'])(
  'shows retained Local live events after explicit switchSession without adopting the early %s draft',
  async (earlyType) => {
    const { store, fetch, readStorage } = setup();
    channel.id = 'live-sse';
    channel.send.mockReturnValue(true);
    let complete!: (response: Response) => void;
    fetch.mockImplementation((path) =>
      path === '/local/send'
        ? new Promise<Response>((resolve) => {
            complete = resolve;
          })
        : Promise.resolve(
            path === '/api/sessions/retained-local/messages?transcript=1'
              ? new Response(JSON.stringify({ messages: [], current: null, cursor: 0 }))
              : new Response('[]'),
          ),
    );
    const assigned = vi.fn();
    const delivered = vi.fn();
    store.getState().sendLocalFirstCommand(request, {
      draftId: 'original-draft',
      onSessionAssigned: assigned,
      onDelivery: delivered,
    });
    channel.listener(
      earlyType === 'session_id'
        ? { type: earlyType, sessionId: 'retained-local', clientMsgId: request.clientMsgId }
        : {
            type: earlyType,
            sessionId: 'retained-local',
            messageId: request.clientMsgId,
            text: request.payload.text,
          },
    );
    complete(
      new Response(
        JSON.stringify({
          ok: false,
          code: 'retained_command',
          error: 'Local Codex entry unavailable',
          clientMsgId: request.clientMsgId,
          sessionId: 'retained-local',
          state: 'uncertain',
        }),
        { status: 409 },
      ),
    );
    await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe('retained'));
    expect(store.getState().sessions.active).toBeNull();
    await store.getState().switchSession('retained-local');
    expect(store.getState().sessions.active).toBe('retained-local');
    // Selecting the view must not assign its retained originating composer.
    channel.listener({
      type: 'session_id',
      sessionId: 'retained-local',
      clientMsgId: request.clientMsgId,
    });
    channel.listener({
      type: 'user_message',
      sessionId: 'retained-local',
      messageId: request.clientMsgId,
      text: request.payload.text,
    });
    channel.listener({
      type: 'session_state_changed',
      sessionId: 'retained-local',
      state: 'running',
    });
    channel.listener({
      type: 'message_start',
      sessionId: 'retained-local',
      messageId: 'live-answer',
    });
    channel.listener({
      type: 'block_start',
      sessionId: 'retained-local',
      messageId: 'live-answer',
      blockId: 'live-text',
      blockType: 'text',
    });
    channel.listener({
      type: 'block_delta',
      sessionId: 'retained-local',
      messageId: 'live-answer',
      blockId: 'live-text',
      blockType: 'text',
      delta: 'Visible retained output.',
    });
    channel.listener({
      type: 'permission_request',
      sessionId: 'retained-local',
      permId: 'retained-permission',
      toolName: 'Bash',
      toolInput: 'fixture-only',
      tier: 'elevated',
    });
    expect(store.getState().messages.running).toBe(true);
    expect(store.getState().messages.current?.blocks.get('live-text')?.content).toBe(
      'Visible retained output.',
    );
    expect(store.getState().messages.permission?.permId).toBe('retained-permission');
    expect(store.getState().messages.messages).toContainEqual(
      expect.objectContaining({ messageId: request.clientMsgId, role: 'user' }),
    );
    store.getState().stopGeneration();
    expect(channel.send).toHaveBeenCalledWith({ type: 'stop', sessionId: 'retained-local' });
    expect(assigned).not.toHaveBeenCalled();
    expect(delivered).toHaveBeenCalledWith('uncertain');
    expect(delivered).not.toHaveBeenCalledWith('accepted');
    expect(store.getState().localCommand?.originDraftId).toBe('original-draft');
    expect(readStorage()[0].body).toEqual(request);
    channel.listener({
      type: 'block_end',
      sessionId: 'retained-local',
      messageId: 'live-answer',
      blockId: 'live-text',
      blockType: 'text',
    });
    channel.listener({
      type: 'message_end',
      sessionId: 'retained-local',
      messageId: 'live-answer',
    });
    channel.listener({ type: 'session_state_changed', sessionId: 'retained-local', state: 'idle' });
    expect(store.getState().messages.running).toBe(false);
    expect(store.getState().messages.messages).toContainEqual(
      expect.objectContaining({
        messageId: 'live-answer',
        blocks: [expect.objectContaining({ content: 'Visible retained output.' })],
      }),
    );
    expect(store.getState().recoverLocalCommand()).toBe(true);
    complete(
      new Response(
        JSON.stringify({
          ok: true,
          clientMsgId: request.clientMsgId,
          sessionId: 'retained-local',
          dispatched: true,
          state: 'consumed',
        }),
        { status: 202 },
      ),
    );
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith('accepted'));
    expect(assigned).toHaveBeenCalledExactlyOnceWith('retained-local');
    expect(delivered.mock.calls.filter(([state]) => state === 'accepted')).toHaveLength(1);
    expect(readStorage()).toEqual([]);
    expect(store.getState().sessions.active).toBe('retained-local');
  },
);

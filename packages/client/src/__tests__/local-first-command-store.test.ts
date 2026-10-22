import { expect, it, vi } from 'vitest';
import { createMitzoStore } from '../store.js';
const channel = vi.hoisted(() => ({
  listener: (_event: Record<string, unknown>) => {},
  id: null as string | null,
  send: vi.fn(),
  cursors: new Map<string, number>(),
  acknowledgeSnapshot: vi.fn(),
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
    acknowledgeReconnectSnapshot(sessionId: string, cursor: number, offerId?: string) {
      channel.cursors.set(sessionId, cursor);
      channel.acknowledgeSnapshot(sessionId, cursor, offerId);
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
function setup(
  saved: string | null = null,
  sendHandoff?: import('../store.js').MitzoStoreOptions['sendHandoff'],
) {
  let raw: string | null = saved;
  channel.id = null;
  channel.send.mockReset();
  channel.cursors.clear();
  channel.acknowledgeSnapshot.mockReset();
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
    sendHandoff,
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
it.each([false, true])(
  'admits a genuinely new first send after New Chat when an older local attempt exists: %s',
  async (hasOlderAttempt) => {
    const saved = hasOlderAttempt
      ? JSON.stringify([
          {
            body: request,
            scope: 1,
            uncertain: true,
            localDraftId: 'older-draft',
          },
        ])
      : null;
    const { store, fetch, readStorage } = setup(saved);
    channel.id = 'fresh-local-sse';
    fetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url !== '/local/send') return Promise.resolve(new Response('[]'));
      const body = JSON.parse(String(init?.body));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            clientMsgId: body.clientMsgId,
            sessionId: 'fresh-session',
            dispatched: true,
            state: 'consumed',
          }),
          { status: 202 },
        ),
      );
    });
    store.getState().newSession();
    const fresh = {
      ...request,
      clientMsgId: 'fresh-first',
      payload: { text: 'A genuinely new initial message' },
    };
    expect(store.getState().sendLocalFirstCommand(fresh, { draftId: 'fresh-draft' })).toBe(true);
    await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe('consumed'));
    const sent = fetch.mock.calls.filter(([url]) => url === '/local/send');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0][1].body)).toEqual(fresh);
    if (hasOlderAttempt)
      expect(readStorage()).toContainEqual(
        expect.objectContaining({
          body: request,
          localDraftId: 'older-draft',
          uncertain: true,
        }),
      );
  },
);

it.each([false, true])(
  'delivers a prepared repository first command independently of another retained draft: %s',
  async (hasOlderAttempt) => {
    const { store, fetch, readStorage } = setup(
      hasOlderAttempt
        ? JSON.stringify([
            {
              body: { ...request, clientMsgId: 'older-first' },
              scope: 1,
              uncertain: true,
              localDraftId: 'older-draft',
            },
          ])
        : null,
    );
    channel.id = 'prepared-sse';
    await store.getState().switchSession('owned-session');
    channel.send.mockClear();
    const assigned = vi.fn();
    expect(store.getState().sendLocalFirstCommand(request)).toBe(false);
    expect(store.getState().sendPreparedRepositoryCommand(request, 'another-session')).toBe(false);
    expect(
      store
        .getState()
        .sendPreparedRepositoryCommand(request, 'owned-session', { onSessionAssigned: assigned }),
    ).toBe(true);
    await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe('consumed'));
    expect(JSON.parse(fetch.mock.calls.find(([url]) => url === '/local/send')![1].body)).toEqual(
      request,
    );
    expect(store.getState().sessions.active).toBe('owned-session');
    expect(assigned).not.toHaveBeenCalled();
    expect(channel.send.mock.calls.some(([body]) => body.type === 'switch_session')).toBe(false);
    expect(readStorage()).toHaveLength(hasOlderAttempt ? 1 : 0);
  },
);
it.each(['first', 'continue'] as const)(
  'delivers ordinary %s without a draft id behind a different retained conversation',
  async (phase) => {
    const { store, fetch, readStorage } = setup(
      JSON.stringify([
        {
          body: { ...request, clientMsgId: 'older-first' },
          scope: 1,
          uncertain: true,
          ordinaryDelivery: { version: 1, phase: 'first', sessionId: 'older-session' },
        },
      ]),
    );
    channel.id = 'ordinary-sse';
    await store.getState().switchSession('owned-session');
    const { repositoryWorkspaceId, ...body } = request;
    const ordinary = {
      ...body,
      version: 2 as const,
      sessionId: 'owned-session',
      workspace: { kind: 'ordinary' as const, workspaceId: repositoryWorkspaceId },
    };
    fetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/commands/')
          ? new Response(
              JSON.stringify({
                ok: true,
                clientMsgId: ordinary.clientMsgId,
                sessionId: ordinary.sessionId,
                dispatched: true,
                state: 'consumed',
              }),
              { status: 202 },
            )
          : new Response('[]'),
      ),
    );
    expect(store.getState().sendOrdinaryWorkspaceCommand(ordinary, phase)).toBe(true);
    await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe('consumed'));
    expect(readStorage()).toHaveLength(1);
    expect(readStorage()[0].body.clientMsgId).toBe('older-first');
    expect(fetch.mock.calls.filter(([url]) => url.includes('/commands/'))).toHaveLength(1);
  },
);

it('binds exact initial Library sources to the durable command owner before admission and acknowledges assignment', async () => {
  const source = {
    kind: 'agent-library' as const,
    revision: 'a'.repeat(64),
    content: JSON.stringify({
      version: 1,
      source: {
        kind: 'draft',
        profileId: 'agent',
        baseRevision: 0,
        draftVersion: null,
        expectedVersion: 0,
      },
      definition: {
        name: '',
        role: 'agent',
        instructions: '',
        expectedOutput: '',
        acceptanceCriteria: [],
        modelPolicyRole: 'agent',
      },
    }),
  };
  const handoff = { prepare: vi.fn(() => true), assign: vi.fn(), reject: vi.fn() };
  const { store, fetch } = setup(null, handoff);
  channel.id = 'live-sse';
  const command = { ...request, payload: { ...request.payload, sourceSnapshots: [source] } };
  expect(store.getState().sendLocalFirstCommand(command)).toBe(true);
  expect(handoff.prepare).toHaveBeenCalledWith(command);
  await vi.waitFor(() =>
    expect(handoff.assign).toHaveBeenCalledWith(command.clientMsgId, 'owned-session', {
      kind: 'agent-library',
      revision: source.revision,
    }),
  );
  expect(JSON.parse(fetch.mock.calls.find(([path]) => path === '/local/send')![1].body)).toEqual(
    command,
  );
  expect(store.getState().messages.messages[0].sourceSnapshots).toEqual([source]);
});
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
it.each(['retained', 'lost-response'])(
  'ends only unassigned optimistic busy state when a Local send is %s, preserving its draft and exact recovery',
  async (failure) => {
    const { store, fetch, readStorage } = setup();
    channel.id = 'live-sse';
    const assigned = vi.fn();
    const delivered = vi.fn();
    fetch.mockImplementation(async () => {
      if (failure === 'lost-response') throw Error('Offline transport failure');
      return Response.json(
        {
          ok: false,
          code: 'retained_command',
          error: 'Local Codex entry unavailable',
          clientMsgId: request.clientMsgId,
          sessionId: 'retained-session',
          state: 'uncertain',
        },
        { status: 409 },
      );
    });
    expect(
      store.getState().sendLocalFirstCommand(request, {
        draftId: 'original-draft',
        onSessionAssigned: assigned,
        onDelivery: delivered,
      }),
    ).toBe(true);
    expect(store.getState().messages.running).toBe(true);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith('uncertain'));
    expect(store.getState().messages.running).toBe(false);
    expect(store.getState().messages.messages).toEqual([
      expect.objectContaining({ messageId: request.clientMsgId, role: 'user' }),
    ]);
    expect(store.getState().sessions.active).toBeNull();
    expect(assigned).not.toHaveBeenCalled();
    expect(readStorage()[0]).toMatchObject({ body: request, localDraftId: 'original-draft' });
    expect(store.getState().sendLocalFirstCommand({ ...request, clientMsgId: 'replacement' })).toBe(
      false,
    );
    expect(fetch).toHaveBeenCalledOnce();
  },
);
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

it('admits same-session continuation through its frozen outbox without assigning another launch', async () => {
  const { store, fetch } = setup();
  channel.id = 'live-sse';
  expect(store.getState().sendLocalFirstCommand(request)).toBe(true);
  await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe('consumed'));
  const continuation = {
    ...structuredClone(request),
    clientMsgId: 'second-command',
    sessionId: 'owned-session',
  };
  continuation.selection.thinking = 'high';
  fetch.mockImplementation(async (path) =>
    path === '/local/continue'
      ? new Response(
          JSON.stringify({
            ok: true,
            clientMsgId: continuation.clientMsgId,
            sessionId: continuation.sessionId,
            dispatched: true,
            state: 'consumed',
          }),
          { status: 202 },
        )
      : new Response('[]'),
  );
  const delivered = vi.fn();
  const assigned = vi.fn();
  expect(store.getState().sendLocalFirstCommand({ ...continuation, sessionId: 'foreign' })).toBe(
    false,
  );
  expect(
    store
      .getState()
      .sendLocalFirstCommand(continuation, { onDelivery: delivered, onSessionAssigned: assigned }),
  ).toBe(true);
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith('accepted'));
  expect(assigned).not.toHaveBeenCalled();
  expect(store.getState().sessions.active).toBe('owned-session');
  const call = fetch.mock.calls.find(([url]) => url === '/local/continue')!;
  expect(JSON.parse(call[1].body)).toEqual(continuation);
  expect(channel.send.mock.calls.some(([body]) => body.type === 'send')).toBe(false);
});

it('shows preparation after durable ordinary acceptance and clears it only for the selected response', () => {
  const { store } = setup();
  channel.listener({ type: 'session_id', sessionId: 'ordinary-session' });
  channel.listener({
    type: 'user_message',
    sessionId: 'ordinary-session',
    messageId: 'ordinary-prompt',
    text: 'Hello',
  });
  channel.listener({
    type: '_send_accepted',
    originalSessionId: null,
    sessionId: 'ordinary-session',
    clientMsgId: 'ordinary-prompt',
    retained: true,
  });
  expect(store.getState().sendStatus).toBe('Preparing response…');
  channel.listener({ type: 'message_start', sessionId: 'other-session', messageId: 'foreign' });
  expect(store.getState().sendStatus).toBe('Preparing response…');
  channel.listener({ type: 'message_start', sessionId: 'ordinary-session', messageId: 'answer' });
  expect(store.getState().sendStatus).toBeNull();
});

it('does not restore a preparation banner when response output beats its HTTP receipt', () => {
  const { store } = setup();
  channel.listener({ type: 'session_id', sessionId: 'fast-session' });
  channel.listener({
    type: 'user_message',
    sessionId: 'fast-session',
    seq: 1,
    messageId: 'fast-prompt',
    text: 'Hello',
  });
  channel.listener({
    type: 'message_start',
    sessionId: 'fast-session',
    seq: 2,
    messageId: 'fast-answer',
  });
  channel.listener({
    type: '_send_accepted',
    originalSessionId: null,
    sessionId: 'fast-session',
    clientMsgId: 'fast-prompt',
    retained: true,
  });
  expect(store.getState().sendStatus).toBeNull();
});

it.each(['initial', 'retry'])(
  'keeps preparation ended when session_end beats its %s retained receipt without output',
  (receipt) => {
    const { store } = setup();
    channel.send.mockReturnValue(true);
    if (receipt === 'retry') channel.listener({ type: 'session_id', sessionId: 'stopped-session' });
    store.getState().sendMessage('Stop before output');
    const command = channel.send.mock.calls.find(([body]) => body.type === 'send')![0];
    if (receipt === 'initial')
      channel.listener({
        type: 'session_id',
        sessionId: 'stopped-session',
        clientMsgId: command.clientMsgId,
      });
    channel.listener({
      type: 'user_message',
      sessionId: 'stopped-session',
      messageId: command.clientMsgId,
      text: command.prompt,
      seq: 1,
    });
    if (receipt === 'retry') {
      channel.listener({
        type: '_send_uncertain',
        sessionId: 'stopped-session',
        clientMsgId: command.clientMsgId,
        error: 'Acknowledgement not received',
      });
      expect(store.getState().sendError).toBe('Acknowledgement not received');
    }
    channel.listener({ type: 'session_end', sessionId: 'stopped-session', seq: 2 });
    expect(store.getState().messages.running).toBe(false);
    if (receipt === 'retry') {
      channel.listener({
        type: '_send_pending',
        sessionId: 'stopped-session',
        clientMsgId: command.clientMsgId,
        retrying: true,
      });
      expect(store.getState().sendStatus).toContain('Reconnecting');
    }
    channel.listener({
      type: '_send_accepted',
      sessionId: 'stopped-session',
      clientMsgId: command.clientMsgId,
      retained: true,
    });
    expect(store.getState().sendStatus).toBeNull();
    expect(store.getState().sendError).toBeNull();
    expect(store.getState().messages.messages.map((message) => message.messageId)).toEqual([
      command.clientMsgId,
    ]);
    expect(channel.send.mock.calls.filter(([body]) => body.type === 'send')).toEqual([[command]]);
  },
);

it('preserves preparation for a fresh command in the ended session despite old and foreign receipts', () => {
  const { store } = setup();
  channel.send.mockReturnValue(true);
  channel.listener({ type: 'session_id', sessionId: 'reused-session' });
  store.getState().sendMessage('First command');
  const first = channel.send.mock.calls.find(([body]) => body.type === 'send')![0];
  channel.listener({
    type: 'user_message',
    sessionId: 'reused-session',
    messageId: first.clientMsgId,
    text: first.prompt,
    seq: 1,
  });
  channel.listener({ type: 'session_end', sessionId: 'reused-session', seq: 2 });
  store.getState().sendMessage('New live command');
  const second = channel.send.mock.calls.filter(([body]) => body.type === 'send')[1][0];
  channel.listener({
    type: 'user_message',
    sessionId: 'reused-session',
    messageId: second.clientMsgId,
    text: second.prompt,
    seq: 3,
  });
  channel.listener({ type: 'session_end', sessionId: 'foreign-session', seq: 4 });
  channel.listener({
    type: '_send_accepted',
    sessionId: 'reused-session',
    clientMsgId: second.clientMsgId,
    retained: true,
  });
  expect(store.getState().sendStatus).toBe('Preparing response…');
  channel.listener({
    type: '_send_accepted',
    sessionId: 'reused-session',
    clientMsgId: first.clientMsgId,
    retained: true,
  });
  expect(store.getState().sendStatus).toBe('Preparing response…');
  channel.listener({
    type: '_send_uncertain',
    sessionId: 'reused-session',
    clientMsgId: second.clientMsgId,
    error: 'New command acknowledgement not received',
  });
  channel.listener({
    type: '_send_accepted',
    sessionId: 'reused-session',
    clientMsgId: first.clientMsgId,
    retained: true,
  });
  expect(store.getState().sendError).toBe('New command acknowledgement not received');
  channel.listener({
    type: '_send_accepted',
    sessionId: 'reused-session',
    clientMsgId: second.clientMsgId,
    retained: true,
  });
  expect(store.getState().sendStatus).toBe('Preparing response…');
  expect(store.getState().sendError).toBeNull();
  channel.listener({ type: 'session_end', sessionId: 'reused-session', seq: 4 });
  channel.listener({
    type: '_send_accepted',
    sessionId: 'reused-session',
    clientMsgId: second.clientMsgId,
    retained: true,
  });
  expect(store.getState().sendStatus).toBeNull();
});

it('clears preparation progress when a newer assistant snapshot arrives after reconnect', () => {
  const { store } = setup();
  channel.listener({ type: 'session_id', sessionId: 'snapshot-chat' });
  channel.listener({
    type: 'user_message',
    sessionId: 'snapshot-chat',
    seq: 1,
    messageId: 'snapshot-prompt',
    text: 'Synthetic request',
  });
  channel.listener({
    type: '_send_accepted',
    sessionId: 'snapshot-chat',
    clientMsgId: 'snapshot-prompt',
    retained: true,
  });
  expect(store.getState().sendStatus).toBe('Preparing response…');
  channel.listener({
    type: 'message_snapshot',
    sessionId: 'other-chat',
    messageId: 'other-answer',
    startedSeq: 3,
    blocks: [],
  });
  expect(store.getState().sendStatus).toBe('Preparing response…');
  channel.listener({
    type: 'message_snapshot',
    sessionId: 'snapshot-chat',
    messageId: 'old-answer',
    startedSeq: 0,
    blocks: [],
  });
  expect(store.getState().sendStatus).toBe('Preparing response…');
  channel.listener({
    type: 'message_snapshot',
    sessionId: 'snapshot-chat',
    messageId: 'answer',
    startedSeq: 3,
    blocks: [],
  });
  expect(store.getState().sendStatus).toBeNull();
});

it.each(['preparing', 'streaming'] as const)(
  'keeps a newer command %s when an older retained command fails recovery',
  (phase) => {
    const { store } = setup();
    channel.send.mockReturnValue(true);
    const sessionId = 'late-command-error';
    channel.listener({ type: 'session_id', sessionId });
    const submit = (text: string, seq: number) => {
      store.getState().sendMessage(text, { onDelivery: () => {} });
      const command = channel.send.mock.calls.filter(([body]) => body.type === 'send').at(-1)![0];
      channel.listener({
        type: 'user_message',
        sessionId,
        messageId: command.clientMsgId,
        text,
        seq,
      });
      channel.listener({
        type: '_send_accepted',
        sessionId,
        clientMsgId: command.clientMsgId,
        retained: true,
      });
      return command;
    };
    const first = submit('First saved command', 1);
    const second = submit('Newer saved command', 2);
    if (phase === 'streaming') {
      channel.listener({ type: 'message_start', sessionId, seq: 3, messageId: 'newer-answer' });
      channel.listener({
        type: 'block_start',
        sessionId,
        seq: 4,
        blockId: 'newer-text',
        blockType: 'text',
      });
      channel.listener({
        type: 'block_delta',
        sessionId,
        seq: 5,
        blockId: 'newer-text',
        delta: 'Current answer',
      });
    }
    const current = store.getState().messages.current;
    const status = store.getState().sendStatus;
    expect(store.getState().messages.running).toBe(true);
    expect(status).toBe(phase === 'preparing' ? 'Preparing response…' : null);
    const failure = {
      type: 'error',
      sessionId,
      clientMsgId: first.clientMsgId,
      seq: phase === 'streaming' ? 6 : 3,
      prevSessionSeq: phase === 'streaming' ? 5 : 2,
      error: 'Message saved. Earlier recovery failed.',
    };
    // Returning true commits this durable sequence through the normal SSE
    // applied-delivery boundary instead of requesting a replay of the error.
    expect(channel.listener(failure)).toBe(true);
    expect(failure.type).toBe('error');
    expect(store.getState().messages.running).toBe(true);
    expect(store.getState().messages.current).toEqual(current);
    expect(store.getState().sendStatus).toBe(status);
    expect(store.getState().sendError).toBeNull();
    const transcript = store.getState().messages.messages;
    const errors = transcript.filter((message) =>
      message.blocks.some(
        (block) => block.blockType === 'text' && block.content.includes('Earlier recovery failed'),
      ),
    );
    expect(errors).toHaveLength(1);
    expect(
      transcript.findIndex((message) => message.messageId === errors[0].messageId),
    ).toBeLessThan(transcript.findIndex((message) => message.messageId === second.clientMsgId));
    // A delayed/retried B receipt must not treat A's error as B's answer.
    channel.listener({
      type: '_send_accepted',
      sessionId,
      clientMsgId: second.clientMsgId,
      retained: true,
    });
    expect(store.getState().sendStatus).toBe(status);
    expect(store.getState().messages.running).toBe(true);
    expect(store.getState().messages.current).toEqual(current);
  },
);

it('keeps the latest command recovery failure terminal and visible', () => {
  const { store } = setup();
  const sessionId = 'latest-command-error';
  channel.listener({ type: 'session_id', sessionId });
  channel.listener({
    type: 'user_message',
    sessionId,
    seq: 1,
    messageId: 'latest',
    text: 'Saved request',
  });
  channel.listener({ type: '_send_accepted', sessionId, clientMsgId: 'latest', retained: true });
  channel.listener({
    type: 'error',
    sessionId,
    seq: 2,
    clientMsgId: 'latest',
    error: 'Message saved. Current recovery failed.',
  });
  expect(store.getState().sendStatus).toBeNull();
  expect(store.getState().messages.running).toBe(false);
  expect(store.getState().messages.messages.at(-1)?.blocks).toContainEqual(
    expect.objectContaining({ content: '**Error:** Message saved. Current recovery failed.' }),
  );
});

it('keeps a newer tool pending after an older saved failure until its actual terminal event', () => {
  const { store } = setup();
  const sessionId = 'retained-error-tool-lifecycle';
  channel.send.mockReturnValue(true);
  channel.listener({ type: 'session_id', sessionId });
  const commands = ['Older request', 'Newer request'].map((text, index) => {
    store.getState().sendMessage(text, { onDelivery: () => {} });
    const command = channel.send.mock.calls.filter(([body]) => body.type === 'send').at(-1)![0];
    channel.listener({
      type: 'user_message',
      sessionId,
      seq: index + 1,
      messageId: command.clientMsgId,
      text,
    });
    channel.listener({
      type: '_send_accepted',
      sessionId,
      clientMsgId: command.clientMsgId,
      retained: true,
    });
    return command;
  });
  channel.listener({ type: 'message_start', sessionId, seq: 3, messageId: 'newer-answer' });
  channel.listener({
    type: 'block_start',
    sessionId,
    seq: 4,
    blockId: 'newer-tool',
    blockType: 'tool_use',
  });
  channel.listener({
    type: 'block_end',
    sessionId,
    seq: 5,
    blockId: 'newer-tool',
    blockType: 'tool_use',
    toolId: 'pending-call',
    toolName: 'TelosReadArtifact',
    input: '{}',
  });
  const current = store.getState().messages.current;
  expect(store.getState().messages.running).toBe(true);
  expect(current?.blocks.get('newer-tool')).toMatchObject({ blockType: 'tool_use' });
  channel.listener({
    v: 2,
    type: 'error',
    sessionId,
    seq: 6,
    prevSessionSeq: 5,
    clientMsgId: commands[0].clientMsgId,
    retainedCommandFailure: true,
    error: 'Message saved. Earlier recovery failed.',
  });
  expect(store.getState().messages.current).toEqual(current);
  expect(store.getState().messages.running).toBe(true);
  expect(store.getState().messages.current?.blocks.get('newer-tool')).not.toHaveProperty(
    'toolInterrupted',
  );
  expect(store.getState().messages.current?.blocks.get('newer-tool')?.toolResult).toBeUndefined();
  channel.listener({ type: 'session_end', sessionId, seq: 7, prevSessionSeq: 6 });
  const finished = store
    .getState()
    .messages.messages.find((message) => message.messageId === 'newer-answer');
  expect(finished?.blocks[0]).toMatchObject({ blockType: 'tool_use', toolInterrupted: true });
  expect(finished?.blocks[0].toolResult).toBeUndefined();
  expect(finished?.blocks[0].toolError).toBeUndefined();
  expect(store.getState().messages.running).toBe(false);
});

it('keeps an older command failure after its existing output and before the newer input', () => {
  const { store } = setup();
  const sessionId = 'command-error-groups';
  channel.listener({ type: 'session_id', sessionId });
  channel.listener({
    type: 'user_message',
    sessionId,
    seq: 1,
    messageId: 'older',
    text: 'Older input',
  });
  channel.listener({ type: 'message_start', sessionId, seq: 2, messageId: 'older-answer' });
  channel.listener({
    type: 'block_start',
    sessionId,
    seq: 3,
    blockId: 'older-text',
    blockType: 'text',
  });
  channel.listener({
    type: 'block_delta',
    sessionId,
    seq: 4,
    blockId: 'older-text',
    delta: 'Older output',
  });
  channel.listener({ type: 'message_end', sessionId, seq: 5, messageId: 'older-answer' });
  channel.listener({
    type: 'user_message',
    sessionId,
    seq: 6,
    messageId: 'newer',
    text: 'Newer input',
  });
  channel.listener({
    type: 'error',
    sessionId,
    seq: 7,
    clientMsgId: 'older',
    error: 'Older command failed.',
  });
  const transcript = store.getState().messages.messages;
  expect(transcript.map((message) => message.messageId)).toEqual([
    'older',
    'older-answer',
    expect.stringMatching(/^err-/),
    'newer',
  ]);
  expect(transcript[1].blocks).toContainEqual(expect.objectContaining({ content: 'Older output' }));
});

it.each(['older', 'current'] as const)(
  'deduplicates a live %s retained-command failure during valid-cursor history merge',
  async (position) => {
    const { store, fetch } = setup();
    const sessionId = `stable-retained-error-${position}`;
    const error = 'Message saved. Codex recovery could not finish.';
    channel.listener({ type: 'session_id', sessionId });
    channel.listener({
      type: 'user_message',
      sessionId,
      seq: 1,
      messageId: 'command-a',
      text: 'A',
    });
    if (position === 'older') {
      channel.listener({
        type: 'user_message',
        sessionId,
        seq: 2,
        messageId: 'command-b',
        text: 'B',
      });
      channel.listener({
        type: '_send_accepted',
        sessionId,
        clientMsgId: 'command-b',
        retained: true,
      });
    }
    const seq = position === 'older' ? 3 : 2;
    expect(
      channel.listener({
        v: 2,
        type: 'error',
        sessionId,
        seq,
        prevSessionSeq: seq - 1,
        clientMsgId: 'command-a',
        retainedCommandFailure: true,
        error,
      }),
    ).toBe(true);
    const history = [
      {
        messageId: 'command-a',
        role: 'user',
        timestamp: 1000,
        startedSeq: 1,
        blocks: [{ blockId: 'user-a', blockType: 'text', content: 'A' }],
      },
      {
        messageId: `runtime-error-${seq}`,
        role: 'assistant',
        timestamp: 1001,
        startedSeq: seq,
        blocks: [
          {
            blockId: `runtime-error-text-${seq}`,
            blockType: 'text',
            content: `**Error:** ${error}`,
          },
        ],
      },
      ...(position === 'older'
        ? [
            {
              messageId: 'command-b',
              role: 'user',
              timestamp: 1002,
              startedSeq: 2,
              blocks: [{ blockId: 'user-b', blockType: 'text', content: 'B' }],
            },
          ]
        : []),
    ];
    fetch.mockImplementation((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.includes(`messages?throughSeq=${seq}`)
              ? { messages: history, cursor: seq, current: null }
              : [],
          ),
        ),
      ),
    );
    channel.listener({
      type: 'session_reconnect_snapshot',
      sessionId,
      cursor: seq,
      cursorValid: true,
      offerId: 'stable-replay',
      state: position === 'older' ? 'running' : 'idle',
    });
    await vi.waitFor(() =>
      expect(channel.acknowledgeSnapshot).toHaveBeenCalledWith(sessionId, seq, 'stable-replay'),
    );
    expect(
      fetch.mock.calls.some(
        ([url]) => url === `/api/sessions/${sessionId}/messages?throughSeq=${seq}`,
      ),
    ).toBe(true);
    const transcript = store.getState().messages.messages;
    const failures = transcript.filter((message) =>
      message.blocks.some((block) => block.content === `**Error:** ${error}`),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      messageId: `runtime-error-${seq}`,
      startedSeq: seq,
      blocks: [
        { blockId: `runtime-error-text-${seq}`, blockType: 'text', content: `**Error:** ${error}` },
      ],
    });
    expect(transcript.map((message) => message.messageId)).toEqual(
      history.map((message) => message.messageId),
    );
    if (position === 'older') {
      channel.listener({
        type: '_send_accepted',
        sessionId,
        clientMsgId: 'command-b',
        retained: true,
      });
      expect(store.getState().sendStatus).toBe('Preparing response…');
      expect(store.getState().messages.running).toBe(true);
    } else expect(store.getState().messages.running).toBe(false);
    expect(channel.acknowledgeSnapshot).toHaveBeenCalledOnce();
  },
);

it.each([
  { name: 'unmarked', patch: { retainedCommandFailure: undefined } },
  { name: 'unknown command', patch: { clientMsgId: 'unknown' } },
  { name: 'fractional sequence', patch: { seq: 2.5 } },
  { name: 'unsafe sequence', patch: { seq: Number.MAX_SAFE_INTEGER + 1 } },
  { name: 'wrong version', patch: { v: 1 } },
  { name: 'unclassified text', patch: { error: 'Generic runtime error' } },
])('keeps $name errors on their existing live-message identity path', ({ patch }) => {
  const { store } = setup();
  const sessionId = 'generic-error-identity';
  channel.listener({ type: 'session_id', sessionId });
  channel.listener({
    type: 'user_message',
    sessionId,
    seq: 1,
    messageId: 'known',
    text: 'Known prompt',
  });
  channel.listener({
    v: 2,
    type: 'error',
    sessionId,
    seq: 2,
    clientMsgId: 'known',
    retainedCommandFailure: true,
    error: 'Message saved. Recovery failed.',
    ...patch,
  });
  expect(store.getState().messages.messages.at(-1)?.messageId).toMatch(/^err-/);
});

it.each(['older', 'current'] as const)(
  'applies a live %s retained failure once when it arrives during a bounded history fetch',
  async (position) => {
    const { store, fetch } = setup();
    const sessionId = `retained-error-suffix-${position}`;
    const error = 'Message saved. Recovery failed during replay.';
    channel.listener({ type: 'session_id', sessionId });
    channel.listener({ type: 'user_message', sessionId, seq: 1, messageId: 'suffix-a', text: 'A' });
    const history = [
      {
        messageId: 'suffix-a',
        role: 'user',
        timestamp: 1000,
        startedSeq: 1,
        blocks: [{ blockId: 'user-a', blockType: 'text', content: 'A' }],
      },
    ];
    if (position === 'older') {
      channel.listener({
        type: 'user_message',
        sessionId,
        seq: 2,
        messageId: 'suffix-b',
        text: 'B',
      });
      channel.listener({
        type: '_send_accepted',
        sessionId,
        clientMsgId: 'suffix-b',
        retained: true,
      });
      history.push({
        messageId: 'suffix-b',
        role: 'user',
        timestamp: 1001,
        startedSeq: 2,
        blocks: [{ blockId: 'user-b', blockType: 'text', content: 'B' }],
      });
    }
    const cursor = position === 'older' ? 2 : 1;
    let finish!: () => void;
    fetch.mockImplementation((url: string) =>
      url.includes(`messages?throughSeq=${cursor}`)
        ? new Promise<Response>((resolve) => {
            finish = () =>
              resolve(new Response(JSON.stringify({ messages: history, cursor, current: null })));
          })
        : Promise.resolve(new Response('[]')),
    );
    channel.listener({
      type: 'session_reconnect_snapshot',
      sessionId,
      cursor,
      cursorValid: true,
      offerId: 'held-history',
      state: position === 'older' ? 'running' : 'idle',
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const seq = cursor + 1;
    channel.listener({
      v: 2,
      type: 'error',
      sessionId,
      seq,
      prevSessionSeq: cursor,
      clientMsgId: 'suffix-a',
      retainedCommandFailure: true,
      error,
    });
    finish();
    await vi.waitFor(() =>
      expect(channel.acknowledgeSnapshot).toHaveBeenCalledWith(sessionId, cursor, 'held-history'),
    );
    const transcript = store.getState().messages.messages;
    expect(
      transcript.filter((message) =>
        message.blocks.some((block) => block.content === `**Error:** ${error}`),
      ),
    ).toHaveLength(1);
    expect(transcript.map((message) => message.messageId)).toEqual([
      'suffix-a',
      `runtime-error-${seq}`,
      ...(position === 'older' ? ['suffix-b'] : []),
    ]);
    expect(store.getState().messages.running).toBe(position === 'older');
    if (position === 'older') {
      channel.listener({
        type: '_send_accepted',
        sessionId,
        clientMsgId: 'suffix-b',
        retained: true,
      });
      expect(store.getState().sendStatus).toBe('Preparing response…');
    }
  },
);

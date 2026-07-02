import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMitzoStore } from '../src/store.js';
import type { MitzoStoreOptions, MitzoStoreState } from '../src/store.js';
import type { TransportAdapter } from '../src/types.js';
import type { WebSocketLike } from '../src/ws-connection.js';
import { WS_READY_STATE } from '../src/types.js';
import type { StoreApi } from 'zustand/vanilla';

// ─── Mock WebSocket ─────────────────────────────────────────────────────────

class MockWebSocket implements WebSocketLike {
  readyState = WS_READY_STATE.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = WS_READY_STATE.CLOSED;
  }

  simulateOpen() {
    this.readyState = WS_READY_STATE.OPEN;
    this.onopen?.({});
  }

  simulateMessage(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  simulateClose() {
    this.readyState = WS_READY_STATE.CLOSED;
    this.onclose?.();
  }

  /** Complete the v2 hello/welcome handshake. */
  completeHandshake() {
    this.simulateOpen();
    this.simulateMessage({ type: 'welcome', protocolVersion: 2, connectionId: 'conn-1' });
  }

  parsedSent(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

// ─── Mock transport ─────────────────────────────────────────────────────────

function mockTransport(): TransportAdapter {
  return {
    connectWs: vi.fn(),
    fetch: vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
      text: () => Promise.resolve(''),
    }),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let lastWs: MockWebSocket;

function makeOptions(transport?: TransportAdapter): MitzoStoreOptions {
  return {
    transport: transport ?? mockTransport(),
    wsConfig: {
      buildUrl: () => 'ws://localhost:3000/ws',
      createWebSocket: () => {
        lastWs = new MockWebSocket();
        return lastWs;
      },
    },
  };
}

/** Create store and complete the v2 handshake so it's ready to use. */
function createReadyStore(transport?: TransportAdapter) {
  const store = createMitzoStore(makeOptions(transport));
  lastWs.completeHandshake();
  return store;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('createMitzoStore', () => {
  it('creates a store with initial state', () => {
    const store = createMitzoStore(makeOptions());
    const state = store.getState();

    expect(state.sessions.active).toBeNull();
    expect(state.messages.messages).toHaveLength(0);
    expect(state.messages.running).toBe(false);
    expect(state.messages.current).toBeNull();
    expect(state.connection.status).toBeDefined();
    expect(state.tasks.tree).toHaveLength(0);
    expect(state.sendError).toBeNull();
  });

  it('exposes action methods on the state', () => {
    const store = createMitzoStore(makeOptions());
    const state = store.getState();

    expect(typeof state.dispatchMessages).toBe('function');
    expect(typeof state.switchSession).toBe('function');
    expect(typeof state.newSession).toBe('function');
    expect(typeof state.sendMessage).toBe('function');
    expect(typeof state.stopGeneration).toBe('function');
    expect(typeof state.respondToPermission).toBe('function');
    expect(typeof state.setMode).toBe('function');
    expect(typeof state.setModel).toBe('function');
  });

  it('connects to WS and completes v2 handshake on creation', () => {
    createMitzoStore(makeOptions());
    const ws = lastWs;
    ws.simulateOpen();

    expect(ws.parsedSent()).toContainEqual({ type: 'hello', protocolVersion: 2 });
  });

  it('sets connection status to connected after welcome', () => {
    const store = createReadyStore();
    expect(store.getState().connection.status).toBe('connected');
  });
});

describe('switchSession', () => {
  it('updates active session and resets messages', async () => {
    const store = createReadyStore();

    store.getState().dispatchMessages({
      type: 'USER_SEND',
      text: 'hello',
      clientMsgId: 'c1',
    });
    expect(store.getState().messages.messages).toHaveLength(1);

    await store.getState().switchSession('session-abc');

    expect(store.getState().sessions.active).toBe('session-abc');
    expect(store.getState().messages.messages).toHaveLength(0);
  });

  it('fetches messages for the session via API', async () => {
    const transport = mockTransport();
    const msgs = [
      {
        messageId: 'm1',
        role: 'assistant',
        blocks: [{ blockId: 'b1', blockType: 'text', content: 'hi' }],
      },
    ];
    (transport.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(msgs),
      text: () => Promise.resolve(''),
    });

    const store = createReadyStore(transport);
    await store.getState().switchSession('session-abc');

    expect(transport.fetch).toHaveBeenCalledWith(
      '/api/sessions/session-abc/messages',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(store.getState().messages.messages).toHaveLength(1);
    expect(store.getState().messages.messages[0].messageId).toBe('m1');
  });

  it('sends switch_session over WS', async () => {
    const store = createReadyStore();
    await store.getState().switchSession('session-abc');

    expect(lastWs.parsedSent()).toContainEqual({
      type: 'switch_session',
      sessionId: 'session-abc',
    });
  });

  it('resets progress state on session switch', async () => {
    const store = createReadyStore();
    store.setState({
      progress: {
        blocks: { 'tool-1': { done: 3, total: 5, label: 'Build' } },
        toolIndex: { 'call-1': 'tool-1' },
      },
    });
    expect(Object.keys(store.getState().progress.blocks)).toHaveLength(1);

    await store.getState().switchSession('session-abc');

    expect(store.getState().progress.blocks).toEqual({});
    expect(store.getState().progress.toolIndex).toEqual({});
  });

  it('filters events from non-active sessions after switch', async () => {
    const store = createReadyStore();
    await store.getState().switchSession('session-b');

    // Events tagged with session-a should be ignored
    lastWs.simulateMessage({
      type: 'message_start',
      messageId: 'a-msg',
      sessionId: 'session-a',
    });

    expect(store.getState().messages.current).toBeNull();
    expect(store.getState().messages.messages).toHaveLength(0);
  });
});

describe('newSession', () => {
  it('clears active session and resets messages', () => {
    const store = createReadyStore();
    store.setState((s) => ({
      sessions: { ...s.sessions, active: 'old-session' },
    }));

    store.getState().newSession();

    expect(store.getState().sessions.active).toBeNull();
    expect(store.getState().messages.messages).toHaveLength(0);
  });

  it('sends switch_session with null to clear server-side active', () => {
    const store = createReadyStore();
    store.getState().newSession();

    expect(lastWs.parsedSent()).toContainEqual({
      type: 'switch_session',
      sessionId: null,
    });
  });

  it('resets progress state on new session', () => {
    const store = createReadyStore();
    store.setState({
      progress: {
        blocks: { 'tool-1': { done: 2, total: 4, label: 'Test' } },
        toolIndex: { 'call-1': 'tool-1' },
      },
    });
    expect(Object.keys(store.getState().progress.blocks)).toHaveLength(1);

    store.getState().newSession();

    expect(store.getState().progress.blocks).toEqual({});
    expect(store.getState().progress.toolIndex).toEqual({});
  });

  it('clears WS pending sends to prevent cross-session message leaks', () => {
    vi.useFakeTimers();
    try {
      const store = createMitzoStore(makeOptions());
      const ws1 = lastWs;
      ws1.completeHandshake();

      // Complete a turn so running=false
      store.getState().sendMessage('hello');
      lastWs.simulateMessage({ type: 'session_id', sessionId: 'sess-old' });
      lastWs.simulateMessage({ type: 'session_end', sessionId: 'sess-old' });
      expect(store.getState().messages.running).toBe(false);

      // WS dies (iOS background)
      ws1.simulateClose();

      // User sends while WS is down and running=false → goes to connection.pendingSends
      store.getState().sendMessage('stale message');
      expect(store.getState().sendError).toBeNull(); // confirms message was queued, not dropped

      // User starts a new session — should clear the WS queue
      store.getState().newSession();

      // WS reconnects (default reconnectDelayMs is 500ms)
      vi.advanceTimersByTime(600);
      const ws2 = lastWs;
      expect(ws2).not.toBe(ws1); // verify a new WS was created
      ws2.completeHandshake();

      // The stale message should NOT have been flushed to the new session
      const flushed = ws2
        .parsedSent()
        .filter((m) => m.type === 'send' && m.prompt === 'stale message');
      expect(flushed).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates new session from old session messages via sessionId filter', async () => {
    const store = createReadyStore();
    await store.getState().switchSession('old-session');

    store.getState().newSession();

    // Messages tagged with old-session should be filtered out since
    // currentSessionId is now undefined (no active session)
    lastWs.simulateMessage({
      type: 'message_start',
      messageId: 'old-msg',
      sessionId: 'old-session',
    });

    expect(store.getState().messages.messages).toHaveLength(0);
    expect(store.getState().messages.current).toBeNull();
  });
});

describe('reconnect recovery', () => {
  it('re-fetches messages for active session on reconnected event', async () => {
    const transport = mockTransport();
    const msgs = [
      {
        messageId: 'm1',
        role: 'assistant',
        blocks: [{ blockId: 'b1', blockType: 'text', content: 'recovered' }],
      },
    ];
    (transport.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(msgs),
      text: () => Promise.resolve(''),
    });

    const store = createReadyStore(transport);
    await store.getState().switchSession('sess-1');

    // Simulate reconnected event
    lastWs.simulateMessage({ type: 'reconnected', sessions: [] });

    // Wait for the async fetch
    await new Promise((r) => setTimeout(r, 50));

    expect(transport.fetch).toHaveBeenCalledWith(
      '/api/sessions/sess-1/messages',
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});

describe('sendMessage', () => {
  it('adds optimistic user message', () => {
    const store = createReadyStore();
    store.getState().sendMessage('hello');

    const { messages, running } = store.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].blocks[0].content).toBe('hello');
    expect(running).toBe(true);
  });

  it('sends v2 send message with sessionId=null for new sessions', () => {
    const store = createReadyStore();
    store.getState().sendMessage('hello');

    const sends = lastWs.parsedSent().filter((m) => m.type === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0].sessionId).toBeNull();
    expect(sends[0].prompt).toBe('hello');
    expect(sends[0].clientMsgId).toBeDefined();
  });

  it('sends v2 send message with sessionId for existing sessions', async () => {
    const store = createReadyStore();
    await store.getState().switchSession('sess-abc');

    // Simulate server assigning session (via session_id event)
    lastWs.simulateMessage({ type: 'session_id', sessionId: 'sess-abc' });

    store.getState().sendMessage('follow-up');

    const sends = lastWs.parsedSent().filter((m) => m.type === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0].sessionId).toBe('sess-abc');
    expect(sends[0].prompt).toBe('follow-up');
    // v2: no `resume` field
    expect(sends[0].resume).toBeUndefined();
  });

  it('sends the second message to WS after first turn completes', async () => {
    const store = createReadyStore();

    store.getState().sendMessage('first');
    lastWs.simulateMessage({ type: 'session_id', sessionId: 'sess-xyz' });
    lastWs.simulateMessage({ type: 'session_end', sessionId: 'sess-xyz' });

    expect(store.getState().messages.running).toBe(false);
    const sentBefore = lastWs.sent.length;

    store.getState().sendMessage('second');

    const newSends = lastWs.sent.slice(sentBefore).map((s) => JSON.parse(s));
    expect(newSends).toContainEqual(
      expect.objectContaining({ type: 'send', prompt: 'second', sessionId: 'sess-xyz' }),
    );
  });

  it('queues second message while first turn is running', async () => {
    const store = createReadyStore();

    store.getState().sendMessage('first');
    lastWs.simulateMessage({ type: 'session_id', sessionId: 'sess-q' });

    // Turn is still running — second send should queue
    const sentBefore = lastWs.sent.length;
    store.getState().sendMessage('second');

    // Should NOT have sent yet
    const newSendsImmediate = lastWs.sent.slice(sentBefore).map((s) => JSON.parse(s));
    expect(newSendsImmediate.filter((m) => m.type === 'send')).toHaveLength(0);

    // session_end triggers flush of queued message
    lastWs.simulateMessage({ type: 'session_end', sessionId: 'sess-q' });

    const newSends = lastWs.sent.slice(sentBefore).map((s) => JSON.parse(s));
    expect(newSends).toContainEqual(expect.objectContaining({ type: 'send', prompt: 'second' }));
  });

  it('queues second message as pendingSend while first turn is active', () => {
    const store = createReadyStore();

    store.getState().sendMessage('first');
    lastWs.simulateMessage({ type: 'session_id', sessionId: 'sess-pend' });

    const sentBefore = lastWs.sent.length;
    store.getState().sendMessage('second');

    // Second message should be queued, not immediately sent
    const immediateSends = lastWs.sent
      .slice(sentBefore)
      .filter((s) => JSON.parse(s).type === 'send');
    expect(immediateSends).toHaveLength(0);

    // But the optimistic user message should appear in the store
    const userMsgs = store.getState().messages.messages.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(2);
  });

  it('cancels pending timeout when session_end arrives in time', () => {
    vi.useFakeTimers();
    try {
      const store = createMitzoStore(makeOptions());
      lastWs.completeHandshake();

      store.getState().sendMessage('first');
      lastWs.simulateMessage({ type: 'session_id', sessionId: 'sess-ok' });

      store.getState().sendMessage('second');
      lastWs.simulateMessage({ type: 'session_end', sessionId: 'sess-ok' });

      const sentAfterEnd = lastWs.sent.length;
      vi.advanceTimersByTime(6_000);

      expect(lastWs.sent.length).toBe(sentAfterEnd);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending timeout on newSession', () => {
    vi.useFakeTimers();
    try {
      const store = createMitzoStore(makeOptions());
      lastWs.completeHandshake();

      store.getState().sendMessage('first');
      lastWs.simulateMessage({ type: 'session_id', sessionId: 'sess-new' });

      store.getState().sendMessage('second');
      const sentBefore = lastWs.sent.length;

      store.getState().newSession();
      vi.advanceTimersByTime(6_000);

      const flushed = lastWs.sent.slice(sentBefore).filter((s) => JSON.parse(s).type === 'send');
      expect(flushed).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WS → store wiring', () => {
  let store: StoreApi<MitzoStoreState>;

  beforeEach(async () => {
    const transport = mockTransport();
    (transport.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
      text: () => Promise.resolve(''),
    });
    store = createReadyStore(transport);
    await store.getState().switchSession('test-session');
  });

  it('dispatches MESSAGE_START through the protocol parser', () => {
    lastWs.simulateMessage({
      type: 'message_start',
      messageId: 'msg-1',
      sessionId: 'test-session',
    });

    expect(store.getState().messages.current).not.toBeNull();
    expect(store.getState().messages.current!.messageId).toBe('msg-1');
  });

  it('dispatches full message turn and finalizes', () => {
    lastWs.simulateMessage({
      type: 'message_start',
      messageId: 'msg-1',
      sessionId: 'test-session',
    });
    lastWs.simulateMessage({
      type: 'block_start',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
      sessionId: 'test-session',
    });
    lastWs.simulateMessage({
      type: 'block_delta',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
      delta: 'Hello!',
      sessionId: 'test-session',
    });
    lastWs.simulateMessage({
      type: 'block_end',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
      sessionId: 'test-session',
    });
    lastWs.simulateMessage({ type: 'message_end', messageId: 'msg-1', sessionId: 'test-session' });

    expect(store.getState().messages.current).toBeNull();
    expect(store.getState().messages.messages).toHaveLength(1);
    expect(store.getState().messages.messages[0].blocks[0].content).toBe('Hello!');
  });

  it('dispatches session_end and clears running', () => {
    store.getState().dispatchMessages({ type: 'SESSION_STATE_CHANGED', state: 'running' });
    expect(store.getState().messages.running).toBe(true);

    lastWs.simulateMessage({ type: 'session_end', sessionId: 'test-session' });

    expect(store.getState().messages.running).toBe(false);
  });

  it('dispatches task_state updates', () => {
    lastWs.simulateMessage({
      type: 'task_state',
      tasks: [{ id: 't1', summary: 'Task 1', status: 'pending', children: [] }],
    });

    expect(store.getState().tasks.tree).toHaveLength(1);
    expect(store.getState().tasks.tree[0].id).toBe('t1');
  });

  it('dispatches task_updated recursively', () => {
    lastWs.simulateMessage({
      type: 'task_state',
      tasks: [
        {
          id: 't1',
          summary: 'Parent',
          status: 'pending',
          children: [{ id: 't2', summary: 'Child', status: 'pending', children: [] }],
        },
      ],
    });

    lastWs.simulateMessage({
      type: 'task_updated',
      task: { id: 't2', summary: 'Child Updated', status: 'done', children: [] },
    });

    expect(store.getState().tasks.tree[0].children[0].summary).toBe('Child Updated');
    expect(store.getState().tasks.tree[0].children[0].status).toBe('done');
  });

  it('dispatches task_deleted recursively', () => {
    lastWs.simulateMessage({
      type: 'task_state',
      tasks: [
        {
          id: 't1',
          summary: 'Parent',
          status: 'pending',
          children: [{ id: 't2', summary: 'Child', status: 'pending', children: [] }],
        },
      ],
    });

    lastWs.simulateMessage({ type: 'task_deleted', taskId: 't2' });

    expect(store.getState().tasks.tree).toHaveLength(1);
    expect(store.getState().tasks.tree[0].children).toHaveLength(0);
  });

  it('accepts session_id matching the active session', () => {
    lastWs.simulateMessage({ type: 'session_id', sessionId: 'test-session' });

    // Active session remains test-session (confirmed, not changed)
    expect(store.getState().sessions.active).toBe('test-session');
  });

  it('rejects session_id from a different session when active is set', () => {
    lastWs.simulateMessage({ type: 'session_id', sessionId: 'foreign-session' });

    // Should NOT hijack the active session
    expect(store.getState().sessions.active).toBe('test-session');
  });

  it('dispatches error messages', () => {
    lastWs.simulateMessage({ type: 'error', error: 'Something broke' });

    const msgs = store.getState().messages.messages;
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[msgs.length - 1].blocks[0].content).toContain('Something broke');
  });
});

describe('stopGeneration', () => {
  it('sends v2 stop message with sessionId over WS', async () => {
    const store = createReadyStore();
    await store.getState().switchSession('test-session');

    store.getState().stopGeneration();

    const sent = lastWs.parsedSent();
    const stop = sent.find((m) => m.type === 'stop');
    expect(stop).toBeDefined();
    expect(stop!.sessionId).toBe('test-session');
  });

  it('does not send stop before session_id arrives', () => {
    const store = createReadyStore();
    store.getState().sendMessage('hello');

    store.getState().stopGeneration();

    const sent = lastWs.parsedSent();
    const stop = sent.find((m) => m.type === 'stop');
    expect(stop).toBeUndefined();
  });
});

describe('respondToPermission', () => {
  it('sends v2 permission_response with sessionId and clears pending', async () => {
    const store = createReadyStore();
    await store.getState().switchSession('test-session');

    lastWs.simulateMessage({
      type: 'permission_request',
      permId: 'perm-1',
      toolName: 'Bash',
      toolInput: 'rm -rf /',
      tier: 'elevated',
      sessionId: 'test-session',
    });
    expect(store.getState().messages.permission).not.toBeNull();

    store.getState().respondToPermission('perm-1', 'once');

    // Banner should be dismissed
    expect(store.getState().messages.permission).toBeNull();

    const sent = lastWs.parsedSent();
    const response = sent.find((m) => m.type === 'permission_response');
    expect(response).toEqual({
      type: 'permission_response',
      sessionId: 'test-session',
      permId: 'perm-1',
      decision: 'once',
    });
  });
});

describe('respondToPermission — queued on disconnect', () => {
  it('clears permission and queues the message when WS is reconnecting', async () => {
    const store = createReadyStore();
    await store.getState().switchSession('test-session');

    lastWs.simulateMessage({
      type: 'permission_request',
      permId: 'perm-1',
      toolName: 'Bash',
      toolInput: 'rm -rf /',
      tier: 'elevated',
      sessionId: 'test-session',
    });
    expect(store.getState().messages.permission).not.toBeNull();

    // Disconnect — send() queues the message (reconnect timer active)
    lastWs.simulateClose();

    store.getState().respondToPermission('perm-1', 'once');

    // Banner should still clear — message is queued for delivery on reconnect
    expect(store.getState().messages.permission).toBeNull();
  });
});

describe('respondToPermission — first turn edge case', () => {
  it('sends permission_response without sessionId when no session is active', () => {
    const store = createReadyStore();
    store.getState().sendMessage('hello');

    // Permission arrives before session_id
    lastWs.simulateMessage({
      type: 'permission_request',
      permId: 'perm-1',
      toolName: 'Bash',
      toolInput: 'ls',
      tier: 'elevated',
    });

    store.getState().respondToPermission('perm-1', 'once');

    const sent = lastWs.parsedSent();
    const response = sent.find((m) => m.type === 'permission_response');
    expect(response).toBeDefined();
    expect(response).not.toHaveProperty('sessionId');
    expect(response!.permId).toBe('perm-1');
    expect(response!.decision).toBe('once');
  });
});

describe('sendMessage — session expired recovery', () => {
  it('shows error on "No conversation found" without clearing session', async () => {
    const store = createReadyStore();
    await store.getState().switchSession('old-session-id');

    store.getState().sendMessage('first attempt');

    lastWs.simulateMessage({
      type: 'error',
      error:
        'Claude Code returned an error result: No conversation found with session ID: old-session-id',
    });

    // Session stays active — server handles retry without resume
    expect(store.getState().sessions.active).toBe('old-session-id');
    // Error is added as a message to the user
    const msgs = store.getState().messages.messages;
    const errMsg = msgs.find((m) =>
      m.blocks?.some((b: { content?: string }) => b.content?.includes('No conversation found')),
    );
    expect(errMsg).toBeDefined();
  });
});

describe('interruptMessage', () => {
  it('includes model from opts when provided', () => {
    const store = createReadyStore();
    store.getState().sendMessage('first');
    lastWs.simulateMessage({ type: 'session_id', sessionId: 'sess-int' });

    store.getState().interruptMessage('urgent', { model: 'claude-opus-4-6' });

    const interrupts = lastWs.parsedSent().filter((m) => m.type === 'interrupt');
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].model).toBe('claude-opus-4-6');
  });

  it('falls back to config.modelId when opts.model is not provided', () => {
    const store = createReadyStore();
    store.getState().setModel('claude-sonnet-4-6');
    store.getState().sendMessage('first');
    lastWs.simulateMessage({ type: 'session_id', sessionId: 'sess-int2' });

    store.getState().interruptMessage('urgent');

    const interrupts = lastWs.parsedSent().filter((m) => m.type === 'interrupt');
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].model).toBe('claude-sonnet-4-6');
  });

  it('opts.model takes precedence over config.modelId', () => {
    const store = createReadyStore();
    store.getState().setModel('claude-sonnet-4-6');
    store.getState().sendMessage('first');
    lastWs.simulateMessage({ type: 'session_id', sessionId: 'sess-int3' });

    store.getState().interruptMessage('urgent', { model: 'claude-opus-4-7' });

    const interrupts = lastWs.parsedSent().filter((m) => m.type === 'interrupt');
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].model).toBe('claude-opus-4-7');
  });

  it('does not include model field when both opts and config are null', () => {
    const store = createReadyStore();
    store.getState().sendMessage('first');
    lastWs.simulateMessage({ type: 'session_id', sessionId: 'sess-int4' });

    store.getState().interruptMessage('urgent');

    const interrupts = lastWs.parsedSent().filter((m) => m.type === 'interrupt');
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].model).toBeUndefined();
  });
});

describe('session isolation via sessionId filtering', () => {
  it('ignores events tagged with a different sessionId', async () => {
    const store = createReadyStore();
    await store.getState().switchSession('session-b');

    lastWs.simulateMessage({
      type: 'message_start',
      messageId: 'a-msg',
      sessionId: 'session-a',
    });
    lastWs.simulateMessage({
      type: 'block_start',
      messageId: 'a-msg',
      blockId: 'b1',
      blockType: 'text',
      sessionId: 'session-a',
    });
    lastWs.simulateMessage({
      type: 'block_delta',
      messageId: 'a-msg',
      blockId: 'b1',
      blockType: 'text',
      delta: 'should not appear',
      sessionId: 'session-a',
    });

    expect(store.getState().messages.messages).toHaveLength(0);
    expect(store.getState().messages.current).toBeNull();
  });

  it('accepts events tagged with the active sessionId', async () => {
    const store = createReadyStore();
    await store.getState().switchSession('session-b');

    lastWs.simulateMessage({
      type: 'message_start',
      messageId: 'b-msg',
      sessionId: 'session-b',
    });

    expect(store.getState().messages.current).not.toBeNull();
    expect(store.getState().messages.current!.messageId).toBe('b-msg');
  });

  it('rejects session_end from a foreign session when active session is set', async () => {
    const store = createReadyStore();
    await store.getState().switchSession('session-b');
    store.getState().dispatchMessages({ type: 'SESSION_STATE_CHANGED', state: 'running' });

    lastWs.simulateMessage({
      type: 'session_end',
      sessionId: 'session-a',
    });

    // running should NOT be cleared — the event was from a different session
    expect(store.getState().messages.running).toBe(true);
  });

  it('rejects session_id from a foreign session when active session is set', async () => {
    const store = createReadyStore();
    await store.getState().switchSession('session-b');

    lastWs.simulateMessage({
      type: 'session_id',
      sessionId: 'session-a',
    });

    // Active session should NOT change
    expect(store.getState().sessions.active).toBe('session-b');
  });

  it('accepts session_id when no active session (new session assignment)', () => {
    const store = createReadyStore();

    lastWs.simulateMessage({
      type: 'session_id',
      sessionId: 'brand-new',
    });

    expect(store.getState().sessions.active).toBe('brand-new');
  });

  it('accepts global events without sessionId', async () => {
    const store = createReadyStore();
    await store.getState().switchSession('session-b');

    lastWs.simulateMessage({
      type: 'task_state',
      tasks: [{ id: 't1', summary: 'Global task', status: 'pending', children: [] }],
    });

    expect(store.getState().tasks.tree).toHaveLength(1);
  });

  it('drops session_end when no active session (null-session filter)', async () => {
    const store = createReadyStore();
    await store.getState().switchSession('old-session');
    store.getState().dispatchMessages({ type: 'SESSION_STATE_CHANGED', state: 'running' });

    store.getState().newSession();

    lastWs.simulateMessage({
      type: 'session_end',
      sessionId: 'old-session',
    });

    // running should still be false from newSession reset, not from session_end
    // The session_end event should have been dropped by the tightened filter
    expect(store.getState().messages.running).toBe(false);
  });

  it('allows permission_request through when no active session (first-turn race)', async () => {
    const store = createReadyStore();

    lastWs.simulateMessage({
      type: 'permission_request',
      permId: 'p1',
      toolName: 'Write',
      toolInput: '{}',
      sessionId: 'new-session',
    });

    // Permission should pass through — it can arrive before session_id
    expect(store.getState().messages.permission).not.toBeNull();
    expect(store.getState().messages.permission?.permId).toBe('p1');
  });
});

describe('setMode', () => {
  it('updates config mode and sends v2 set_mode', async () => {
    const store = createReadyStore();
    await store.getState().switchSession('test-session');

    store.getState().setMode('auto');

    expect(store.getState().config.mode).toBe('auto');
    expect(lastWs.parsedSent()).toContainEqual({
      type: 'set_mode',
      sessionId: 'test-session',
      mode: 'auto',
    });
  });
});

describe('setModel', () => {
  it('updates config modelId', () => {
    const store = createReadyStore();
    store.getState().setModel('claude-sonnet-4-5-20250514');
    expect(store.getState().config.modelId).toBe('claude-sonnet-4-5-20250514');
  });
});

describe('dispatchMessages', () => {
  it('applies messages reducer action directly', () => {
    const store = createReadyStore();
    store.getState().dispatchMessages({ type: 'SESSION_STATE_CHANGED', state: 'running' });
    expect(store.getState().messages.running).toBe(true);
  });
});

describe('loadTasks', () => {
  it('fetches tasks from API and sets store.tasks.tree', async () => {
    const transport = mockTransport();
    (transport.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/api/tasks') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              tasks: [{ id: 't1', title: 'Task 1', status: 'pending', children: [] }],
            }),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
        text: () => Promise.resolve(''),
      });
    });

    const store = createReadyStore(transport);
    await store.getState().loadTasks();

    expect(store.getState().tasks.tree).toHaveLength(1);
    expect(store.getState().tasks.tree[0].id).toBe('t1');
  });
});

describe('loadLoopStatus', () => {
  it('fetches loop status from API and sets store.tasks.loopStatus', async () => {
    const transport = mockTransport();
    (transport.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/api/loop/status') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              state: 'running',
              goalId: 'g1',
              activeTaskId: 't1',
              progress: { done: 2, total: 5 },
              specMode: false,
              awaitingApproval: true,
            }),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
        text: () => Promise.resolve(''),
      });
    });

    const store = createReadyStore(transport);
    await store.getState().loadLoopStatus();

    expect(store.getState().tasks.loopStatus.state).toBe('running');
    expect(store.getState().tasks.loopStatus.goalId).toBe('g1');
    expect(store.getState().tasks.loopStatus.awaitingApproval).toBe(true);
  });
});

describe('loadInbox', () => {
  it('fetches inbox items from API and sets store.inbox', async () => {
    const transport = mockTransport();
    (transport.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/api/inbox') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                filename: 'f1.md',
                agent: 'troubadour',
                title: 'Hello',
                tags: [],
                timestamp: '2026-04-17',
                preview: 'hi',
              },
            ]),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
        text: () => Promise.resolve(''),
      });
    });

    const store = createReadyStore(transport);
    await store.getState().loadInbox();

    expect(store.getState().inbox.items).toHaveLength(1);
    expect(store.getState().inbox.count).toBe(1);
    expect(store.getState().inbox.items[0].filename).toBe('f1.md');
  });
});

describe('task CRUD actions', () => {
  it('createTask calls the API', async () => {
    const transport = mockTransport();
    (transport.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ id: 't-new', title: 'New Task', status: 'pending', children: [] }),
      text: () => Promise.resolve(''),
    });
    const store = createReadyStore(transport);

    await store.getState().createTask({ title: 'New Task' });

    expect(transport.fetch).toHaveBeenCalledWith(
      '/api/tasks',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('deleteTask calls the API', async () => {
    const transport = mockTransport();
    (transport.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    });
    const store = createReadyStore(transport);

    await store.getState().deleteTask('t1');

    expect(transport.fetch).toHaveBeenCalledWith(
      '/api/tasks/t1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('startLoop calls the API', async () => {
    const transport = mockTransport();
    (transport.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    });
    const store = createReadyStore(transport);

    await store.getState().startLoop('g1', true);

    expect(transport.fetch).toHaveBeenCalledWith(
      '/api/loop/start',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('foreground recovery', () => {
  it('re-fetches messages when store has active session but no messages', async () => {
    const transport = mockTransport();
    const restoredMessages = [
      { messageId: 'msg-1', role: 'assistant', blocks: [], isStreaming: false },
    ];
    // Mock all fetch calls to return messages for /messages endpoints
    (transport.fetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(restoredMessages),
        text: () => Promise.resolve(''),
      }),
    );
    const store = createReadyStore(transport);

    // Set an active session with no messages (simulates iOS page eviction)
    store.setState((s) => ({
      sessions: { ...s.sessions, active: 'sess-1' },
    }));

    // Simulate _foreground event
    lastWs.simulateMessage({ type: '_foreground' });

    // Wait for the async fetch to resolve
    await vi.waitFor(() => {
      expect(store.getState().messages.messages.length).toBeGreaterThan(0);
    });
  });

  it('always re-fetches on foreground even when messages already exist', async () => {
    const transport = mockTransport();
    const store = createReadyStore(transport);

    store.setState((s) => ({
      sessions: { ...s.sessions, active: 'sess-1' },
      messages: {
        ...s.messages,
        messages: [{ role: 'assistant', blocks: [], isStreaming: false } as never],
      },
    }));

    (transport.fetch as ReturnType<typeof vi.fn>).mockClear();

    lastWs.simulateMessage({ type: '_foreground' });

    await new Promise((r) => setTimeout(r, 50));

    const fetchCalls = (transport.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const sessionMsgCalls = fetchCalls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/messages'),
    );
    expect(sessionMsgCalls).toHaveLength(1);
  });

  it('does not clobber messages that arrived between fetch start and resolve', async () => {
    const transport = mockTransport();
    let resolveFetch!: (v: unknown) => void;
    (transport.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/messages')) {
        return new Promise((r) => {
          resolveFetch = r;
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
        text: () => Promise.resolve(''),
      });
    });
    const store = createReadyStore(transport);

    store.setState((s) => ({
      sessions: { ...s.sessions, active: 'sess-1' },
    }));

    // Trigger foreground — fetch starts but hasn't resolved yet
    lastWs.simulateMessage({ type: '_foreground' });

    // Meanwhile, live data arrives and populates the store
    store.setState((s) => ({
      messages: {
        ...s.messages,
        messages: [{ role: 'assistant', blocks: [], isStreaming: false } as never],
      },
    }));

    // Now the fetch resolves with stale data
    resolveFetch({
      ok: true,
      json: () =>
        Promise.resolve([
          { role: 'assistant', blocks: [{ type: 'text', text: 'stale' }], isStreaming: false },
          { role: 'assistant', blocks: [{ type: 'text', text: 'stale2' }], isStreaming: false },
        ]),
      text: () => Promise.resolve(''),
    });

    await new Promise((r) => setTimeout(r, 50));

    // Foreground recovery always calls RESTORE — invalid messages are filtered by the
    // reducer's shape validation, so only valid ones survive. The stale test data
    // lacks messageId and proper block structure, so RESTORE filters them out.
    // The original 1 live message persists since RESTORE merges.
    expect(store.getState().messages.messages).toHaveLength(1);
  });

  it('preserves streaming state when REST returns empty array', async () => {
    const transport = mockTransport();
    (transport.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/messages')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
        text: () => Promise.resolve(''),
      });
    });
    const store = createReadyStore(transport);

    store.setState((s) => ({
      sessions: { ...s.sessions, active: 'sess-1' },
    }));

    // Simulate an in-progress streaming message
    const streamingCurrent = {
      messageId: 'msg-streaming',
      blocks: new Map([
        [
          'b0',
          {
            blockId: 'b0',
            blockType: 'text' as const,
            content: 'Let me check the memory vault.',
            done: false,
          },
        ],
      ]),
      blockOrder: ['b0'],
    };
    store.setState((s) => ({
      messages: {
        ...s.messages,
        messages: [
          {
            messageId: 'user-1',
            role: 'user' as const,
            timestamp: Date.now(),
            blocks: [{ blockId: 'u0', blockType: 'text' as const, content: 'hello' }],
          },
        ],
        current: streamingCurrent,
      },
    }));

    // Foreground fires — REST returns empty (timing gap)
    lastWs.simulateMessage({ type: '_foreground' });
    await new Promise((r) => setTimeout(r, 50));

    // Streaming state must survive — not wiped
    const state = store.getState().messages;
    expect(state.current).not.toBeNull();
    expect(state.current?.messageId).toBe('msg-streaming');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].messageId).toBe('user-1');
  });

  // P1: syncRunningState tests removed — running state is now server-authoritative
  // via session_state_changed events. No polling on foreground needed.
});

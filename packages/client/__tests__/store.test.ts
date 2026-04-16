import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMitzoStore } from '../src/store.js';
import type { MitzoStoreOptions, MitzoStoreState } from '../src/store.js';
import type { TransportAdapter } from '../src/types.js';
import type { WebSocketLike } from '../src/ws-connection.js';
import { WS_READY_STATE } from '../src/types.js';
import type { StoreApi } from 'zustand/vanilla';

// ─── Mock WebSocket ─────────────────────────────────────────────────────────

class MockWebSocket implements WebSocketLike {
  readyState = WS_READY_STATE.OPEN;
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

  // Test helpers
  simulateOpen() {
    this.onopen?.({});
  }

  simulateMessage(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
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
});

describe('switchSession', () => {
  it('updates active session and resets messages', async () => {
    const transport = mockTransport();
    const store = createMitzoStore(makeOptions(transport));

    // Pre-populate some messages
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

    const store = createMitzoStore(makeOptions(transport));
    await store.getState().switchSession('session-abc');

    expect(transport.fetch).toHaveBeenCalledWith(
      '/api/sessions/session-abc/messages',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(store.getState().messages.messages).toHaveLength(1);
    expect(store.getState().messages.messages[0].messageId).toBe('m1');
  });
});

describe('newSession', () => {
  it('clears active session and resets messages', () => {
    const store = createMitzoStore(makeOptions());
    store.setState((s) => ({
      sessions: { ...s.sessions, active: 'old-session' },
    }));

    store.getState().newSession();

    expect(store.getState().sessions.active).toBeNull();
    expect(store.getState().messages.messages).toHaveLength(0);
  });
});

describe('sendMessage', () => {
  it('adds optimistic user message', () => {
    const store = createMitzoStore(makeOptions());
    store.getState().sendMessage('hello');

    const { messages, running } = store.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].blocks[0].content).toBe('hello');
    expect(running).toBe(true);
  });

  it('subscribes to WS pool for new sessions', () => {
    const store = createMitzoStore(makeOptions());
    store.getState().sendMessage('hello');

    // The WS was created (subscribe triggers getOrCreate → connectEntry)
    expect(lastWs).toBeDefined();
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
    store = createMitzoStore(makeOptions(transport));

    // Switch to a session to wire up the WS listener
    await store.getState().switchSession('test-session');
  });

  it('dispatches MESSAGE_START through the protocol parser', () => {
    lastWs.simulateMessage({ type: 'client_id', clientId: 'c1' });
    // client_id triggers a subscribe message, then we get server messages
    lastWs.simulateMessage({ type: 'subscribed', running: false });
    lastWs.simulateMessage({ type: 'message_start', messageId: 'msg-1' });

    expect(store.getState().messages.current).not.toBeNull();
    expect(store.getState().messages.current!.messageId).toBe('msg-1');
  });

  it('dispatches full message turn and finalizes', () => {
    lastWs.simulateMessage({ type: 'client_id', clientId: 'c1' });
    lastWs.simulateMessage({ type: 'subscribed', running: false });
    lastWs.simulateMessage({ type: 'message_start', messageId: 'msg-1' });
    lastWs.simulateMessage({
      type: 'block_start',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
    });
    lastWs.simulateMessage({
      type: 'block_delta',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
      delta: 'Hello!',
    });
    lastWs.simulateMessage({
      type: 'block_end',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
    });
    lastWs.simulateMessage({ type: 'message_end', messageId: 'msg-1' });

    expect(store.getState().messages.current).toBeNull();
    expect(store.getState().messages.messages).toHaveLength(1);
    expect(store.getState().messages.messages[0].blocks[0].content).toBe('Hello!');
  });

  it('dispatches session_end and clears running', () => {
    lastWs.simulateMessage({ type: 'client_id', clientId: 'c1' });
    lastWs.simulateMessage({ type: 'subscribed', running: true });

    expect(store.getState().messages.running).toBe(true);

    lastWs.simulateMessage({ type: 'session_end', sessionId: 'test-session' });

    expect(store.getState().messages.running).toBe(false);
  });

  it('dispatches task_state updates', () => {
    lastWs.simulateMessage({ type: 'client_id', clientId: 'c1' });
    lastWs.simulateMessage({ type: 'subscribed', running: false });
    lastWs.simulateMessage({
      type: 'task_state',
      tasks: [{ id: 't1', summary: 'Task 1', status: 'pending', children: [] }],
    });

    expect(store.getState().tasks.tree).toHaveLength(1);
    expect(store.getState().tasks.tree[0].id).toBe('t1');
  });

  it('dispatches task_updated recursively', () => {
    lastWs.simulateMessage({ type: 'client_id', clientId: 'c1' });
    lastWs.simulateMessage({ type: 'subscribed', running: false });

    // Set up a tree with nested tasks
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

    // Update the nested task
    lastWs.simulateMessage({
      type: 'task_updated',
      task: { id: 't2', summary: 'Child Updated', status: 'done', children: [] },
    });

    expect(store.getState().tasks.tree[0].children[0].summary).toBe('Child Updated');
    expect(store.getState().tasks.tree[0].children[0].status).toBe('done');
  });

  it('dispatches task_deleted recursively', () => {
    lastWs.simulateMessage({ type: 'client_id', clientId: 'c1' });
    lastWs.simulateMessage({ type: 'subscribed', running: false });

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

  it('updates session on session_id message', () => {
    lastWs.simulateMessage({ type: 'client_id', clientId: 'c1' });
    lastWs.simulateMessage({ type: 'subscribed', running: false });
    lastWs.simulateMessage({ type: 'session_id', sessionId: 'new-sid' });

    expect(store.getState().sessions.active).toBe('new-sid');
  });

  it('dispatches error messages', () => {
    lastWs.simulateMessage({ type: 'client_id', clientId: 'c1' });
    lastWs.simulateMessage({ type: 'subscribed', running: false });
    lastWs.simulateMessage({ type: 'error', error: 'Something broke' });

    const msgs = store.getState().messages.messages;
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[msgs.length - 1].blocks[0].content).toContain('Something broke');
  });
});

describe('setMode', () => {
  it('updates config mode', () => {
    const store = createMitzoStore(makeOptions());
    store.getState().setMode('auto');
    expect(store.getState().config.mode).toBe('auto');
  });
});

describe('setModel', () => {
  it('updates config modelId', () => {
    const store = createMitzoStore(makeOptions());
    store.getState().setModel('claude-sonnet-4-5-20250514');
    expect(store.getState().config.modelId).toBe('claude-sonnet-4-5-20250514');
  });
});

describe('dispatchMessages', () => {
  it('applies messages reducer action directly', () => {
    const store = createMitzoStore(makeOptions());
    store.getState().dispatchMessages({ type: 'SET_RUNNING', running: true });
    expect(store.getState().messages.running).toBe(true);
  });
});

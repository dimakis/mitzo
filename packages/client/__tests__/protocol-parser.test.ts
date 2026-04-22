import { describe, it, expect, vi } from 'vitest';
import { parseServerMessage } from '../src/protocol-parser.js';
import type { ProtocolCallbacks, ProtocolParserState } from '../src/protocol-parser.js';

function makeState(overrides?: Partial<ProtocolParserState>): ProtocolParserState {
  return {
    currentSessionId: undefined,
    pendingSend: null,
    ...overrides,
  };
}

function makeCallbacks(overrides?: Partial<ProtocolCallbacks>): ProtocolCallbacks {
  return {
    onSessionAssigned: vi.fn(),
    onSessionExpired: vi.fn(),
    onMessagesRestored: vi.fn(),
    onSessionRenamed: vi.fn(),
    setWsRunning: vi.fn(),
    sendQueued: vi.fn(),
    ...overrides,
  };
}

const POOL_KEY = 'session:test';

// ─── Lifecycle events ─────────────────────────────────────────────────────────

describe('pool lifecycle events', () => {
  it('_open and _close produce no message actions', () => {
    const state = makeState();
    const cb = makeCallbacks();
    const r1 = parseServerMessage({ type: '_open' }, state, cb, POOL_KEY);
    const r2 = parseServerMessage({ type: '_close' }, state, cb, POOL_KEY);
    expect(r1.messagesActions).toHaveLength(0);
    expect(r2.messagesActions).toHaveLength(0);
  });

  it('_open emits connectionUpdate with status=connected', () => {
    const r = parseServerMessage({ type: '_open' }, makeState(), makeCallbacks(), POOL_KEY);
    expect(r.connectionUpdate).toEqual({ status: 'connected' });
  });

  it('_close emits connectionUpdate with status=disconnected', () => {
    const r = parseServerMessage({ type: '_close' }, makeState(), makeCallbacks(), POOL_KEY);
    expect(r.connectionUpdate).toEqual({ status: 'disconnected' });
  });
});

// ─── Reattach ─────────────────────────────────────────────────────────────────

describe('reattach', () => {
  it('reattached sets running and calls onSessionAssigned', () => {
    const cb = makeCallbacks();
    const r = parseServerMessage(
      { type: 'reattached', clientId: 'c1', sessionId: 'sid-1', running: true },
      makeState(),
      cb,
      POOL_KEY,
    );
    expect(r.messagesActions).toEqual([{ type: 'SET_RUNNING', running: true }]);
    expect(cb.onSessionAssigned).toHaveBeenCalledWith('sid-1');
    expect(cb.setWsRunning).toHaveBeenCalledWith(POOL_KEY, true);
    expect(r.connectionUpdate).toEqual({ status: 'connected' });
  });

  it('reattach_failed sets running=false and marks connection connected', () => {
    const cb = makeCallbacks();
    const r = parseServerMessage(
      { type: 'reattach_failed', clientId: 'old' },
      makeState(),
      cb,
      POOL_KEY,
    );
    expect(r.messagesActions).toEqual([{ type: 'SET_RUNNING', running: false }]);
    expect(cb.setWsRunning).toHaveBeenCalledWith(POOL_KEY, false);
    expect(r.connectionUpdate).toEqual({ status: 'connected' });
  });

  it('reattach_failed calls onMessagesRestored with fetched messages', async () => {
    const msgs = [
      {
        messageId: 'm1',
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'hello' }],
      },
    ];
    const fetchMessages = vi.fn().mockResolvedValue(msgs);
    const onMessagesRestored = vi.fn();
    const cb = makeCallbacks({ fetchMessages, onMessagesRestored });
    const state = makeState({ currentSessionId: 'sid-1' });

    parseServerMessage({ type: 'reattach_failed', clientId: 'old' }, state, cb, POOL_KEY);

    // Wait for the async fetchMessages to resolve
    await vi.waitFor(() => {
      expect(onMessagesRestored).toHaveBeenCalledWith(msgs);
    });
  });

  it('reattach_failed does not call onMessagesRestored when fetch returns empty', async () => {
    const fetchMessages = vi.fn().mockResolvedValue([]);
    const onMessagesRestored = vi.fn();
    const cb = makeCallbacks({ fetchMessages, onMessagesRestored });
    const state = makeState({ currentSessionId: 'sid-1' });

    parseServerMessage({ type: 'reattach_failed', clientId: 'old' }, state, cb, POOL_KEY);

    // Flush the microtask queue so the mockResolvedValue resolves
    await vi.waitFor(() => {
      expect(fetchMessages).toHaveBeenCalled();
    });
    expect(onMessagesRestored).not.toHaveBeenCalled();
  });

  it('reattach_failed skips fetch when no currentSessionId', () => {
    const fetchMessages = vi.fn();
    const cb = makeCallbacks({ fetchMessages });

    parseServerMessage({ type: 'reattach_failed', clientId: 'old' }, makeState(), cb, POOL_KEY);

    expect(fetchMessages).not.toHaveBeenCalled();
  });
});

// ─── Session lifecycle ────────────────────────────────────────────────────────

describe('session lifecycle', () => {
  it('session_id calls onSessionAssigned', () => {
    const cb = makeCallbacks();
    parseServerMessage({ type: 'session_id', sessionId: 'new-sid' }, makeState(), cb, POOL_KEY);
    expect(cb.onSessionAssigned).toHaveBeenCalledWith('new-sid');
  });

  it('session_renamed calls onSessionRenamed', () => {
    const cb = makeCallbacks();
    parseServerMessage(
      { type: 'session_renamed', sessionId: 'sid', name: 'New Name' },
      makeState(),
      cb,
      POOL_KEY,
    );
    expect(cb.onSessionRenamed).toHaveBeenCalledWith('New Name');
  });

  it('session_info dispatches SESSION_INFO action', () => {
    const r = parseServerMessage(
      { type: 'session_info', branch: 'main', cwd: '/tmp', worktree: false },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.messagesActions).toEqual([
      { type: 'SESSION_INFO', branch: 'main', isWorktree: false, wtId: undefined },
    ]);
  });

  it('session_end clears pending send and queues it', () => {
    const state = makeState({ pendingSend: { type: 'send', prompt: 'follow-up' } });
    const cb = makeCallbacks();
    const r = parseServerMessage({ type: 'session_end', sessionId: 'sid' }, state, cb, POOL_KEY);
    expect(r.messagesActions).toContainEqual({ type: 'SESSION_END', sessionId: 'sid' });
    expect(r.messagesActions).toContainEqual({ type: 'SET_RUNNING', running: true });
    expect(cb.sendQueued).toHaveBeenCalledWith(POOL_KEY, { type: 'send', prompt: 'follow-up' });
    expect(state.pendingSend).toBeNull();
  });
});

// ─── V2 content events ───────────────────────────────────────────────────────

describe('v2 content events', () => {
  it('message_start dispatches MESSAGE_START', () => {
    const r = parseServerMessage(
      { type: 'message_start', v: 2, messageId: 'msg-1' },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.messagesActions).toEqual([{ type: 'MESSAGE_START', messageId: 'msg-1' }]);
  });

  it('block_start dispatches BLOCK_START with toolName', () => {
    const r = parseServerMessage(
      {
        type: 'block_start',
        v: 2,
        messageId: 'msg-1',
        blockId: 'b1',
        blockType: 'tool_use',
        toolName: 'Bash',
      },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.messagesActions).toEqual([
      {
        type: 'BLOCK_START',
        messageId: 'msg-1',
        blockId: 'b1',
        blockType: 'tool_use',
        toolName: 'Bash',
      },
    ]);
  });

  it('block_delta dispatches BLOCK_DELTA', () => {
    const r = parseServerMessage(
      {
        type: 'block_delta',
        v: 2,
        messageId: 'msg-1',
        blockId: 'b1',
        blockType: 'text',
        delta: 'hi',
      },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.messagesActions).toEqual([
      { type: 'BLOCK_DELTA', messageId: 'msg-1', blockId: 'b1', blockType: 'text', delta: 'hi' },
    ]);
  });

  it('block_end dispatches BLOCK_END with tool fields', () => {
    const r = parseServerMessage(
      {
        type: 'block_end',
        v: 2,
        messageId: 'msg-1',
        blockId: 'b1',
        blockType: 'tool_use',
        toolName: 'Read',
        toolId: 'tool-1',
        input: 'file.ts',
      },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.messagesActions[0]).toMatchObject({
      type: 'BLOCK_END',
      toolName: 'Read',
      toolId: 'tool-1',
      input: 'file.ts',
    });
  });

  it('tool_result dispatches TOOL_RESULT', () => {
    const r = parseServerMessage(
      {
        type: 'tool_result',
        v: 2,
        messageId: 'msg-1',
        toolId: 'tool-1',
        result: 'output',
        isError: false,
      },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.messagesActions).toEqual([
      { type: 'TOOL_RESULT', toolId: 'tool-1', result: 'output', isError: false },
    ]);
  });

  it('message_end dispatches MESSAGE_END and assigns session if new', () => {
    const cb = makeCallbacks();
    const r = parseServerMessage(
      { type: 'message_end', v: 2, messageId: 'msg-1', sessionId: 'new-sid' },
      makeState(), // no currentSessionId
      cb,
      POOL_KEY,
    );
    expect(r.messagesActions).toEqual([
      { type: 'MESSAGE_END', messageId: 'msg-1', sessionId: 'new-sid' },
    ]);
    expect(cb.onSessionAssigned).toHaveBeenCalledWith('new-sid');
  });

  it('message_end does not reassign when session already known', () => {
    const cb = makeCallbacks();
    parseServerMessage(
      { type: 'message_end', v: 2, messageId: 'msg-1', sessionId: 'sid' },
      makeState({ currentSessionId: 'sid' }),
      cb,
      POOL_KEY,
    );
    expect(cb.onSessionAssigned).not.toHaveBeenCalled();
  });

  it('message_snapshot dispatches MESSAGE_SNAPSHOT', () => {
    const blocks = [{ blockId: 'b1', blockType: 'text', content: 'hello' }];
    const r = parseServerMessage(
      { type: 'message_snapshot', v: 2, messageId: 'msg-snap', blocks },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.messagesActions[0]).toMatchObject({
      type: 'MESSAGE_SNAPSHOT',
      messageId: 'msg-snap',
    });
  });
});

// ─── Permission events ───────────────────────────────────────────────────────

describe('permission events', () => {
  it('permission_request dispatches PERMISSION_REQUEST', () => {
    const r = parseServerMessage(
      {
        type: 'permission_request',
        permId: 'p1',
        toolName: 'Bash',
        toolInput: 'rm -rf /',
        tier: 'elevated',
      },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.messagesActions[0]).toMatchObject({
      type: 'PERMISSION_REQUEST',
      payload: { permId: 'p1', toolName: 'Bash', tier: 'elevated' },
    });
  });

  it('permission_timeout dispatches PERMISSION_TIMEOUT', () => {
    const r = parseServerMessage(
      { type: 'permission_timeout', permId: 'p1' },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.messagesActions).toEqual([{ type: 'PERMISSION_TIMEOUT', permId: 'p1' }]);
  });
});

// ─── Error handling ──────────────────────────────────────────────────────────

describe('error handling', () => {
  it('error with "No conversation found" shows error without calling onSessionExpired', () => {
    const cb = makeCallbacks();
    const r = parseServerMessage(
      { type: 'error', error: 'No conversation found' },
      makeState({ currentSessionId: 'expired-sid' }),
      cb,
      POOL_KEY,
    );
    expect(cb.onSessionExpired).not.toHaveBeenCalled();
    expect(r.messagesActions[0]).toMatchObject({
      type: 'ERROR',
      error: 'No conversation found',
    });
    expect(cb.setWsRunning).toHaveBeenCalledWith(POOL_KEY, false);
  });

  it('generic error dispatches ERROR action', () => {
    const cb = makeCallbacks();
    const r = parseServerMessage(
      { type: 'error', error: 'Something broke' },
      makeState(),
      cb,
      POOL_KEY,
    );
    expect(r.messagesActions).toEqual([{ type: 'ERROR', error: 'Something broke' }]);
  });

  it('error clears pendingSend', () => {
    const state = makeState({ pendingSend: { type: 'send', prompt: 'test' } });
    parseServerMessage({ type: 'error', error: 'fail' }, state, makeCallbacks(), POOL_KEY);
    expect(state.pendingSend).toBeNull();
  });
});

// ─── Subscribed ──────────────────────────────────────────────────────────────

describe('subscribed', () => {
  it('subscribed with running=true sets running', () => {
    const cb = makeCallbacks();
    const r = parseServerMessage(
      { type: 'subscribed', sessionId: 'sid', running: true },
      makeState(),
      cb,
      POOL_KEY,
    );
    expect(r.messagesActions).toEqual([{ type: 'SET_RUNNING', running: true }]);
    expect(cb.setWsRunning).toHaveBeenCalledWith(POOL_KEY, true);
  });

  it('subscribed with running=false produces no actions', () => {
    const r = parseServerMessage(
      { type: 'subscribed', sessionId: 'sid', running: false },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.messagesActions).toHaveLength(0);
  });
});

// ─── User message dedup ──────────────────────────────────────────────────────

describe('user_message', () => {
  it('dispatches USER_MESSAGE_RECEIVED', () => {
    const r = parseServerMessage(
      { type: 'user_message', v: 2, messageId: 'umsg-1', text: 'hello' },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.messagesActions).toEqual([
      { type: 'USER_MESSAGE_RECEIVED', messageId: 'umsg-1', text: 'hello' },
    ]);
  });
});

// ─── Task system messages ─────────────────────────────────────────────────────

describe('task system messages', () => {
  it('task_state produces tasksUpdate', () => {
    const tasks = [{ id: 't1', title: 'Task 1' }];
    const r = parseServerMessage(
      { type: 'task_state', tasks },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.tasksUpdate).toEqual({ type: 'task_state', tasks });
  });

  it('task_updated produces tasksUpdate', () => {
    const task = { id: 't1', title: 'Updated' };
    const r = parseServerMessage(
      { type: 'task_updated', task },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.tasksUpdate).toEqual({ type: 'task_updated', task });
  });

  it('task_deleted produces tasksUpdate', () => {
    const r = parseServerMessage(
      { type: 'task_deleted', taskId: 't1' },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.tasksUpdate).toEqual({ type: 'task_deleted', taskId: 't1' });
  });

  it('loop_status produces tasksUpdate', () => {
    const r = parseServerMessage(
      {
        type: 'loop_status',
        state: 'running',
        goalId: 'g1',
        activeTaskId: 't1',
        progress: { done: 2, total: 5 },
        specMode: false,
        awaitingApproval: false,
      },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.tasksUpdate).toMatchObject({
      type: 'loop_status',
      status: { state: 'running', goalId: 'g1' },
    });
  });
});

// ─── Token updates ───────────────────────────────────────────────────────────

describe('token_update', () => {
  it('produces tokensUpdate with all fields', () => {
    const r = parseServerMessage(
      {
        type: 'token_update',
        agentContext: 80000,
        contextCeiling: 200000,
        sessionTotal: 150000,
        numTurns: 3,
        turnIndex: 2,
      },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.tokensUpdate).toEqual({
      agentContext: 80000,
      contextCeiling: 200000,
      sessionTotal: 150000,
      numTurns: 3,
      turnIndex: 2,
    });
  });

  it('omits undefined fields so partial spread does not clobber existing values', () => {
    const r = parseServerMessage(
      {
        type: 'token_update',
        agentContext: 90000,
        contextCeiling: 200000,
        turnIndex: 4,
        // sessionTotal and numTurns intentionally absent (mid-turn update)
      },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.tokensUpdate).toEqual({
      agentContext: 90000,
      contextCeiling: 200000,
      turnIndex: 4,
    });
    // Must NOT have sessionTotal key at all
    expect('sessionTotal' in r.tokensUpdate!).toBe(false);
    expect('numTurns' in r.tokensUpdate!).toBe(false);
  });
});

// ─── Inbox ────────────────────────────────────────────────────────────────────

describe('inbox', () => {
  it('inbox_updated signals refresh', () => {
    const r = parseServerMessage({ type: 'inbox_updated' }, makeState(), makeCallbacks(), POOL_KEY);
    expect(r.inboxRefresh).toBe(true);
  });
});

// ─── Misc ─────────────────────────────────────────────────────────────────────

describe('misc', () => {
  it('worktree_opened dispatches WORKTREE_OPENED', () => {
    const r = parseServerMessage(
      { type: 'worktree_opened', repoName: 'mgmt', path: '/tmp/wt' },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.messagesActions).toEqual([
      { type: 'WORKTREE_OPENED', repoName: 'mgmt', path: '/tmp/wt' },
    ]);
  });

  it('native_command_result dispatches NATIVE_COMMAND_RESULT', () => {
    const r = parseServerMessage(
      { type: 'native_command_result', v: 2, command: 'status', content: 'ok' },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.messagesActions).toEqual([
      { type: 'NATIVE_COMMAND_RESULT', command: 'status', content: 'ok' },
    ]);
  });

  it('skill_invoked produces no actions', () => {
    const r = parseServerMessage(
      { type: 'skill_invoked', v: 2, name: 'commit', source: 'repo', arguments: '' },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.messagesActions).toHaveLength(0);
  });

  it('unknown message type produces no actions', () => {
    const r = parseServerMessage(
      { type: 'some_future_event', data: 123 },
      makeState(),
      makeCallbacks(),
      POOL_KEY,
    );
    expect(r.messagesActions).toHaveLength(0);
  });
});

// ─── session_takeover ────────────────────────────────────────────────────────

describe('session_takeover', () => {
  it('produces SET_RUNNING false and ERROR message', () => {
    const cb = makeCallbacks();
    const r = parseServerMessage(
      { type: 'session_takeover', sessionId: 'sess-1' },
      makeState({ currentSessionId: 'sess-1' }),
      cb,
      POOL_KEY,
    );
    expect(r.messagesActions).toContainEqual({ type: 'SET_RUNNING', running: false });
    expect(r.messagesActions).toContainEqual(
      expect.objectContaining({ type: 'ERROR', error: expect.stringContaining('another device') }),
    );
  });
});

// ─── reconnected callback ────────────────────────────────────────────────────

describe('reconnected', () => {
  it('calls onReconnected callback', () => {
    const onReconnected = vi.fn();
    const cb = makeCallbacks({ onReconnected });
    parseServerMessage({ type: 'reconnected', sessions: [] }, makeState(), cb, POOL_KEY);
    expect(onReconnected).toHaveBeenCalled();
  });
});

// ─── error handling (session expired) ────────────────────────────────────────

describe('error with No conversation found', () => {
  it('does not call onSessionExpired — shows recoverable error instead', () => {
    const cb = makeCallbacks();
    const state = makeState({ currentSessionId: 'sess-1' });
    const r = parseServerMessage(
      { type: 'error', error: 'No conversation found for session' },
      state,
      cb,
      POOL_KEY,
    );
    expect(cb.onSessionExpired).not.toHaveBeenCalled();
    expect(r.messagesActions).toContainEqual(expect.objectContaining({ type: 'ERROR' }));
  });
});

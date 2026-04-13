import { describe, it, expect } from 'vitest';
import { chatMessagesReducer } from '../useChatMessages';
import type { ChatMessagesState } from '../useChatMessages';
import type { FinishedBlock } from '../../types/chat';

const INITIAL: ChatMessagesState = {
  messages: [],
  current: null,
  running: false,
  permission: null,
  branch: null,
  isWorktree: false,
  wtId: null,
  activeWorktrees: [],
};

// ─── MESSAGE_START ────────────────────────────────────────────────────────────

describe('MESSAGE_START', () => {
  it('creates an empty streaming message', () => {
    const state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    expect(state.current).not.toBeNull();
    expect(state.current!.messageId).toBe('msg-1');
    expect(state.current!.blockOrder).toHaveLength(0);
    expect(state.current!.blocks.size).toBe(0);
  });

  it('finalizes orphaned current into messages when a new message starts', () => {
    let state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
    });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
      delta: 'orphaned content',
    });
    // New message starts before old one got MESSAGE_END
    state = chatMessagesReducer(state, { type: 'MESSAGE_START', messageId: 'msg-2' });
    expect(state.current!.messageId).toBe('msg-2');
    expect(state.current!.blockOrder).toHaveLength(0);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].messageId).toBe('msg-1');
    expect(state.messages[0].blocks[0].content).toBe('orphaned content');
  });

  it('creates new current cleanly when no prior current exists', () => {
    const state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-2' });
    expect(state.current!.messageId).toBe('msg-2');
    expect(state.current!.blockOrder).toHaveLength(0);
    expect(state.messages).toHaveLength(0);
  });
});

// ─── BLOCK_START ──────────────────────────────────────────────────────────────

describe('BLOCK_START', () => {
  it('adds a block to current message', () => {
    let state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
    });
    expect(state.current!.blockOrder).toEqual(['b1']);
    expect(state.current!.blocks.get('b1')).toMatchObject({
      blockId: 'b1',
      blockType: 'text',
      content: '',
      done: false,
    });
  });

  it('preserves block order across multiple BLOCK_START calls', () => {
    let state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'thinking',
    });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b2',
      blockType: 'text',
    });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b3',
      blockType: 'tool_use',
    });
    expect(state.current!.blockOrder).toEqual(['b1', 'b2', 'b3']);
  });

  it('sets toolName on tool_use block when provided', () => {
    let state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Bash',
    });
    expect(state.current!.blocks.get('b1')!.toolName).toBe('Bash');
  });

  it('is a no-op when current is null', () => {
    const state = chatMessagesReducer(INITIAL, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
    });
    expect(state.current).toBeNull();
  });
});

// ─── BLOCK_DELTA ──────────────────────────────────────────────────────────────

describe('BLOCK_DELTA', () => {
  it('accumulates content on text blocks', () => {
    let state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
    });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
      delta: 'Hello',
    });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
      delta: ' world',
    });
    expect(state.current!.blocks.get('b1')!.content).toBe('Hello world');
  });

  it('accumulates thinking content', () => {
    let state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'thinking',
    });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'thinking',
      delta: 'Let me think',
    });
    expect(state.current!.blocks.get('b1')!.content).toBe('Let me think');
  });

  it('is a no-op for unknown blockId', () => {
    let state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
    });
    const before = state.current!.blocks.get('b1')!.content;
    state = chatMessagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'msg-1',
      blockId: 'unknown',
      blockType: 'text',
      delta: 'xyz',
    });
    expect(state.current!.blocks.get('b1')!.content).toBe(before);
  });
});

// ─── BLOCK_END ────────────────────────────────────────────────────────────────

describe('BLOCK_END', () => {
  it('marks block as done', () => {
    let state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
    });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
    });
    expect(state.current!.blocks.get('b1')!.done).toBe(true);
  });

  it('attaches toolName, toolId, and input for tool_use blocks', () => {
    let state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
    });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Bash',
      toolId: 'tool-1',
      input: 'echo hi',
    });
    const block = state.current!.blocks.get('b1')!;
    expect(block.done).toBe(true);
    expect(block.toolName).toBe('Bash');
    expect(block.toolId).toBe('tool-1');
    expect(block.toolInput).toBe('echo hi');
  });
});

// ─── TOOL_RESULT ──────────────────────────────────────────────────────────────

describe('TOOL_RESULT', () => {
  it('patches toolResult onto the matching block in current', () => {
    let state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
    });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Read',
      toolId: 'tool-1',
    });
    state = chatMessagesReducer(state, {
      type: 'TOOL_RESULT',
      toolId: 'tool-1',
      result: 'file contents',
      isError: false,
    });
    expect(state.current!.blocks.get('b1')!.toolResult).toBe('file contents');
    expect(state.current!.blocks.get('b1')!.toolError).toBe(false);
  });

  it('patches toolResult onto a finished message when tool is in messages[]', () => {
    // Simulate: turn 1 finishes with a tool block, tool result arrives after MESSAGE_END
    let state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
    });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Bash',
      toolId: 'tool-2',
    });
    state = chatMessagesReducer(state, { type: 'MESSAGE_END', messageId: 'msg-1' });
    // Tool result arrives after message is finished
    state = chatMessagesReducer(state, {
      type: 'TOOL_RESULT',
      toolId: 'tool-2',
      result: 'output',
      isError: false,
    });
    const msg = state.messages[0];
    expect(msg.blocks[0].toolResult).toBe('output');
  });

  it('sets toolError=true on error results', () => {
    let state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
    });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Bash',
      toolId: 'tool-err',
    });
    state = chatMessagesReducer(state, {
      type: 'TOOL_RESULT',
      toolId: 'tool-err',
      result: 'Error!',
      isError: true,
    });
    expect(state.current!.blocks.get('b1')!.toolError).toBe(true);
  });
});

// ─── MESSAGE_END ──────────────────────────────────────────────────────────────

describe('MESSAGE_END', () => {
  it('moves current to messages[] and clears current', () => {
    let state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
    });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
      delta: 'hi',
    });
    state = chatMessagesReducer(state, { type: 'MESSAGE_END', messageId: 'msg-1' });

    expect(state.current).toBeNull();
    expect(state.messages).toHaveLength(1);
    const msg = state.messages[0];
    expect(msg.messageId).toBe('msg-1');
    expect(msg.role).toBe('assistant');
    expect(msg.blocks[0].content).toBe('hi');
  });

  it('preserves block order in finished message', () => {
    let state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'thinking',
    });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b2',
      blockType: 'text',
    });
    state = chatMessagesReducer(state, { type: 'MESSAGE_END', messageId: 'msg-1' });

    expect(state.messages[0].blocks.map((b) => b.blockId)).toEqual(['b1', 'b2']);
  });

  it('is a no-op when current is null', () => {
    const state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_END', messageId: 'msg-1' });
    expect(state.messages).toHaveLength(0);
  });
});

// ─── SESSION_END ──────────────────────────────────────────────────────────────

describe('SESSION_END', () => {
  it('sets running=false', () => {
    const running = { ...INITIAL, running: true };
    const state = chatMessagesReducer(running, { type: 'SESSION_END' });
    expect(state.running).toBe(false);
  });

  it('force-finalizes current into messages if session ends with in-flight message', () => {
    let state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-orphan' });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-orphan',
      blockId: 'b1',
      blockType: 'text',
    });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'msg-orphan',
      blockId: 'b1',
      blockType: 'text',
      delta: 'partial text',
    });
    // SESSION_END without MESSAGE_END — current should be force-finalized
    state = chatMessagesReducer(state, { type: 'SESSION_END' });
    expect(state.current).toBeNull();
    expect(state.running).toBe(false);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].messageId).toBe('msg-orphan');
    expect(state.messages[0].blocks[0].content).toBe('partial text');
  });
});

// ─── MESSAGE_SNAPSHOT ─────────────────────────────────────────────────────────

describe('MESSAGE_SNAPSHOT', () => {
  it('reconstructs current from snapshot on reattach', () => {
    const blocks: FinishedBlock[] = [
      { blockId: 'b1', blockType: 'text', content: 'partial text' },
      {
        blockId: 'b2',
        blockType: 'tool_use',
        content: '',
        toolName: 'Read',
        toolId: 'tool-1',
        toolInput: 'somefile',
      },
    ];

    const state = chatMessagesReducer(INITIAL, {
      type: 'MESSAGE_SNAPSHOT',
      messageId: 'msg-snap',
      blocks,
    });

    expect(state.current).not.toBeNull();
    expect(state.current!.messageId).toBe('msg-snap');
    expect(state.current!.blockOrder).toEqual(['b1', 'b2']);
    expect(state.current!.blocks.get('b1')!.content).toBe('partial text');
    expect(state.current!.blocks.get('b2')!.toolName).toBe('Read');
  });

  it('is a no-op when blocks is undefined', () => {
    const state = chatMessagesReducer(INITIAL, {
      type: 'MESSAGE_SNAPSHOT',
      messageId: 'msg-snap',
      blocks: undefined as unknown as FinishedBlock[],
    });
    expect(state.current).toBeNull();
  });

  it('is a no-op when blocks is null', () => {
    const state = chatMessagesReducer(INITIAL, {
      type: 'MESSAGE_SNAPSHOT',
      messageId: 'msg-snap',
      blocks: null as unknown as FinishedBlock[],
    });
    expect(state.current).toBeNull();
  });

  it('replaces existing current on snapshot', () => {
    let state = chatMessagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-old' });
    state = chatMessagesReducer(state, {
      type: 'MESSAGE_SNAPSHOT',
      messageId: 'msg-snap',
      blocks: [{ blockId: 'b1', blockType: 'text', content: 'restored' }],
    });
    expect(state.current!.messageId).toBe('msg-snap');
  });
});

// ─── USER_SEND ────────────────────────────────────────────────────────────────

describe('USER_SEND', () => {
  it('adds user message and sets running=true', () => {
    const state = chatMessagesReducer(INITIAL, {
      type: 'USER_SEND',
      text: 'hello',
      clientMsgId: 'user-1-abc',
    });
    expect(state.running).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('user');
    expect(state.messages[0].blocks[0].content).toBe('hello');
  });

  it('appends user message when already running', () => {
    const running = { ...INITIAL, running: true };
    const state = chatMessagesReducer(running, {
      type: 'USER_SEND',
      text: 'follow-up',
      clientMsgId: 'user-2-def',
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('user');
    expect(state.messages[0].blocks[0].content).toBe('follow-up');
    expect(state.running).toBe(true);
  });

  it('stores image previews on the user message', () => {
    const state = chatMessagesReducer(INITIAL, {
      type: 'USER_SEND',
      text: 'look',
      clientMsgId: 'user-3-ghi',
      images: ['data:image/png;base64,...'],
    });
    expect(state.messages[0].images).toEqual(['data:image/png;base64,...']);
  });
});

// ─── RESTORE ──────────────────────────────────────────────────────────────────

describe('RESTORE', () => {
  it('restores valid v2 messages', () => {
    const messages = [
      {
        messageId: 'msg-1',
        role: 'user' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'hello' }],
      },
    ];
    const state = chatMessagesReducer(INITIAL, { type: 'RESTORE', messages });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].messageId).toBe('msg-1');
  });

  it('filters out v1-format messages missing messageId and blocks', () => {
    const legacyMessages = [
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi' },
    ] as unknown as import('../../types/chat').FinishedMessage[];
    const state = chatMessagesReducer(INITIAL, { type: 'RESTORE', messages: legacyMessages });
    expect(state.messages).toHaveLength(0);
  });

  it('keeps valid messages and drops invalid ones in a mixed array', () => {
    const mixed = [
      { role: 'user', text: 'old format' },
      {
        messageId: 'msg-2',
        role: 'assistant',
        blocks: [{ blockId: 'b1', blockType: 'text', content: 'valid' }],
      },
    ] as unknown as import('../../types/chat').FinishedMessage[];
    const state = chatMessagesReducer(INITIAL, { type: 'RESTORE', messages: mixed });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].messageId).toBe('msg-2');
  });
});

// ─── Multi-turn sequence ──────────────────────────────────────────────────────

describe('full turn sequence', () => {
  it('handles user → assistant turn with tool call correctly', () => {
    let state = INITIAL;

    // User sends
    state = chatMessagesReducer(state, {
      type: 'USER_SEND',
      text: 'list files',
      clientMsgId: 'user-4-jkl',
    });

    // Assistant turn starts
    state = chatMessagesReducer(state, { type: 'MESSAGE_START', messageId: 'msg-a' });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-a',
      blockId: 'b1',
      blockType: 'tool_use',
    });
    state = chatMessagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-a',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Bash',
      toolId: 'tool-ls',
    });
    state = chatMessagesReducer(state, {
      type: 'TOOL_RESULT',
      toolId: 'tool-ls',
      result: 'file1\nfile2',
      isError: false,
    });

    // Tool result patches block in current
    expect(state.current!.blocks.get('b1')!.toolResult).toBe('file1\nfile2');

    // Message ends
    state = chatMessagesReducer(state, { type: 'MESSAGE_END', messageId: 'msg-a' });
    expect(state.current).toBeNull();
    expect(state.messages).toHaveLength(2); // user + assistant

    // Session ends
    state = chatMessagesReducer(state, { type: 'SESSION_END' });
    expect(state.running).toBe(false);

    // Tool result preserved in finished message
    const assistantMsg = state.messages[1];
    expect(assistantMsg.blocks[0].toolResult).toBe('file1\nfile2');
  });
});

// ─── SESSION_INFO ────────────────────────────────────────────────────────────

describe('SESSION_INFO', () => {
  it('sets branch, isWorktree, and wtId', () => {
    const state = chatMessagesReducer(INITIAL, {
      type: 'SESSION_INFO',
      branch: 'session/2026-04-13-a3f2b1',
      isWorktree: true,
      wtId: '2026-04-13-a3f2b1',
    });
    expect(state.branch).toBe('session/2026-04-13-a3f2b1');
    expect(state.isWorktree).toBe(true);
    expect(state.wtId).toBe('2026-04-13-a3f2b1');
  });

  it('preserves existing wtId when new action omits it', () => {
    let state = chatMessagesReducer(INITIAL, {
      type: 'SESSION_INFO',
      branch: 'session/2026-04-13-a3f2b1',
      isWorktree: true,
      wtId: '2026-04-13-a3f2b1',
    });
    state = chatMessagesReducer(state, {
      type: 'SESSION_INFO',
      branch: 'session/2026-04-13-a3f2b1',
      isWorktree: true,
    });
    expect(state.wtId).toBe('2026-04-13-a3f2b1');
  });

  it('sets branch without wtId for non-worktree sessions', () => {
    const state = chatMessagesReducer(INITIAL, {
      type: 'SESSION_INFO',
      branch: 'main',
      isWorktree: false,
    });
    expect(state.branch).toBe('main');
    expect(state.isWorktree).toBe(false);
    expect(state.wtId).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { messagesReducer, finishCurrent, INITIAL_MESSAGES_STATE } from '../src/slices/messages.js';
import type { MessagesState } from '../src/slices/messages.js';
import type { FinishedBlock, FinishedSubagentState, StreamingMessage } from '@mitzo/protocol';

const INITIAL = INITIAL_MESSAGES_STATE;

// ─── MESSAGE_START ────────────────────────────────────────────────────────────

describe('MESSAGE_START', () => {
  it('creates an empty streaming message', () => {
    const state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    expect(state.current).not.toBeNull();
    expect(state.current!.messageId).toBe('msg-1');
    expect(state.current!.blockOrder).toHaveLength(0);
    expect(state.current!.blocks.size).toBe(0);
  });

  it('finalizes orphaned current into messages when a new message starts', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
      delta: 'orphaned content',
    });
    state = messagesReducer(state, { type: 'MESSAGE_START', messageId: 'msg-2' });
    expect(state.current!.messageId).toBe('msg-2');
    expect(state.current!.blockOrder).toHaveLength(0);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].messageId).toBe('msg-1');
    expect(state.messages[0].blocks[0].content).toBe('orphaned content');
  });

  it('creates new current cleanly when no prior current exists', () => {
    const state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-2' });
    expect(state.current!.messageId).toBe('msg-2');
    expect(state.current!.blockOrder).toHaveLength(0);
    expect(state.messages).toHaveLength(0);
  });
});

// ─── BLOCK_START ──────────────────────────────────────────────────────────────

describe('BLOCK_START', () => {
  it('adds a block to current message', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
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
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'thinking',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b2',
      blockType: 'text',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b3',
      blockType: 'tool_use',
    });
    expect(state.current!.blockOrder).toEqual(['b1', 'b2', 'b3']);
  });

  it('sets toolName on tool_use block when provided', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Bash',
    });
    expect(state.current!.blocks.get('b1')!.toolName).toBe('Bash');
  });

  it('is a no-op when current is null', () => {
    const state = messagesReducer(INITIAL, {
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
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
      delta: 'Hello',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
      delta: ' world',
    });
    expect(state.current!.blocks.get('b1')!.content).toBe('Hello world');
  });

  it('accumulates thinking content', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'thinking',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'thinking',
      delta: 'Let me think',
    });
    expect(state.current!.blocks.get('b1')!.content).toBe('Let me think');
  });

  it('is a no-op for unknown blockId', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
    });
    const before = state.current!.blocks.get('b1')!.content;
    state = messagesReducer(state, {
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
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
    });
    expect(state.current!.blocks.get('b1')!.done).toBe(true);
  });

  it('attaches toolName, toolId, and input for tool_use blocks', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
    });
    state = messagesReducer(state, {
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
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Read',
      toolId: 'tool-1',
    });
    state = messagesReducer(state, {
      type: 'TOOL_RESULT',
      toolId: 'tool-1',
      result: 'file contents',
      isError: false,
    });
    expect(state.current!.blocks.get('b1')!.toolResult).toBe('file contents');
    expect(state.current!.blocks.get('b1')!.toolError).toBe(false);
  });

  it('patches toolResult onto a finished message when tool is in messages[]', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Bash',
      toolId: 'tool-2',
    });
    state = messagesReducer(state, { type: 'MESSAGE_END', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'TOOL_RESULT',
      toolId: 'tool-2',
      result: 'output',
      isError: false,
    });
    const msg = state.messages[0];
    expect(msg.blocks[0].toolResult).toBe('output');
  });

  it('sets toolError=true on error results', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Bash',
      toolId: 'tool-err',
    });
    state = messagesReducer(state, {
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
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'text',
      delta: 'hi',
    });
    state = messagesReducer(state, { type: 'MESSAGE_END', messageId: 'msg-1' });

    expect(state.current).toBeNull();
    expect(state.messages).toHaveLength(1);
    const msg = state.messages[0];
    expect(msg.messageId).toBe('msg-1');
    expect(msg.role).toBe('assistant');
    expect(msg.blocks[0].content).toBe('hi');
  });

  it('preserves block order in finished message', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'thinking',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b2',
      blockType: 'text',
    });
    state = messagesReducer(state, { type: 'MESSAGE_END', messageId: 'msg-1' });

    expect(state.messages[0].blocks.map((b) => b.blockId)).toEqual(['b1', 'b2']);
  });

  it('is a no-op when current is null', () => {
    const state = messagesReducer(INITIAL, { type: 'MESSAGE_END', messageId: 'msg-1' });
    expect(state.messages).toHaveLength(0);
  });
});

// ─── SESSION_END ──────────────────────────────────────────────────────────────

describe('SESSION_END', () => {
  it('sets running=false', () => {
    const running = { ...INITIAL, running: true };
    const state = messagesReducer(running, { type: 'SESSION_END' });
    expect(state.running).toBe(false);
  });

  it('force-finalizes current into messages if session ends with in-flight message', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-orphan' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-orphan',
      blockId: 'b1',
      blockType: 'text',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'msg-orphan',
      blockId: 'b1',
      blockType: 'text',
      delta: 'partial text',
    });
    state = messagesReducer(state, { type: 'SESSION_END' });
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

    const state = messagesReducer(INITIAL, {
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
    const state = messagesReducer(INITIAL, {
      type: 'MESSAGE_SNAPSHOT',
      messageId: 'msg-snap',
      blocks: undefined as unknown as FinishedBlock[],
    });
    expect(state.current).toBeNull();
  });

  it('is a no-op when blocks is null', () => {
    const state = messagesReducer(INITIAL, {
      type: 'MESSAGE_SNAPSHOT',
      messageId: 'msg-snap',
      blocks: null as unknown as FinishedBlock[],
    });
    expect(state.current).toBeNull();
  });

  it('replaces existing current on snapshot', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-old' });
    state = messagesReducer(state, {
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
    const state = messagesReducer(INITIAL, {
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
    const state = messagesReducer(running, {
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
    const state = messagesReducer(INITIAL, {
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
    const state = messagesReducer(INITIAL, { type: 'RESTORE', messages });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].messageId).toBe('msg-1');
  });

  it('filters out v1-format messages missing messageId and blocks', () => {
    const legacyMessages = [
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi' },
    ] as unknown as import('@mitzo/protocol').FinishedMessage[];
    const state = messagesReducer(INITIAL, { type: 'RESTORE', messages: legacyMessages });
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
    ] as unknown as import('@mitzo/protocol').FinishedMessage[];
    const state = messagesReducer(INITIAL, { type: 'RESTORE', messages: mixed });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].messageId).toBe('msg-2');
  });

  it('with interrupted flag appends a notice message', () => {
    const msgs = [
      {
        messageId: 'm1',
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'hi' }],
      },
    ];
    const result = messagesReducer(INITIAL, {
      type: 'RESTORE',
      messages: msgs,
      interrupted: true,
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].messageId).toBe('m1');
    const notice = result.messages[1];
    expect(notice.role).toBe('assistant');
    expect(notice.blocks[0].content).toContain('interrupted');
  });

  it('without interrupted flag does not append notice', () => {
    const msgs = [
      {
        messageId: 'm1',
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'hi' }],
      },
    ];
    const result = messagesReducer(INITIAL, { type: 'RESTORE', messages: msgs });
    expect(result.messages).toHaveLength(1);
  });

  it('does not replace when state already has all incoming messages', () => {
    const existing: MessagesState = {
      ...INITIAL,
      messages: [
        {
          messageId: 'm1',
          role: 'assistant',
          blocks: [{ blockId: 'b1', blockType: 'text', content: 'first' }],
        },
        {
          messageId: 'm2',
          role: 'user',
          blocks: [{ blockId: 'b2', blockType: 'text', content: 'second' }],
        },
        {
          messageId: 'm3',
          role: 'assistant',
          blocks: [{ blockId: 'b3', blockType: 'text', content: 'third' }],
        },
      ],
    };
    const apiMsgs = [
      {
        messageId: 'm1',
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'first' }],
      },
    ];
    const result = messagesReducer(existing, { type: 'RESTORE', messages: apiMsgs });
    expect(result.messages).toHaveLength(3);
  });

  it('replaces when incoming has new messages', () => {
    const existing: MessagesState = {
      ...INITIAL,
      messages: [
        {
          messageId: 'm1',
          role: 'assistant',
          blocks: [{ blockId: 'b1', blockType: 'text', content: 'first' }],
        },
      ],
    };
    const apiMsgs = [
      {
        messageId: 'm1',
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'first' }],
      },
      {
        messageId: 'm2',
        role: 'user' as const,
        blocks: [{ blockId: 'b2', blockType: 'text' as const, content: 'second' }],
      },
    ];
    const result = messagesReducer(existing, { type: 'RESTORE', messages: apiMsgs });
    expect(result.messages).toHaveLength(2);
  });
});

// ─── RESTORE with interrupted — optimistic message preservation ──────────────

describe('RESTORE with interrupted preserves optimistic user messages', () => {
  it('merges optimistic user sends not present in restored set', () => {
    const stateWithOptimistic: MessagesState = {
      ...INITIAL,
      messages: [
        {
          messageId: 'user-1234',
          role: 'user',
          blocks: [{ blockId: 'user-text-1234', blockType: 'text', content: 'my question' }],
        },
        {
          messageId: 'a1',
          role: 'assistant',
          blocks: [{ blockId: 'b1', blockType: 'text', content: 'response' }],
        },
        {
          messageId: 'user-5678',
          role: 'user',
          blocks: [{ blockId: 'user-text-5678', blockType: 'text', content: 'follow-up' }],
        },
      ],
    };

    const restoredMsgs = [
      {
        messageId: 'user-1234' as string,
        role: 'user' as const,
        blocks: [{ blockId: 'user-text-1234', blockType: 'text' as const, content: 'my question' }],
      },
      {
        messageId: 'a1' as string,
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'response' }],
      },
    ];

    const result = messagesReducer(stateWithOptimistic, {
      type: 'RESTORE',
      messages: restoredMsgs,
      interrupted: true,
    });

    const userMsgs = result.messages.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(2);
    expect(userMsgs.some((m) => m.messageId === 'user-5678')).toBe(true);

    const ids = result.messages.map((m) => m.messageId);
    const optimisticIdx = ids.indexOf('user-5678');
    const a1Idx = ids.indexOf('a1');
    expect(optimisticIdx).toBeGreaterThan(a1Idx);

    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect(lastMsg.blocks[0].content).toContain('interrupted');
    expect(result.messages).toHaveLength(4);
  });

  it('does not duplicate user messages already in restored set', () => {
    const stateWithOptimistic: MessagesState = {
      ...INITIAL,
      messages: [
        {
          messageId: 'user-1234',
          role: 'user',
          blocks: [{ blockId: 'user-text-1234', blockType: 'text', content: 'question' }],
        },
      ],
    };

    const restoredMsgs = [
      {
        messageId: 'user-1234' as string,
        role: 'user' as const,
        blocks: [{ blockId: 'user-text-1234', blockType: 'text' as const, content: 'question' }],
      },
      {
        messageId: 'a1' as string,
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'answer' }],
      },
    ];

    const result = messagesReducer(stateWithOptimistic, {
      type: 'RESTORE',
      messages: restoredMsgs,
      interrupted: true,
    });

    const user1234 = result.messages.filter((m) => m.messageId === 'user-1234');
    expect(user1234).toHaveLength(1);
  });

  it('does not merge assistant messages as optimistic', () => {
    const stateWithOrphan: MessagesState = {
      ...INITIAL,
      messages: [
        {
          messageId: 'orphan-assistant',
          role: 'assistant',
          blocks: [{ blockId: 'ob1', blockType: 'text', content: 'stale' }],
        },
      ],
    };

    const restoredMsgs = [
      {
        messageId: 'a1' as string,
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'fresh' }],
      },
    ];

    const result = messagesReducer(stateWithOrphan, {
      type: 'RESTORE',
      messages: restoredMsgs,
      interrupted: true,
    });

    const nonNoticeAssistantMsgs = result.messages.filter(
      (m) => m.role === 'assistant' && m.messageId === 'a1',
    );
    expect(nonNoticeAssistantMsgs).toHaveLength(1);
    expect(result.messages.some((m) => m.messageId === 'orphan-assistant')).toBe(false);
  });
});

// ─── USER_MESSAGE_RECEIVED deduplication ─────────────────────────────────────

describe('USER_MESSAGE_RECEIVED deduplication', () => {
  it('adds user message when not already present', () => {
    const result = messagesReducer(INITIAL, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'umsg-100',
      text: 'hello',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].messageId).toBe('umsg-100');
    expect(result.messages[0].role).toBe('user');
  });

  it('skips duplicate when message with same ID already exists', () => {
    const stateWithMsg: MessagesState = {
      ...INITIAL,
      messages: [
        {
          messageId: 'umsg-100',
          role: 'user',
          blocks: [{ blockId: 'ut', blockType: 'text', content: 'hello' }],
        },
      ],
    };
    const result = messagesReducer(stateWithMsg, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'umsg-100',
      text: 'hello',
    });
    expect(result.messages).toHaveLength(1);
    expect(result).toBe(stateWithMsg);
  });

  it('skips duplicate when ID collides with an existing assistant message', () => {
    const stateWithAssistant: MessagesState = {
      ...INITIAL,
      messages: [
        {
          messageId: 'shared-id',
          role: 'assistant',
          blocks: [{ blockId: 'ab1', blockType: 'text', content: 'response' }],
        },
      ],
    };
    const result = messagesReducer(stateWithAssistant, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'shared-id',
      text: 'hello',
    });
    expect(result.messages).toHaveLength(1);
    expect(result).toBe(stateWithAssistant);
  });

  it('adds message with different ID even if text is identical', () => {
    const stateWithMsg: MessagesState = {
      ...INITIAL,
      messages: [
        {
          messageId: 'umsg-100',
          role: 'user',
          blocks: [{ blockId: 'ut', blockType: 'text', content: 'hello' }],
        },
      ],
    };
    const result = messagesReducer(stateWithMsg, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'umsg-200',
      text: 'hello',
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].messageId).toBe('umsg-200');
  });

  it('deduplicates when server echoes back the same clientMsgId', () => {
    const clientMsgId = 'user-1234-abc';
    const afterSend = messagesReducer(INITIAL, {
      type: 'USER_SEND',
      text: "Yep. Let's go",
      clientMsgId,
    });
    expect(afterSend.messages).toHaveLength(1);
    expect(afterSend.messages[0].messageId).toBe(clientMsgId);

    const afterEcho = messagesReducer(afterSend, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: clientMsgId,
      text: "Yep. Let's go",
    });
    expect(afterEcho.messages).toHaveLength(1);
    expect(afterEcho).toBe(afterSend);
  });

  it('handles duplicate text sent twice with different clientMsgIds', () => {
    const afterSend1 = messagesReducer(INITIAL, {
      type: 'USER_SEND',
      text: 'hello',
      clientMsgId: 'user-1-aaa',
    });
    const afterSend2 = messagesReducer(afterSend1, {
      type: 'USER_SEND',
      text: 'hello',
      clientMsgId: 'user-2-bbb',
    });
    expect(afterSend2.messages).toHaveLength(2);

    const afterEcho1 = messagesReducer(afterSend2, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'user-1-aaa',
      text: 'hello',
    });
    expect(afterEcho1.messages).toHaveLength(2);
    const afterEcho2 = messagesReducer(afterEcho1, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'user-2-bbb',
      text: 'hello',
    });
    expect(afterEcho2.messages).toHaveLength(2);
  });

  it('adds server message when no optimistic message exists (reconnect)', () => {
    const result = messagesReducer(INITIAL, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'user-500-xyz',
      text: 'reconnected message',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].messageId).toBe('user-500-xyz');
  });
});

// ─── SESSION_INFO ────────────────────────────────────────────────────────────

describe('SESSION_INFO', () => {
  it('sets branch, isWorktree, and wtId', () => {
    const state = messagesReducer(INITIAL, {
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
    let state = messagesReducer(INITIAL, {
      type: 'SESSION_INFO',
      branch: 'session/2026-04-13-a3f2b1',
      isWorktree: true,
      wtId: '2026-04-13-a3f2b1',
    });
    state = messagesReducer(state, {
      type: 'SESSION_INFO',
      branch: 'session/2026-04-13-a3f2b1',
      isWorktree: true,
    });
    expect(state.wtId).toBe('2026-04-13-a3f2b1');
  });

  it('sets branch without wtId for non-worktree sessions', () => {
    const state = messagesReducer(INITIAL, {
      type: 'SESSION_INFO',
      branch: 'main',
      isWorktree: false,
    });
    expect(state.branch).toBe('main');
    expect(state.isWorktree).toBe(false);
    expect(state.wtId).toBeNull();
  });
});

// ─── WORKTREE_OPENED ────────────────────────────────────────────────────────

describe('WORKTREE_OPENED', () => {
  it('adds a new worktree to activeWorktrees', () => {
    const result = messagesReducer(INITIAL, {
      type: 'WORKTREE_OPENED',
      repoName: 'team_home',
      path: '/tmp/team_home-sessions/session-wt-123',
    });
    expect(result.activeWorktrees).toHaveLength(1);
    expect(result.activeWorktrees[0]).toEqual({
      repoName: 'team_home',
      path: '/tmp/team_home-sessions/session-wt-123',
    });
  });

  it('ignores duplicate repo (first-write-wins)', () => {
    const state1 = messagesReducer(INITIAL, {
      type: 'WORKTREE_OPENED',
      repoName: 'team_home',
      path: '/tmp/team_home-sessions/session-wt-123',
    });
    const state2 = messagesReducer(state1, {
      type: 'WORKTREE_OPENED',
      repoName: 'team_home',
      path: '/tmp/team_home-sessions/session-wt-456',
    });
    expect(state2.activeWorktrees).toHaveLength(1);
    expect(state2.activeWorktrees[0].path).toBe('/tmp/team_home-sessions/session-wt-123');
    expect(state2).toBe(state1);
  });

  it('tracks multiple repos', () => {
    const state1 = messagesReducer(INITIAL, {
      type: 'WORKTREE_OPENED',
      repoName: 'mgmt',
      path: '/tmp/mgmt-sessions/session-wt-1',
    });
    const state2 = messagesReducer(state1, {
      type: 'WORKTREE_OPENED',
      repoName: 'team_home',
      path: '/tmp/team_home-sessions/session-wt-2',
    });
    expect(state2.activeWorktrees).toHaveLength(2);
  });
});

// ─── CLEAR ──────────────────────────────────────────────────────────────────

describe('CLEAR', () => {
  it('resets state to initial', () => {
    const populated: MessagesState = {
      ...INITIAL,
      messages: [
        {
          messageId: 'm1',
          role: 'assistant',
          blocks: [{ blockId: 'b1', blockType: 'text', content: 'hello' }],
        },
      ],
      running: true,
      branch: 'main',
    };
    const result = messagesReducer(populated, { type: 'CLEAR' });
    expect(result.messages).toHaveLength(0);
    expect(result.current).toBeNull();
    expect(result.running).toBe(false);
    expect(result.branch).toBeNull();
  });
});

// ─── Timestamps on synthesized messages ────────────────────────────────────

describe('synthesized messages include numeric timestamp', () => {
  it('finishCurrent() sets a numeric timestamp', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-ts' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-ts',
      blockId: 'b1',
      blockType: 'text',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'msg-ts',
      blockId: 'b1',
      blockType: 'text',
      delta: 'content',
    });
    state = messagesReducer(state, { type: 'MESSAGE_END', messageId: 'msg-ts' });
    expect(typeof state.messages[0].timestamp).toBe('number');
  });

  it('ERROR action produces a message with numeric timestamp', () => {
    const state = messagesReducer(INITIAL, { type: 'ERROR', error: 'boom' });
    const errMsg = state.messages[state.messages.length - 1];
    expect(typeof errMsg.timestamp).toBe('number');
  });

  it('NATIVE_COMMAND_RESULT produces a message with numeric timestamp', () => {
    const state = messagesReducer(INITIAL, {
      type: 'NATIVE_COMMAND_RESULT',
      command: 'test',
      content: 'result',
    });
    expect(typeof state.messages[0].timestamp).toBe('number');
  });

  it('USER_SEND produces a message with numeric timestamp', () => {
    const state = messagesReducer(INITIAL, {
      type: 'USER_SEND',
      text: 'hello',
      clientMsgId: 'user-ts-1',
    });
    expect(typeof state.messages[0].timestamp).toBe('number');
  });

  it('USER_MESSAGE_RECEIVED produces a message with numeric timestamp', () => {
    const state = messagesReducer(INITIAL, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'umsg-ts-1',
      text: 'hi',
    });
    expect(typeof state.messages[0].timestamp).toBe('number');
  });

  it('CONNECTION_LOST produces a message with numeric timestamp', () => {
    const state = messagesReducer(INITIAL, { type: 'CONNECTION_LOST' });
    expect(typeof state.messages[0].timestamp).toBe('number');
  });
});

// ─── Full turn sequence ──────────────────────────────────────────────────────

describe('full turn sequence', () => {
  it('handles user -> assistant turn with tool call correctly', () => {
    let state = INITIAL;

    state = messagesReducer(state, {
      type: 'USER_SEND',
      text: 'list files',
      clientMsgId: 'user-4-jkl',
    });

    state = messagesReducer(state, { type: 'MESSAGE_START', messageId: 'msg-a' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-a',
      blockId: 'b1',
      blockType: 'tool_use',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-a',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Bash',
      toolId: 'tool-ls',
    });
    state = messagesReducer(state, {
      type: 'TOOL_RESULT',
      toolId: 'tool-ls',
      result: 'file1\nfile2',
      isError: false,
    });

    expect(state.current!.blocks.get('b1')!.toolResult).toBe('file1\nfile2');

    state = messagesReducer(state, { type: 'MESSAGE_END', messageId: 'msg-a' });
    expect(state.current).toBeNull();
    expect(state.messages).toHaveLength(2);

    state = messagesReducer(state, { type: 'SESSION_END' });
    expect(state.running).toBe(false);

    const assistantMsg = state.messages[1];
    expect(assistantMsg.blocks[0].toolResult).toBe('file1\nfile2');
  });
});

// ─── ERROR ──────────────────────────────────────────────────────────────────

describe('ERROR', () => {
  it('clears running and current state', () => {
    let state = messagesReducer(INITIAL, { type: 'USER_SEND', text: 'hello', clientMsgId: 'c1' });
    expect(state.running).toBe(true);

    state = messagesReducer(state, { type: 'MESSAGE_START', messageId: 'msg-1' });
    expect(state.current).not.toBeNull();

    state = messagesReducer(state, { type: 'ERROR', error: 'Something went wrong' });
    expect(state.running).toBe(false);
    expect(state.current).toBeNull();
  });

  it('appends an error message to the list', () => {
    let state = messagesReducer(INITIAL, { type: 'USER_SEND', text: 'hello', clientMsgId: 'c1' });
    const msgCount = state.messages.length;
    state = messagesReducer(state, { type: 'ERROR', error: 'fail' });
    expect(state.messages.length).toBe(msgCount + 1);
    expect(state.messages[state.messages.length - 1].blocks[0].content).toContain('fail');
  });
});

// ─── CONNECTION_LOST ────────────────────────────────────────────────────────

describe('CONNECTION_LOST', () => {
  it('appends a connection lost message without clearing running', () => {
    let state = messagesReducer(INITIAL, { type: 'USER_SEND', text: 'hello', clientMsgId: 'c1' });
    const msgCount = state.messages.length;

    state = messagesReducer(state, { type: 'CONNECTION_LOST' });
    expect(state.messages.length).toBe(msgCount + 1);
    expect(state.messages[state.messages.length - 1].blocks[0].content).toContain(
      'Connection lost',
    );
  });
});

// ─── finishCurrent (subagent preservation) ──────────────────────────────────

describe('finishCurrent', () => {
  it('preserves the subagent field when converting StreamingBlock to FinishedBlock', () => {
    const subagentState = {
      messageId: 'sub-msg-1',
      blocks: new Map([
        [
          'sub-b1',
          {
            blockId: 'sub-b1',
            blockType: 'text' as const,
            content: 'subagent output',
            done: true,
          },
        ],
      ]),
      blockOrder: ['sub-b1'],
      running: true as const,
    };

    const current: StreamingMessage = {
      messageId: 'msg-1',
      blocks: new Map([
        [
          'b1',
          {
            blockId: 'b1',
            blockType: 'tool_use' as const,
            content: '',
            done: true,
            toolName: 'Agent',
            subagent: subagentState,
          },
        ],
      ]),
      blockOrder: ['b1'],
    };

    const finished = finishCurrent(current);
    const sub = finished.blocks[0].subagent as FinishedSubagentState;
    expect(sub).toBeDefined();
    expect(sub.messageId).toBe('sub-msg-1');
    // Verify streaming Map was converted to finished array
    expect(Array.isArray(sub.blocks)).toBe(true);
    expect(sub.blocks).toHaveLength(1);
    expect(sub.blocks[0].content).toBe('subagent output');
  });

  it('works normally when subagent field is absent', () => {
    const current: StreamingMessage = {
      messageId: 'msg-2',
      blocks: new Map([
        [
          'b1',
          {
            blockId: 'b1',
            blockType: 'text' as const,
            content: 'hello',
            done: true,
          },
        ],
      ]),
      blockOrder: ['b1'],
    };

    const finished = finishCurrent(current);
    expect(finished.blocks[0].subagent).toBeUndefined();
    expect(finished.blocks[0].content).toBe('hello');
  });
});

// ─── NATIVE_COMMAND_RESULT ──────────────────────────────────────────────────

describe('NATIVE_COMMAND_RESULT', () => {
  it('appends a native command result message', () => {
    const state = messagesReducer(INITIAL, {
      type: 'NATIVE_COMMAND_RESULT',
      command: 'skills',
      content: 'Available skills: none',
    });
    expect(state.messages.length).toBe(1);
    const msg = state.messages[0];
    expect(msg.role).toBe('assistant');
    expect(msg.blocks.length).toBe(1);
    expect(msg.blocks[0].content).toContain('Available skills');
  });
});

// ─── SET_BOOT_CONTEXT ────────────────────────────────────────────────────────

describe('SET_BOOT_CONTEXT', () => {
  it('sets bootContext from null', () => {
    const meta = {
      source: 'contexgin' as const,
      sourceCount: 5,
      tokenCount: 3200,
      trimmedCount: 1,
      sources: ['CLAUDE.md', 'CONSTITUTION.md'],
    };
    const state = messagesReducer(INITIAL, { type: 'SET_BOOT_CONTEXT', bootContext: meta });
    expect(state.bootContext).toEqual(meta);
  });

  it('overwrites existing bootContext', () => {
    const first = {
      source: 'local-fallback' as const,
      sourceCount: 0,
      tokenCount: 0,
      trimmedCount: 0,
      sources: [] as string[],
    };
    const second = {
      source: 'contexgin' as const,
      sourceCount: 3,
      tokenCount: 1500,
      trimmedCount: 0,
      sources: ['a.md'],
    };
    let state = messagesReducer(INITIAL, { type: 'SET_BOOT_CONTEXT', bootContext: first });
    state = messagesReducer(state, { type: 'SET_BOOT_CONTEXT', bootContext: second });
    expect(state.bootContext).toEqual(second);
  });

  it('is cleared by CLEAR', () => {
    const meta = {
      source: 'contexgin' as const,
      sourceCount: 2,
      tokenCount: 1000,
      trimmedCount: 0,
      sources: ['a.md'],
    };
    let state = messagesReducer(INITIAL, { type: 'SET_BOOT_CONTEXT', bootContext: meta });
    state = messagesReducer(state, { type: 'CLEAR' });
    expect(state.bootContext).toBeNull();
  });
});

// ─── Dedup: foreground recovery vs WS replay ────────────────────────────────

describe('MESSAGE_START dedup', () => {
  it('skips if messageId already exists in finished messages', () => {
    const state: MessagesState = {
      ...INITIAL,
      messages: [
        {
          messageId: 'msg-1',
          role: 'assistant',
          blocks: [{ blockId: 'b1', blockType: 'text', content: 'done' }],
        },
      ],
    };
    const next = messagesReducer(state, { type: 'MESSAGE_START', messageId: 'msg-1' });
    expect(next.current).toBeNull();
    expect(next.messages).toHaveLength(1);
  });

  it('allows MESSAGE_START for a new messageId', () => {
    const state: MessagesState = {
      ...INITIAL,
      messages: [
        {
          messageId: 'msg-1',
          role: 'assistant',
          blocks: [{ blockId: 'b1', blockType: 'text', content: 'done' }],
        },
      ],
    };
    const next = messagesReducer(state, { type: 'MESSAGE_START', messageId: 'msg-2' });
    expect(next.current).not.toBeNull();
    expect(next.current!.messageId).toBe('msg-2');
  });
});

describe('MESSAGE_END dedup', () => {
  it('discards current without appending if messageId already in messages', () => {
    const state: MessagesState = {
      ...INITIAL,
      messages: [
        {
          messageId: 'msg-1',
          role: 'assistant',
          blocks: [{ blockId: 'b1', blockType: 'text', content: 'restored' }],
        },
      ],
      current: {
        messageId: 'msg-1',
        blocks: new Map([
          ['b2', { blockId: 'b2', blockType: 'text', content: 'streaming', done: true }],
        ]),
        blockOrder: ['b2'],
      },
    };
    const next = messagesReducer(state, { type: 'MESSAGE_END', messageId: 'msg-1' });
    expect(next.current).toBeNull();
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].blocks[0].content).toBe('restored');
  });

  it('appends normally when messageId is new', () => {
    const state: MessagesState = {
      ...INITIAL,
      current: {
        messageId: 'msg-2',
        blocks: new Map([['b1', { blockId: 'b1', blockType: 'text', content: 'new', done: true }]]),
        blockOrder: ['b1'],
      },
    };
    const next = messagesReducer(state, { type: 'MESSAGE_END', messageId: 'msg-2' });
    expect(next.current).toBeNull();
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].messageId).toBe('msg-2');
  });
});

describe('RESTORE clears stale current', () => {
  it('nullifies current when its messageId is in the restored set', () => {
    const state: MessagesState = {
      ...INITIAL,
      current: {
        messageId: 'msg-1',
        blocks: new Map(),
        blockOrder: [],
      },
    };
    const restored = [
      {
        messageId: 'msg-1',
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'done' }],
      },
    ];
    const next = messagesReducer(state, { type: 'RESTORE', messages: restored });
    expect(next.current).toBeNull();
    expect(next.messages).toHaveLength(1);
  });

  it('preserves current when its messageId is NOT in the restored set', () => {
    const state: MessagesState = {
      ...INITIAL,
      current: {
        messageId: 'msg-new',
        blocks: new Map(),
        blockOrder: [],
      },
    };
    const restored = [
      {
        messageId: 'msg-old',
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'done' }],
      },
    ];
    const next = messagesReducer(state, { type: 'RESTORE', messages: restored });
    expect(next.current).not.toBeNull();
    expect(next.current!.messageId).toBe('msg-new');
  });

  it('nullifies current in interrupted RESTORE too', () => {
    const state: MessagesState = {
      ...INITIAL,
      current: {
        messageId: 'msg-1',
        blocks: new Map(),
        blockOrder: [],
      },
    };
    const restored = [
      {
        messageId: 'msg-1',
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'done' }],
      },
    ];
    const next = messagesReducer(state, { type: 'RESTORE', messages: restored, interrupted: true });
    expect(next.current).toBeNull();
  });

  it('interrupted RESTORE with optimistic user msgs AND stale current', () => {
    // Simulate: user sent a follow-up (optimistic), assistant was streaming,
    // then interrupted RESTORE arrives with the completed assistant message.
    const state: MessagesState = {
      ...INITIAL,
      messages: [
        {
          messageId: 'restored-1',
          role: 'assistant' as const,
          blocks: [{ blockId: 'a1', blockType: 'text' as const, content: 'first reply' }],
        },
        {
          messageId: 'user-optimistic',
          role: 'user' as const,
          blocks: [{ blockId: 'u1', blockType: 'text' as const, content: 'follow-up' }],
        },
      ],
      current: {
        messageId: 'asst-2',
        blocks: new Map(),
        blockOrder: [],
      },
    };
    const restored = [
      {
        messageId: 'restored-1',
        role: 'assistant' as const,
        blocks: [{ blockId: 'a1', blockType: 'text' as const, content: 'first reply' }],
      },
      {
        messageId: 'asst-2',
        role: 'assistant' as const,
        blocks: [{ blockId: 'a2', blockType: 'text' as const, content: 'second reply' }],
      },
    ];
    const next = messagesReducer(state, {
      type: 'RESTORE',
      messages: restored,
      interrupted: true,
    });
    // current should be cleared (asst-2 is in the restored set)
    expect(next.current).toBeNull();
    // optimistic user msg should be preserved and merged
    const userMsgs = next.messages.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].messageId).toBe('user-optimistic');
    // restored assistant messages should be present
    expect(next.messages.some((m) => m.messageId === 'asst-2')).toBe(true);
  });
});

describe('MESSAGE_START finalizes current with subagent blocks', () => {
  it('finishCurrent converts streaming subagent to finished when new message starts', () => {
    // Simulate: assistant is streaming a message with a subagent tool_use block,
    // then a new MESSAGE_START arrives — the orphaned current should be finalized
    // with subagent blocks correctly converted from Map to array.
    const subagentBlocks = new Map([
      [
        'sub-b1',
        {
          blockId: 'sub-b1',
          blockType: 'text' as const,
          content: 'subagent thinking',
          done: true,
        },
      ],
      [
        'sub-b2',
        {
          blockId: 'sub-b2',
          blockType: 'tool_use' as const,
          content: '',
          done: true,
          toolName: 'Bash',
          toolId: 'sub-tool-1',
          toolInput: 'echo hi',
        },
      ],
    ]);

    const state: MessagesState = {
      ...INITIAL,
      current: {
        messageId: 'msg-with-subagent',
        blocks: new Map([
          [
            'b1',
            {
              blockId: 'b1',
              blockType: 'tool_use' as const,
              content: '',
              done: true,
              toolName: 'Agent',
              toolId: 'agent-tool-1',
              subagent: {
                messageId: 'sub-msg-1',
                blocks: subagentBlocks,
                blockOrder: ['sub-b1', 'sub-b2'],
                running: true as const,
              },
            },
          ],
        ]),
        blockOrder: ['b1'],
      },
    };

    // New MESSAGE_START should finalize the current (with subagent) and start fresh
    const next = messagesReducer(state, { type: 'MESSAGE_START', messageId: 'msg-new' });

    // Orphaned message with subagent should be finalized into messages[]
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].messageId).toBe('msg-with-subagent');

    // Subagent should be converted from streaming (Map) to finished (array)
    const sub = next.messages[0].blocks[0].subagent as FinishedSubagentState;
    expect(sub).toBeDefined();
    expect(sub.messageId).toBe('sub-msg-1');
    expect(Array.isArray(sub.blocks)).toBe(true);
    expect(sub.blocks).toHaveLength(2);
    expect(sub.blocks[0].content).toBe('subagent thinking');
    expect(sub.blocks[1].toolName).toBe('Bash');
    expect(sub.blocks[1].toolId).toBe('sub-tool-1');

    // New current should be clean
    expect(next.current).not.toBeNull();
    expect(next.current!.messageId).toBe('msg-new');
    expect(next.current!.blockOrder).toHaveLength(0);
  });
});

describe('foreground recovery race — full sequence', () => {
  it('RESTORE then WS replay of same message does not duplicate', () => {
    // Simulate: user sends, assistant streams, iOS backgrounds, foreground returns
    // 1. USER_SEND adds optimistic user message
    let state = messagesReducer(INITIAL, {
      type: 'USER_SEND',
      text: 'hello',
      clientMsgId: 'user-abc',
    });
    // 2. MESSAGE_START creates current
    state = messagesReducer(state, { type: 'MESSAGE_START', messageId: 'asst-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'asst-1',
      blockId: 'b1',
      blockType: 'text',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'asst-1',
      blockId: 'b1',
      blockType: 'text',
      delta: 'partial',
    });
    expect(state.messages).toHaveLength(1); // user msg
    expect(state.current).not.toBeNull();

    // 3. RESTORE fires (foreground recovery) — server has the completed conversation
    state = messagesReducer(state, {
      type: 'RESTORE',
      messages: [
        {
          messageId: 'user-abc',
          role: 'user' as const,
          blocks: [{ blockId: 'u1', blockType: 'text' as const, content: 'hello' }],
        },
        {
          messageId: 'asst-1',
          role: 'assistant' as const,
          blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'full response' }],
        },
      ],
    });
    // RESTORE should replace messages AND clear stale current
    expect(state.messages).toHaveLength(2);
    expect(state.current).toBeNull();

    // 4. WS replay delivers the same message_start + message_end
    state = messagesReducer(state, { type: 'MESSAGE_START', messageId: 'asst-1' });
    // MESSAGE_START should be a no-op (dedup)
    expect(state.current).toBeNull();
    expect(state.messages).toHaveLength(2);

    // 5. BLOCK events after suppressed MESSAGE_START are safe no-ops
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'asst-1',
      blockId: 'b1',
      blockType: 'text',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'asst-1',
      blockId: 'b1',
      blockType: 'text',
      delta: 'replayed',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'asst-1',
      blockId: 'b1',
      blockType: 'text',
    });
    // Still no current, still 2 messages
    expect(state.current).toBeNull();
    expect(state.messages).toHaveLength(2);

    // 6. MESSAGE_END for the replayed message — should be safe no-op
    state = messagesReducer(state, { type: 'MESSAGE_END', messageId: 'asst-1' });
    expect(state.current).toBeNull();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].blocks[0].content).toBe('full response');
  });

  it('multi-turn: only the replayed message is deduplicated, earlier ones kept', () => {
    // Start with a completed first turn
    const state: MessagesState = {
      ...INITIAL,
      messages: [
        {
          messageId: 'user-1',
          role: 'user',
          blocks: [{ blockId: 'u1', blockType: 'text', content: 'first' }],
        },
        {
          messageId: 'asst-1',
          role: 'assistant',
          blocks: [{ blockId: 'a1', blockType: 'text', content: 'reply 1' }],
        },
        {
          messageId: 'user-2',
          role: 'user',
          blocks: [{ blockId: 'u2', blockType: 'text', content: 'second' }],
        },
        {
          messageId: 'asst-2',
          role: 'assistant',
          blocks: [{ blockId: 'a2', blockType: 'text', content: 'reply 2' }],
        },
      ],
    };

    // WS replay tries to re-deliver only asst-2
    let next = messagesReducer(state, { type: 'MESSAGE_START', messageId: 'asst-2' });
    expect(next.current).toBeNull(); // dedup blocked it
    expect(next.messages).toHaveLength(4); // all 4 still there

    // A genuinely new message should still work
    next = messagesReducer(next, { type: 'MESSAGE_START', messageId: 'asst-3' });
    expect(next.current).not.toBeNull();
    expect(next.current!.messageId).toBe('asst-3');
  });
});

// ─── Context Consumed ──────────────────────────────────────────────────────

describe('contextConsumed', () => {
  it('starts empty', () => {
    expect(INITIAL.contextConsumed).toEqual([]);
  });

  it('accumulates file reads on BLOCK_END', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Read',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Read',
      toolId: 't1',
      input: '/src/index.ts',
    });

    expect(state.contextConsumed).toHaveLength(1);
    expect(state.contextConsumed[0]).toEqual({
      type: 'file_read',
      key: '/src/index.ts',
      label: '/src/index.ts',
      count: 1,
    });
  });

  it('deduplicates repeated reads and increments count', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });

    // First read
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Read',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Read',
      toolId: 't1',
      input: '/src/index.ts',
    });

    // Second read of same file
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b2',
      blockType: 'tool_use',
      toolName: 'Read',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-1',
      blockId: 'b2',
      blockType: 'tool_use',
      toolName: 'Read',
      toolId: 't2',
      input: '/src/index.ts',
    });

    expect(state.contextConsumed).toHaveLength(1);
    expect(state.contextConsumed[0].count).toBe(2);
  });

  it('tracks multiple context types', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });

    // Read
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Read',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Read',
      toolId: 't1',
      input: '/src/index.ts',
    });

    // Grep
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b2',
      blockType: 'tool_use',
      toolName: 'Grep',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-1',
      blockId: 'b2',
      blockType: 'tool_use',
      toolName: 'Grep',
      toolId: 't2',
      input: '/TODO/ in /src',
    });

    // WebFetch
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b3',
      blockType: 'tool_use',
      toolName: 'WebFetch',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-1',
      blockId: 'b3',
      blockType: 'tool_use',
      toolName: 'WebFetch',
      toolId: 't3',
      input: 'https://example.com',
    });

    expect(state.contextConsumed).toHaveLength(3);
    expect(state.contextConsumed.map((e) => e.type)).toEqual(['file_read', 'search', 'web_fetch']);
  });

  it('ignores non-context tools (Bash, Write, Edit)', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });

    for (const toolName of ['Bash', 'Write', 'Edit']) {
      state = messagesReducer(state, {
        type: 'BLOCK_START',
        messageId: 'msg-1',
        blockId: `b-${toolName}`,
        blockType: 'tool_use',
        toolName,
      });
      state = messagesReducer(state, {
        type: 'BLOCK_END',
        messageId: 'msg-1',
        blockId: `b-${toolName}`,
        blockType: 'tool_use',
        toolName,
        toolId: `t-${toolName}`,
        input: 'some input',
      });
    }

    expect(state.contextConsumed).toHaveLength(0);
  });

  it('accumulates from subagent tool calls', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'agent-b',
      blockType: 'tool_use',
      toolName: 'Agent',
    });
    state = messagesReducer(state, {
      type: 'SUBAGENT_START',
      parentBlockId: 'agent-b',
      subagentMessageId: 'sub-msg',
    });
    state = messagesReducer(state, {
      type: 'SUBAGENT_BLOCK_START',
      parentBlockId: 'agent-b',
      blockId: 'sub-b1',
      blockType: 'tool_use',
      toolName: 'Grep',
    });
    state = messagesReducer(state, {
      type: 'SUBAGENT_BLOCK_END',
      parentBlockId: 'agent-b',
      blockId: 'sub-b1',
      toolName: 'Grep',
      toolId: 'sub-t1',
      input: '/error/ in /logs',
    });

    expect(state.contextConsumed).toHaveLength(1);
    expect(state.contextConsumed[0]).toEqual({
      type: 'search',
      key: '/error/ in /logs',
      label: '/error/ in /logs',
      count: 1,
    });
  });

  it('rebuilds context on RESTORE', () => {
    const restored = messagesReducer(INITIAL, {
      type: 'RESTORE',
      messages: [
        {
          messageId: 'msg-1',
          role: 'assistant',
          timestamp: Date.now(),
          blocks: [
            {
              blockId: 'b1',
              blockType: 'tool_use',
              content: '',
              toolName: 'Read',
              toolId: 't1',
              toolInput: '/src/app.ts',
            },
            {
              blockId: 'b2',
              blockType: 'tool_use',
              content: '',
              toolName: 'Grep',
              toolId: 't2',
              toolInput: '/TODO/ in workspace',
            },
          ],
        },
      ],
    });

    expect(restored.contextConsumed).toHaveLength(2);
    expect(restored.contextConsumed[0].type).toBe('file_read');
    expect(restored.contextConsumed[1].type).toBe('search');
  });

  it('resets on CLEAR', () => {
    let state = messagesReducer(INITIAL, { type: 'MESSAGE_START', messageId: 'msg-1' });
    state = messagesReducer(state, {
      type: 'BLOCK_START',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Read',
    });
    state = messagesReducer(state, {
      type: 'BLOCK_END',
      messageId: 'msg-1',
      blockId: 'b1',
      blockType: 'tool_use',
      toolName: 'Read',
      toolId: 't1',
      input: '/some/file.ts',
    });
    expect(state.contextConsumed).toHaveLength(1);

    state = messagesReducer(state, { type: 'CLEAR' });
    expect(state.contextConsumed).toEqual([]);
  });
});

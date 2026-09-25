import { describe, it, expect } from 'vitest';
import { reconstructMessages, replayEventsToMessages, replayEventsToTranscript } from '../chat.js';
import type { RawSdkMessage } from '../chat.js';
import type { StoredEvent } from '../event-store.js';
import { EventStore } from '../event-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('reconstructMessages', () => {
  it('returns empty array for empty input', () => {
    expect(reconstructMessages([])).toEqual([]);
  });

  it('reconstructs user prompts stored as plain strings', () => {
    const raw: RawSdkMessage[] = [
      { type: 'user', message: { id: 'u1', content: 'Hello, help me with this' } },
    ];
    const result = reconstructMessages(raw);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].blocks).toHaveLength(1);
    expect(result[0].blocks[0].blockType).toBe('text');
    expect(result[0].blocks[0].content).toBe('Hello, help me with this');
  });

  it('reconstructs assistant messages with text content blocks', () => {
    const raw: RawSdkMessage[] = [
      {
        type: 'assistant',
        message: { id: 'a1', content: [{ type: 'text', text: 'Here is my response' }] },
      },
    ];
    const result = reconstructMessages(raw);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect(result[0].blocks[0].content).toBe('Here is my response');
  });

  it('reconstructs assistant messages with tool_use blocks', () => {
    const raw: RawSdkMessage[] = [
      {
        type: 'assistant',
        message: {
          id: 'a1',
          content: [
            { type: 'tool_use', name: 'Read', id: 'tc-1', input: { file_path: '/tmp/f.ts' } },
          ],
        },
      },
    ];
    const result = reconstructMessages(raw);
    expect(result).toHaveLength(1);
    expect(result[0].blocks[0].blockType).toBe('tool_use');
    expect(result[0].blocks[0].toolName).toBe('Read');
    expect(result[0].blocks[0].toolId).toBe('tc-1');
  });

  it('attaches tool results from user-type SDK messages to matching tool blocks', () => {
    const raw: RawSdkMessage[] = [
      {
        type: 'assistant',
        message: {
          id: 'a1',
          content: [{ type: 'tool_use', name: 'Bash', id: 'tc-1', input: { command: 'ls' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'file1\nfile2' }],
        },
      },
    ];
    const result = reconstructMessages(raw);
    const assistantMsg = result.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.blocks[0].toolResult).toBe('file1\nfile2');
  });

  it('filters out user messages that only contain tool_result blocks', () => {
    const raw: RawSdkMessage[] = [
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'output' }],
        },
      },
    ];
    const result = reconstructMessages(raw);
    expect(result).toHaveLength(0);
  });

  it('skips messages with empty string content', () => {
    const raw: RawSdkMessage[] = [{ type: 'user', message: { id: 'u1', content: '' } }];
    const result = reconstructMessages(raw);
    expect(result).toHaveLength(0);
  });

  it('skips messages with undefined content', () => {
    const raw: RawSdkMessage[] = [{ type: 'user', message: { id: 'u1' } }];
    const result = reconstructMessages(raw);
    expect(result).toHaveLength(0);
  });

  it('handles a full multi-turn conversation', () => {
    const raw: RawSdkMessage[] = [
      { type: 'user', message: { id: 'u1', content: 'List my files' } },
      {
        type: 'assistant',
        message: {
          id: 'a1',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', name: 'Bash', id: 'tc-1', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'README.md\nsrc/' }],
        },
      },
      {
        type: 'assistant',
        message: { id: 'a2', content: [{ type: 'text', text: 'You have README.md and src/.' }] },
      },
      { type: 'user', message: { id: 'u2', content: 'Thanks!' } },
    ];

    const result = reconstructMessages(raw);

    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ role: 'user', blocks: [{ content: 'List my files' }] });
    expect(result[1]).toMatchObject({ role: 'assistant' });
    expect(result[1].blocks).toHaveLength(2);
    expect(result[1].blocks[0].content).toBe('Let me check.');
    expect(result[1].blocks[1].toolResult).toBe('README.md\nsrc/');
    expect(result[2]).toMatchObject({
      role: 'assistant',
      blocks: [{ content: 'You have README.md and src/.' }],
    });
    expect(result[3]).toMatchObject({ role: 'user', blocks: [{ content: 'Thanks!' }] });
  });

  it('generates unique block IDs across messages', () => {
    const raw: RawSdkMessage[] = [
      { type: 'user', message: { id: 'u1', content: 'First' } },
      { type: 'user', message: { id: 'u2', content: 'Second' } },
    ];
    const result = reconstructMessages(raw);
    const ids = result.flatMap((m) => m.blocks.map((b) => b.blockId));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('replayEventsToTranscript — bounded in-flight restore', () => {
  function evt(seq: number, type: string, payload: Record<string, unknown>): StoredEvent {
    return { seq, sessionId: 'sess-1', type, payload, createdAt: seq };
  }

  it('keeps open text, thinking and tool blocks typed and out of finished history', () => {
    const events = [
      evt(1, 'user_message', { messageId: 'u1', text: 'Inspect this' }),
      evt(2, 'message_start', { messageId: 'a1' }),
      evt(3, 'block_start', { messageId: 'a1', blockId: 'thinking', blockType: 'thinking' }),
      evt(4, 'block_delta', { messageId: 'a1', blockId: 'thinking', delta: 'considering' }),
      evt(5, 'block_end', { messageId: 'a1', blockId: 'thinking', blockType: 'thinking' }),
      evt(6, 'block_start', {
        messageId: 'a1',
        blockId: 'tool',
        blockType: 'tool_use',
        toolName: 'Read',
      }),
      evt(7, 'tool_result', {
        toolId: 'tool-1',
        result: 'contents',
        isError: false,
        images: [{ id: 'image-1', mediaType: 'image/png' }],
      }),
      evt(8, 'block_end', {
        messageId: 'a1',
        blockId: 'tool',
        blockType: 'tool_use',
        toolName: 'Read',
        toolId: 'tool-1',
        input: 'file.ts',
        rawInput: { file_path: 'file.ts' },
      }),
      evt(9, 'block_start', { messageId: 'a1', blockId: 'text', blockType: 'text' }),
      evt(10, 'block_delta', { messageId: 'a1', blockId: 'text', delta: 'partial answer' }),
    ];

    expect(replayEventsToTranscript(events)).toMatchObject({
      messages: [{ messageId: 'u1' }],
      current: {
        messageId: 'a1',
        blocks: [
          { blockId: 'thinking', blockType: 'thinking', content: 'considering', done: true },
          {
            blockId: 'tool',
            blockType: 'tool_use',
            toolName: 'Read',
            toolId: 'tool-1',
            toolInput: 'file.ts',
            rawInput: { file_path: 'file.ts' },
            toolResult: 'contents',
            toolResultImages: [{ id: 'image-1', mediaType: 'image/png' }],
            done: true,
          },
          { blockId: 'text', blockType: 'text', content: 'partial answer', done: false },
        ],
      },
    });
  });

  it('has no streaming current after message_end or session_end', () => {
    const open = [
      evt(1, 'message_start', { messageId: 'a1' }),
      evt(2, 'block_start', { messageId: 'a1', blockId: 'b1', blockType: 'text' }),
      evt(3, 'block_delta', { messageId: 'a1', blockId: 'b1', delta: 'partial' }),
    ];
    expect(
      replayEventsToTranscript([...open, evt(4, 'message_end', { messageId: 'a1' })]).current,
    ).toBeNull();
    expect(replayEventsToTranscript([...open, evt(4, 'session_end', {})])).toMatchObject({
      current: null,
      messages: [{ messageId: 'a1', blocks: [{ blockId: 'b1', content: 'partial' }] }],
    });
  });

  it('retains an earlier interrupted partial block after a later turn completes', () => {
    const events = [
      evt(1, 'message_start', { messageId: 'interrupted' }),
      evt(2, 'block_start', { messageId: 'interrupted', blockId: 'old', blockType: 'text' }),
      evt(3, 'block_delta', { messageId: 'interrupted', blockId: 'old', delta: 'saved partial' }),
      evt(4, 'session_end', {}),
      evt(5, 'message_start', { messageId: 'later' }),
      evt(6, 'block_start', { messageId: 'later', blockId: 'new', blockType: 'text' }),
      evt(7, 'block_delta', { messageId: 'later', blockId: 'new', delta: 'complete' }),
      evt(8, 'block_end', { messageId: 'later', blockId: 'new', blockType: 'text' }),
      evt(9, 'message_end', { messageId: 'later' }),
    ];

    expect(replayEventsToTranscript(events)).toMatchObject({
      current: null,
      messages: [
        { messageId: 'interrupted', blocks: [{ blockId: 'old', content: 'saved partial' }] },
        { messageId: 'later', blocks: [{ blockId: 'new', content: 'complete' }] },
      ],
    });
  });

  it('keeps a terminal partial assistant before a newer user follow-up', () => {
    const events = [
      evt(1, 'message_start', { messageId: 'a1' }),
      evt(2, 'block_start', { messageId: 'a1', blockId: 'text', blockType: 'text' }),
      evt(3, 'block_delta', { messageId: 'a1', blockId: 'text', delta: 'interrupted' }),
      evt(4, 'session_end', {}),
      evt(5, 'user_message', { messageId: 'u2', text: 'continue' }),
    ];
    expect(replayEventsToTranscript(events)).toMatchObject({
      current: null,
      messages: [
        { messageId: 'a1', blocks: [{ content: 'interrupted' }] },
        { messageId: 'u2', role: 'user' },
      ],
    });
  });

  it('restores running and completed nested subagents inside a current turn', () => {
    const events = [
      evt(1, 'message_start', { messageId: 'a1' }),
      evt(2, 'block_start', {
        messageId: 'a1',
        blockId: 'parent',
        blockType: 'tool_use',
        toolName: 'Agent',
      }),
      evt(3, 'subagent_start', { parentBlockId: 'parent', subagentMessageId: 's1' }),
      evt(4, 'subagent_block_start', {
        parentBlockId: 'parent',
        blockId: 'nested',
        blockType: 'text',
      }),
      evt(5, 'subagent_block_delta', {
        parentBlockId: 'parent',
        blockId: 'nested',
        delta: 'saved ',
      }),
    ];
    expect(replayEventsToTranscript(events).current?.blocks[0].subagent).toMatchObject({
      messageId: 's1',
      running: true,
      blocks: [{ blockId: 'nested', content: 'saved ', done: false }],
    });
    const completed = [
      ...events,
      evt(6, 'subagent_block_delta', { parentBlockId: 'parent', blockId: 'nested', delta: 'work' }),
      evt(7, 'subagent_block_end', { parentBlockId: 'parent', blockId: 'nested' }),
      evt(8, 'subagent_end', { parentBlockId: 'parent', summary: 'finished' }),
    ];
    expect(replayEventsToTranscript(completed).current?.blocks[0].subagent).toMatchObject({
      messageId: 's1',
      summary: 'finished',
      blocks: [{ blockId: 'nested', content: 'saved work' }],
    });
    const finishedTurn = [
      ...completed,
      evt(9, 'block_end', {
        messageId: 'a1',
        blockId: 'parent',
        blockType: 'tool_use',
        toolName: 'Agent',
      }),
      evt(10, 'message_end', { messageId: 'a1' }),
    ];
    expect(replayEventsToTranscript(finishedTurn).messages[0].blocks[0].subagent).toMatchObject({
      messageId: 's1',
      summary: 'finished',
      blocks: [{ blockId: 'nested', content: 'saved work' }],
    });
  });

  it('keeps reused parent block IDs scoped to their assistant turns', () => {
    const events = [
      evt(1, 'message_start', { messageId: 'a1' }),
      evt(2, 'block_start', { messageId: 'a1', blockId: 'b0', blockType: 'tool_use' }),
      evt(3, 'subagent_start', { parentBlockId: 'b0', subagentMessageId: 'first' }),
      evt(4, 'subagent_block_start', { parentBlockId: 'b0', blockId: 'nested', blockType: 'text' }),
      evt(5, 'subagent_block_delta', { parentBlockId: 'b0', blockId: 'nested', delta: 'earlier' }),
      evt(6, 'subagent_block_end', { parentBlockId: 'b0', blockId: 'nested' }),
      evt(7, 'subagent_end', { parentBlockId: 'b0', summary: 'first done' }),
      evt(8, 'block_end', { messageId: 'a1', blockId: 'b0', blockType: 'tool_use' }),
      evt(9, 'message_end', { messageId: 'a1' }),
      evt(10, 'message_start', { messageId: 'a2' }),
      evt(11, 'block_start', { messageId: 'a2', blockId: 'b0', blockType: 'tool_use' }),
      evt(12, 'subagent_start', { parentBlockId: 'b0', subagentMessageId: 'second' }),
      evt(13, 'subagent_block_start', {
        parentBlockId: 'b0',
        blockId: 'nested',
        blockType: 'text',
      }),
      evt(14, 'subagent_block_delta', { parentBlockId: 'b0', blockId: 'nested', delta: 'current' }),
    ];
    const restored = replayEventsToTranscript(events);
    expect(restored.messages[0].blocks[0].subagent).toMatchObject({
      messageId: 'first',
      summary: 'first done',
      blocks: [{ content: 'earlier' }],
    });
    expect(restored.current?.blocks[0].subagent).toMatchObject({
      messageId: 'second',
      running: true,
      blocks: [{ content: 'current' }],
    });
  });

  it('keeps reused nested tool IDs and results within each parent turn', () => {
    const events = [
      evt(1, 'message_start', { messageId: 'a1' }),
      evt(2, 'block_start', { messageId: 'a1', blockId: 'b0', blockType: 'tool_use' }),
      evt(3, 'subagent_start', { parentBlockId: 'b0', subagentMessageId: 's1' }),
      evt(4, 'subagent_block_start', {
        parentBlockId: 'b0',
        blockId: 'nested',
        blockType: 'tool_use',
      }),
      evt(5, 'subagent_block_end', { parentBlockId: 'b0', blockId: 'nested', toolId: 'shared' }),
      evt(6, 'subagent_tool_result', {
        parentBlockId: 'b0',
        toolId: 'shared',
        result: 'old result',
      }),
      evt(7, 'subagent_end', { parentBlockId: 'b0' }),
      evt(8, 'block_end', { messageId: 'a1', blockId: 'b0', blockType: 'tool_use' }),
      evt(9, 'message_end', { messageId: 'a1' }),
      evt(10, 'message_start', { messageId: 'a2' }),
      evt(11, 'block_start', { messageId: 'a2', blockId: 'b0', blockType: 'tool_use' }),
      evt(12, 'subagent_start', { parentBlockId: 'b0', subagentMessageId: 's2' }),
      evt(13, 'subagent_block_start', {
        parentBlockId: 'b0',
        blockId: 'nested',
        blockType: 'tool_use',
      }),
      evt(14, 'subagent_block_end', { parentBlockId: 'b0', blockId: 'nested', toolId: 'shared' }),
      evt(15, 'subagent_tool_result', {
        parentBlockId: 'b0',
        toolId: 'shared',
        result: 'new result',
      }),
    ];
    const restored = replayEventsToTranscript(events);
    expect(restored.messages[0].blocks[0].subagent?.blocks[0].toolResult).toBe('old result');
    expect(restored.current?.blocks[0].subagent?.blocks[0].toolResult).toBe('new result');
  });

  it('restores the same partial turn after disk reopen and excludes events beyond the cursor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mitzo-transcript-reopen-'));
    const path = join(dir, 'events.db');
    try {
      const first = new EventStore(path);
      first.upsertSession({ sessionId: 'sess-1' });
      first.append('sess-1', 'message_start', { messageId: 'a1' });
      first.append('sess-1', 'block_start', {
        messageId: 'a1',
        blockId: 'b1',
        blockType: 'text',
      });
      const cursor = first.append('sess-1', 'block_delta', {
        messageId: 'a1',
        blockId: 'b1',
        delta: 'before restart',
      });
      first.close();

      const reopened = new EventStore(path);
      try {
        reopened.append('sess-1', 'block_delta', {
          messageId: 'a1',
          blockId: 'b1',
          delta: ' after restart',
        });
        const oldBoundary = replayEventsToTranscript(
          reopened.getSessionEventsThroughCursor('sess-1', cursor),
        );
        expect(oldBoundary.current?.blocks[0]).toMatchObject({
          content: 'before restart',
          done: false,
        });

        reopened.append('sess-1', 'block_end', {
          messageId: 'a1',
          blockId: 'b1',
          blockType: 'text',
        });
        reopened.append('sess-1', 'message_end', { messageId: 'a1' });
        const completed = replayEventsToTranscript(reopened.getSessionEvents('sess-1'));
        expect(completed.current).toBeNull();
        expect(completed.messages).toMatchObject([
          { messageId: 'a1', blocks: [{ content: 'before restart after restart' }] },
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('replayEventsToMessages — user_message events', () => {
  function evt(seq: number, type: string, payload: Record<string, unknown>): StoredEvent {
    return { seq, sessionId: 'sess-1', type, payload, createdAt: Date.now() };
  }

  it('replays user_message events as role=user messages', () => {
    const events: StoredEvent[] = [
      evt(1, 'user_message', { messageId: 'umsg-1', text: 'Hello Claude' }),
      evt(2, 'message_start', { messageId: 'msg-a1' }),
      evt(3, 'block_start', { messageId: 'msg-a1', blockId: 'b0', blockType: 'text' }),
      evt(4, 'block_delta', {
        messageId: 'msg-a1',
        blockId: 'b0',
        blockType: 'text',
        delta: 'Hi!',
      }),
      evt(5, 'block_end', { messageId: 'msg-a1', blockId: 'b0', blockType: 'text' }),
      evt(6, 'message_end', { messageId: 'msg-a1' }),
    ];
    const result = replayEventsToMessages(events);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      messageId: 'umsg-1',
      role: 'user',
      blocks: [{ blockType: 'text', content: 'Hello Claude' }],
    });
    expect(result[1]).toMatchObject({ messageId: 'msg-a1', role: 'assistant' });
  });

  it('restores persisted user image previews and context block names', () => {
    const events: StoredEvent[] = [
      evt(1, 'user_message', {
        messageId: 'umsg-with-sources',
        text: 'Use these sources',
        images: ['data:image/png;base64,cHJldmlldw=='],
        contextBlocks: ['constitution'],
      }),
    ];

    expect(replayEventsToMessages(events)[0]).toMatchObject({
      messageId: 'umsg-with-sources',
      images: ['data:image/png;base64,cHJldmlldw=='],
      contextBlocks: ['constitution'],
    });
  });

  it('restores sources when session metadata supplies the initial prompt', () => {
    const events: StoredEvent[] = [
      evt(1, 'message_start', { messageId: 'assistant-1' }),
      evt(2, 'user_message', {
        messageId: 'umsg-initial',
        text: 'Initial prompt',
        images: ['data:image/png;base64,cHJldmlldw=='],
        contextBlocks: ['constitution'],
      }),
    ];

    expect(replayEventsToMessages(events, 'Initial prompt')[0]).toMatchObject({
      messageId: 'umsg-initial',
      images: ['data:image/png;base64,cHJldmlldw=='],
      contextBlocks: ['constitution'],
    });
  });

  it('interleaves user and assistant messages in correct order', () => {
    const events: StoredEvent[] = [
      evt(1, 'user_message', { messageId: 'umsg-1', text: 'First question' }),
      evt(2, 'message_start', { messageId: 'msg-a1' }),
      evt(3, 'block_start', { messageId: 'msg-a1', blockId: 'b0', blockType: 'text' }),
      evt(4, 'block_delta', { messageId: 'msg-a1', blockId: 'b0', delta: 'Answer 1' }),
      evt(5, 'block_end', { messageId: 'msg-a1', blockId: 'b0', blockType: 'text' }),
      evt(6, 'message_end', { messageId: 'msg-a1' }),
      evt(7, 'user_message', { messageId: 'umsg-2', text: 'Follow-up' }),
      evt(8, 'message_start', { messageId: 'msg-a2' }),
      evt(9, 'block_start', { messageId: 'msg-a2', blockId: 'b0', blockType: 'text' }),
      evt(10, 'block_delta', { messageId: 'msg-a2', blockId: 'b0', delta: 'Answer 2' }),
      evt(11, 'block_end', { messageId: 'msg-a2', blockId: 'b0', blockType: 'text' }),
      evt(12, 'message_end', { messageId: 'msg-a2' }),
    ];
    const result = replayEventsToMessages(events);
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ role: 'user', blocks: [{ content: 'First question' }] });
    expect(result[1]).toMatchObject({ role: 'assistant' });
    expect(result[2]).toMatchObject({ role: 'user', blocks: [{ content: 'Follow-up' }] });
    expect(result[3]).toMatchObject({ role: 'assistant' });
  });

  it('injects initialPrompt as first message when provided', () => {
    const events: StoredEvent[] = [
      evt(1, 'message_start', { messageId: 'msg-a1' }),
      evt(2, 'block_start', { messageId: 'msg-a1', blockId: 'b0', blockType: 'text' }),
      evt(3, 'block_delta', {
        messageId: 'msg-a1',
        blockId: 'b0',
        blockType: 'text',
        delta: 'Hi!',
      }),
      evt(4, 'block_end', { messageId: 'msg-a1', blockId: 'b0', blockType: 'text' }),
      evt(5, 'message_end', { messageId: 'msg-a1' }),
    ];
    const result = replayEventsToMessages(events, 'Hello Claude');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      role: 'user',
      blocks: [{ blockType: 'text', content: 'Hello Claude' }],
    });
    expect(result[1]).toMatchObject({ messageId: 'msg-a1', role: 'assistant' });
  });

  it('does not duplicate initial prompt if also present as event', () => {
    // Legacy events may still have user_message in the stream — initialPrompt wins
    const events: StoredEvent[] = [
      evt(1, 'message_start', { messageId: 'msg-a1' }),
      evt(2, 'block_start', { messageId: 'msg-a1', blockId: 'b0', blockType: 'text' }),
      evt(3, 'block_delta', { messageId: 'msg-a1', blockId: 'b0', delta: 'Hi!' }),
      evt(4, 'block_end', { messageId: 'msg-a1', blockId: 'b0', blockType: 'text' }),
      evt(5, 'user_message', { messageId: 'umsg-initial', text: 'Hello Claude' }),
      evt(6, 'message_end', { messageId: 'msg-a1' }),
    ];
    const result = replayEventsToMessages(events, 'Hello Claude');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ role: 'user', blocks: [{ content: 'Hello Claude' }] });
    expect(result[1]).toMatchObject({ role: 'assistant' });
  });

  it('still handles legacy out-of-order initial prompts without initialPrompt param', () => {
    // Backward compat: old sessions stored the initial prompt as an out-of-order event
    const events: StoredEvent[] = [
      evt(1, 'message_start', { messageId: 'msg-a1' }),
      evt(2, 'block_start', { messageId: 'msg-a1', blockId: 'b0', blockType: 'text' }),
      evt(3, 'block_delta', { messageId: 'msg-a1', blockId: 'b0', delta: 'Hi!' }),
      evt(4, 'block_end', { messageId: 'msg-a1', blockId: 'b0', blockType: 'text' }),
      evt(5, 'user_message', { messageId: 'umsg-initial', text: 'Hello Claude' }),
      evt(6, 'message_end', { messageId: 'msg-a1' }),
    ];
    const result = replayEventsToMessages(events);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ role: 'user', blocks: [{ content: 'Hello Claude' }] });
    expect(result[1]).toMatchObject({ role: 'assistant' });
  });

  it('handles out-of-order initial prompt after message_end (race condition)', () => {
    // Bug case: message_end flushes before user_message is emitted
    const events: StoredEvent[] = [
      evt(1, 'message_start', { messageId: 'msg-a1' }),
      evt(2, 'block_start', { messageId: 'msg-a1', blockId: 'b0', blockType: 'text' }),
      evt(3, 'block_delta', { messageId: 'msg-a1', blockId: 'b0', delta: 'Hi!' }),
      evt(4, 'block_end', { messageId: 'msg-a1', blockId: 'b0', blockType: 'text' }),
      evt(5, 'message_end', { messageId: 'msg-a1' }),
      evt(6, 'user_message', { messageId: 'umsg-initial', text: 'Hello Claude' }),
    ];
    const result = replayEventsToMessages(events, 'Hello Claude');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ role: 'user', blocks: [{ content: 'Hello Claude' }] });
    expect(result[1]).toMatchObject({ role: 'assistant' });
  });

  it('handles user_message without any assistant messages', () => {
    const events: StoredEvent[] = [
      evt(1, 'user_message', { messageId: 'umsg-1', text: 'Unanswered' }),
    ];
    const result = replayEventsToMessages(events);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ role: 'user', blocks: [{ content: 'Unanswered' }] });
  });

  it('injects initialPrompt even with no events', () => {
    const result = replayEventsToMessages([], 'Hello from empty session');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'user',
      blocks: [{ content: 'Hello from empty session' }],
    });
  });

  it('reuses stored messageId for initial prompt (deterministic across calls)', () => {
    const events: StoredEvent[] = [
      evt(1, 'user_message', { messageId: 'umsg-12345-init', text: 'Hello Claude' }),
      evt(2, 'message_start', { messageId: 'msg-a1' }),
      evt(3, 'block_start', { messageId: 'msg-a1', blockId: 'b0', blockType: 'text' }),
      evt(4, 'block_delta', { messageId: 'msg-a1', blockId: 'b0', delta: 'Hi!' }),
      evt(5, 'block_end', { messageId: 'msg-a1', blockId: 'b0', blockType: 'text' }),
      evt(6, 'message_end', { messageId: 'msg-a1' }),
    ];
    const result1 = replayEventsToMessages(events, 'Hello Claude');
    const result2 = replayEventsToMessages(events, 'Hello Claude');
    expect(result1[0].messageId).toBe('umsg-12345-init');
    expect(result2[0].messageId).toBe('umsg-12345-init');
    // Same ID across calls — no Date.now() instability
    expect(result1[0].messageId).toBe(result2[0].messageId);
  });

  it('falls back to stable umsg-initial when no matching event exists', () => {
    const events: StoredEvent[] = [
      evt(1, 'message_start', { messageId: 'msg-a1' }),
      evt(2, 'block_start', { messageId: 'msg-a1', blockId: 'b0', blockType: 'text' }),
      evt(3, 'block_delta', { messageId: 'msg-a1', blockId: 'b0', delta: 'Hi!' }),
      evt(4, 'block_end', { messageId: 'msg-a1', blockId: 'b0', blockType: 'text' }),
      evt(5, 'message_end', { messageId: 'msg-a1' }),
    ];
    const result = replayEventsToMessages(events, 'Hello Claude');
    expect(result[0].messageId).toBe('umsg-initial');
  });
});

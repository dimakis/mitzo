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

  it('restores interleaved seat turns with reused block IDs and immutable provenance', () => {
    const provenance = (seatId: string) => ({
      seatId,
      configRevision: 1,
      accountProfileRevision: 'account-1',
      seatProfileRevision: 'profile-1',
      contextGrantRevision: 1,
      authorityGrantRevision: 1,
      isolationDomainId: 'domain-1',
      isolationDomainRevision: 1,
      membershipGeneration: 1,
    });
    const seat = (seq: number, type: string, seatId: string, payload: Record<string, unknown>) => ({
      ...evt(seq, type, payload),
      seatId,
      symposiumProvenance: provenance(seatId),
    });
    const events = [
      seat(1, 'message_start', 'architect', { messageId: 'a1' }),
      seat(2, 'block_start', 'architect', { messageId: 'a1', blockId: 'b0', blockType: 'text' }),
      seat(3, 'message_start', 'reviewer', { messageId: 'a2' }),
      seat(4, 'block_start', 'reviewer', { messageId: 'a2', blockId: 'b0', blockType: 'text' }),
      seat(5, 'block_delta', 'architect', { messageId: 'a1', blockId: 'b0', delta: 'design' }),
      seat(6, 'block_delta', 'reviewer', { messageId: 'a2', blockId: 'b0', delta: 'review' }),
      seat(7, 'message_end', 'architect', { messageId: 'a1' }),
    ];
    const restored = replayEventsToTranscript(events);
    expect(restored.messages).toMatchObject([
      {
        messageId: 'a1',
        startedSeq: 1,
        symposiumProvenance: { seatId: 'architect' },
        blocks: [{ content: 'design' }],
      },
    ]);
    expect(restored.currents).toMatchObject([
      {
        messageId: 'a2',
        startedSeq: 3,
        symposiumProvenance: { seatId: 'reviewer' },
        blocks: [{ content: 'review', done: false }],
      },
    ]);
    expect(restored.current).toBeNull();
  });

  it('keeps nested subagents under the correct seat when both use parent b0', () => {
    const provenance = (seatId: string) => ({
      seatId,
      configRevision: 1,
      accountProfileRevision: 'account-1',
      seatProfileRevision: 'profile-1',
      contextGrantRevision: 1,
      authorityGrantRevision: 1,
      isolationDomainId: 'domain-1',
      isolationDomainRevision: 1,
    });
    const seat = (seq: number, type: string, seatId: string, payload: Record<string, unknown>) => ({
      ...evt(seq, type, payload),
      seatId,
      symposiumProvenance: provenance(seatId),
    });
    const events = [
      seat(1, 'message_start', 'architect', { messageId: 'a1' }),
      seat(2, 'block_start', 'architect', {
        messageId: 'a1',
        blockId: 'b0',
        blockType: 'tool_use',
      }),
      seat(3, 'message_start', 'reviewer', { messageId: 'a2' }),
      seat(4, 'block_start', 'reviewer', { messageId: 'a2', blockId: 'b0', blockType: 'tool_use' }),
      seat(5, 'subagent_start', 'architect', { parentBlockId: 'b0', subagentMessageId: 's1' }),
      seat(6, 'subagent_start', 'reviewer', { parentBlockId: 'b0', subagentMessageId: 's2' }),
      seat(7, 'subagent_block_start', 'architect', {
        parentBlockId: 'b0',
        blockId: 'nested',
        blockType: 'text',
      }),
      seat(8, 'subagent_block_start', 'reviewer', {
        parentBlockId: 'b0',
        blockId: 'nested',
        blockType: 'text',
      }),
      seat(9, 'subagent_block_delta', 'architect', {
        parentBlockId: 'b0',
        blockId: 'nested',
        delta: 'design',
      }),
      seat(10, 'subagent_block_delta', 'reviewer', {
        parentBlockId: 'b0',
        blockId: 'nested',
        delta: 'critique',
      }),
    ];
    const restored = replayEventsToTranscript(events);
    expect(restored.currents[0].blocks[0].subagent?.blocks[0].content).toBe('design');
    expect(restored.currents[1].blocks[0].subagent?.blocks[0].content).toBe('critique');
  });

  it('refuses a mismatched stored seat provenance', () => {
    const bad = {
      ...evt(1, 'message_start', { messageId: 'a1' }),
      seatId: 'reviewer',
      symposiumProvenance: {
        seatId: 'architect',
        configRevision: 1,
        accountProfileRevision: 'account-1',
        seatProfileRevision: 'profile-1',
        contextGrantRevision: 1,
        authorityGrantRevision: 1,
        isolationDomainId: 'domain-1',
        isolationDomainRevision: 1,
      },
    };
    expect(() => replayEventsToTranscript([bad])).toThrow(/seat/i);
  });

  it('refuses two open messages for the same seat', () => {
    const provenance = {
      seatId: 'reviewer',
      configRevision: 1,
      accountProfileRevision: 'account-1',
      seatProfileRevision: 'profile-1',
      contextGrantRevision: 1,
      authorityGrantRevision: 1,
      isolationDomainId: 'domain-1',
      isolationDomainRevision: 1,
    };
    const events = [
      {
        ...evt(1, 'message_start', { messageId: 'a1' }),
        seatId: 'reviewer',
        symposiumProvenance: provenance,
      },
      {
        ...evt(2, 'message_start', { messageId: 'a2' }),
        seatId: 'reviewer',
        symposiumProvenance: provenance,
      },
    ];
    expect(() => replayEventsToTranscript(events)).toThrow(/simultaneous|ambiguous/i);
  });

  it('keeps the original seat revision after later configuration changes', () => {
    const provenance = (configRevision: number) => ({
      seatId: 'reviewer',
      configRevision,
      accountProfileRevision: `account-${configRevision}`,
      seatProfileRevision: `profile-${configRevision}`,
      contextGrantRevision: configRevision,
      authorityGrantRevision: configRevision,
      isolationDomainId: 'domain-1',
      isolationDomainRevision: 1,
    });
    const seat = (
      seq: number,
      type: string,
      revision: number,
      payload: Record<string, unknown>,
    ) => ({
      ...evt(seq, type, payload),
      seatId: 'reviewer',
      symposiumProvenance: provenance(revision),
    });
    const restored = replayEventsToTranscript([
      seat(1, 'message_start', 1, { messageId: 'old' }),
      seat(2, 'block_start', 1, { messageId: 'old', blockId: 'b0', blockType: 'text' }),
      seat(3, 'block_delta', 1, { messageId: 'old', blockId: 'b0', delta: 'old answer' }),
      seat(4, 'message_end', 1, { messageId: 'old' }),
      seat(5, 'message_start', 2, { messageId: 'new' }),
    ]);
    expect(restored.messages[0].symposiumProvenance).toMatchObject({
      configRevision: 1,
      accountProfileRevision: 'account-1',
    });
    expect(restored.currents[0].symposiumProvenance).toMatchObject({
      configRevision: 2,
      accountProfileRevision: 'account-2',
    });
  });

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

  it.each([0, 1, 3])(
    'keeps an interrupted assistant with %i finished blocks before a user sent before session_end',
    (finishedCount) => {
      const events = [
        evt(1, 'message_start', { messageId: 'prior' }),
        evt(2, 'block_start', { messageId: 'prior', blockId: 'prior-text', blockType: 'text' }),
        evt(3, 'block_delta', { messageId: 'prior', blockId: 'prior-text', delta: 'earlier' }),
        evt(4, 'block_end', { messageId: 'prior', blockId: 'prior-text', blockType: 'text' }),
        evt(5, 'message_end', { messageId: 'prior' }),
        evt(6, 'message_start', { messageId: 'interrupted' }),
      ];
      let seq = 7;
      for (let i = 0; i < finishedCount; i++) {
        events.push(
          evt(seq++, 'block_start', {
            messageId: 'interrupted',
            blockId: `done-${i}`,
            blockType: 'text',
          }),
        );
        events.push(
          evt(seq++, 'block_delta', {
            messageId: 'interrupted',
            blockId: `done-${i}`,
            delta: `finished-${i}`,
          }),
        );
        events.push(
          evt(seq++, 'block_end', {
            messageId: 'interrupted',
            blockId: `done-${i}`,
            blockType: 'text',
          }),
        );
      }
      events.push(
        evt(seq++, 'block_start', {
          messageId: 'interrupted',
          blockId: 'partial',
          blockType: 'text',
        }),
      );
      events.push(
        evt(seq++, 'block_delta', {
          messageId: 'interrupted',
          blockId: 'partial',
          delta: 'saved partial',
        }),
      );
      events.push(evt(seq++, 'user_message', { messageId: 'followup', text: 'continue' }));
      events.push(evt(seq, 'session_end', {}));

      const transcript = replayEventsToTranscript(events);
      expect(transcript.current).toBeNull();
      expect(transcript.messages.map(({ messageId }) => messageId)).toEqual([
        'prior',
        'interrupted',
        'followup',
      ]);
      expect(transcript.messages[1].blocks.map(({ content }) => content)).toEqual([
        ...Array.from({ length: finishedCount }, (_, i) => `finished-${i}`),
        'saved partial',
      ]);
    },
  );

  it('keeps an interrupted assistant between earlier history and a user sent after session_end', () => {
    const events = [
      evt(1, 'message_start', { messageId: 'prior' }),
      evt(2, 'block_start', { messageId: 'prior', blockId: 'old', blockType: 'text' }),
      evt(3, 'block_delta', { messageId: 'prior', blockId: 'old', delta: 'earlier' }),
      evt(4, 'block_end', { messageId: 'prior', blockId: 'old', blockType: 'text' }),
      evt(5, 'message_end', { messageId: 'prior' }),
      evt(6, 'message_start', { messageId: 'interrupted' }),
      evt(7, 'block_start', { messageId: 'interrupted', blockId: 'partial', blockType: 'text' }),
      evt(8, 'block_delta', {
        messageId: 'interrupted',
        blockId: 'partial',
        delta: 'saved partial',
      }),
      evt(9, 'session_end', {}),
      evt(10, 'user_message', { messageId: 'followup', text: 'continue' }),
    ];
    const transcript = replayEventsToTranscript(events);
    expect(transcript.current).toBeNull();
    expect(transcript.messages.map(({ messageId }) => messageId)).toEqual([
      'prior',
      'interrupted',
      'followup',
    ]);
    expect(transcript.messages[1].blocks[0].content).toBe('saved partial');
  });

  it.each([undefined, 'initial question'])(
    'applies late assistant deltas after a follow-up user with initialPrompt %s',
    (initialPrompt) => {
      const events = [
        evt(1, 'user_message', { messageId: 'initial', text: 'initial question' }),
        evt(2, 'message_start', { messageId: 'assistant' }),
        evt(3, 'block_start', { messageId: 'assistant', blockId: 'partial', blockType: 'text' }),
        evt(4, 'block_delta', { messageId: 'assistant', blockId: 'partial', delta: 'before ' }),
        evt(5, 'user_message', { messageId: 'followup', text: 'interrupt' }),
        evt(6, 'block_delta', { messageId: 'assistant', blockId: 'partial', delta: 'after' }),
        evt(7, 'block_end', { messageId: 'assistant', blockId: 'partial', blockType: 'text' }),
        evt(8, 'session_end', {}),
      ];
      const transcript = replayEventsToTranscript(events, initialPrompt);
      expect(transcript.current).toBeNull();
      expect(transcript.messages.map(({ messageId }) => messageId)).toEqual([
        'initial',
        'assistant',
        'followup',
      ]);
      expect(transcript.messages[1].blocks[0].content).toBe('before after');

      const beforeTerminal = replayEventsToTranscript(events.slice(0, 5), initialPrompt);
      expect(beforeTerminal.messages.map(({ messageId }) => messageId)).toEqual([
        'initial',
        'followup',
      ]);
      expect(beforeTerminal.current).toMatchObject({
        messageId: 'assistant',
        startedSeq: 2,
        blocks: [{ content: 'before ', done: false }],
      });
      expect(beforeTerminal.messages[1]).toMatchObject({ messageId: 'followup', startedSeq: 5 });
    },
  );

  it('hoists only the legacy first prompt, preserving a later user with the same text', () => {
    const events = [
      evt(1, 'message_start', { messageId: 'assistant' }),
      evt(2, 'user_message', { messageId: 'legacy-initial', text: 'repeat' }),
      evt(3, 'block_start', { messageId: 'assistant', blockId: 'text', blockType: 'text' }),
      evt(4, 'block_delta', { messageId: 'assistant', blockId: 'text', delta: 'response' }),
      evt(5, 'message_end', { messageId: 'assistant' }),
      evt(6, 'user_message', { messageId: 'later', text: 'repeat' }),
    ];
    const withMetadata = replayEventsToTranscript(events, 'repeat');
    expect(withMetadata.messages.map(({ messageId }) => messageId)).toEqual([
      'legacy-initial',
      'assistant',
      'later',
    ]);
    expect(withMetadata.messages[0].startedSeq).toBeUndefined();
    expect(replayEventsToTranscript(events).messages.map(({ messageId }) => messageId)).toEqual([
      'legacy-initial',
      'assistant',
      'later',
    ]);
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

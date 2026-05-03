import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runQueryLoop } from '../query-loop.js';
import type { SessionRegistry } from '../session-registry.js';
import type { SessionTransport } from '@mitzo/harness';

describe('Subagent Event Emission', () => {
  let mockRegistry: SessionRegistry;
  let mockTransport: SessionTransport;
  let sentEvents: Record<string, unknown>[];
  let abortController: AbortController;

  beforeEach(() => {
    sentEvents = [];
    abortController = new AbortController();

    mockTransport = {
      send: vi.fn((data: Record<string, unknown>) => {
        sentEvents.push(data);
      }),
      isOpen: vi.fn(() => true),
      close: vi.fn(),
    } as unknown as SessionTransport;

    mockRegistry = {
      get: vi.fn(() => ({
        transport: mockTransport,
        sessionId: 'test-session',
        cumulativeSessionTokens: 0,
        cumulativeCostUsd: 0,
        currentSnapshot: null,
        cwd: '/test',
        mode: 'agent' as const,
        observers: new Set(),
      })),
      setSessionId: vi.fn(),
      isAttached: vi.fn(() => true),
      isSuspended: vi.fn(() => false),
      bufferEvent: vi.fn(),
      remove: vi.fn(),
    } as unknown as SessionRegistry;
  });

  it('emits subagent_start when parent_tool_use_id is detected', async () => {
    const events = [
      {
        type: 'assistant',
        session_id: 'test-session',
      },
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            id: 'msg-parent',
            usage: { input_tokens: 100 },
          },
        },
        parent_tool_use_id: null,
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'tool-agent-1',
            name: 'Agent',
          },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_stop',
          index: 0,
        },
      },
      // Subagent message_start with parent_tool_use_id
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            id: 'msg-sub-1',
            usage: { input_tokens: 50 },
          },
        },
        parent_tool_use_id: 'tool-agent-1',
      },
      {
        type: 'result',
        session_id: 'test-session',
        usage: { input_tokens: 150, output_tokens: 100 },
      },
    ];

    async function* gen() {
      for (const evt of events) {
        yield evt;
      }
    }

    await runQueryLoop(gen(), 'test-client', mockRegistry, abortController);

    const subagentStart = sentEvents.find((e) => e.type === 'subagent_start');
    expect(subagentStart).toBeDefined();
    expect(subagentStart).toMatchObject({
      v: 2,
      type: 'subagent_start',
      parentToolId: 'tool-agent-1',
      subagentMessageId: 'msg-sub-1',
    });
  });

  it('wraps subagent content blocks in subagent_block_* events', async () => {
    const events = [
      {
        type: 'assistant',
        session_id: 'test-session',
      },
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg-parent', usage: { input_tokens: 100 } },
        },
        parent_tool_use_id: null,
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool-agent-1', name: 'Agent' },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      },
      // Subagent turn
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg-sub-1', usage: { input_tokens: 50 } },
        },
        parent_tool_use_id: 'tool-agent-1',
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking' },
        },
        parent_tool_use_id: 'tool-agent-1',
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Analyzing...' },
        },
        parent_tool_use_id: 'tool-agent-1',
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
        parent_tool_use_id: 'tool-agent-1',
      },
      {
        type: 'result',
        session_id: 'test-session',
        usage: { input_tokens: 150, output_tokens: 100 },
      },
    ];

    async function* gen() {
      for (const evt of events) {
        yield evt;
      }
    }

    await runQueryLoop(gen(), 'test-client', mockRegistry, abortController);

    expect(sentEvents.some((e) => e.type === 'subagent_block_start')).toBe(true);
    expect(sentEvents.some((e) => e.type === 'subagent_block_delta')).toBe(true);
    expect(sentEvents.some((e) => e.type === 'subagent_block_end')).toBe(true);
  });

  it('emits subagent_end with usage on subagent message_end', async () => {
    const events = [
      {
        type: 'assistant',
        session_id: 'test-session',
      },
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg-parent', usage: { input_tokens: 100 } },
        },
        parent_tool_use_id: null,
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool-agent-1', name: 'Agent' },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      },
      // Subagent turn
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg-sub-1', usage: { input_tokens: 50, output_tokens: 25 } },
        },
        parent_tool_use_id: 'tool-agent-1',
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text' },
        },
        parent_tool_use_id: 'tool-agent-1',
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
        parent_tool_use_id: 'tool-agent-1',
      },
      {
        type: 'assistant',
        parent_tool_use_id: 'tool-agent-1',
      },
      {
        type: 'result',
        session_id: 'test-session',
        usage: { input_tokens: 150, output_tokens: 125 },
      },
    ];

    async function* gen() {
      for (const evt of events) {
        yield evt;
      }
    }

    await runQueryLoop(gen(), 'test-client', mockRegistry, abortController);

    const subagentEnd = sentEvents.find((e) => e.type === 'subagent_end');
    expect(subagentEnd).toBeDefined();
    expect(subagentEnd).toMatchObject({
      v: 2,
      type: 'subagent_end',
      usage: {
        inputTokens: 50,
        outputTokens: 25,
      },
    });
  });
});

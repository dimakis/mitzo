// @vitest-environment node-compatible-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { runQueryLoop } from '../../server/query-loop.js';
import type { SessionRegistry } from '../../server/session-registry.js';
import { EventStore } from '../../server/event-store.js';
import { replayEventsToMessages } from '../../server/conversation-transcript.js';
import { parseServerMessage } from '../../packages/client/src/protocol-parser.js';
import {
  INITIAL_MESSAGES_STATE,
  messagesReducer,
} from '../../packages/client/src/slices/messages.js';
import { SubagentCard } from '../../frontend/src/components/SubagentCard';

afterEach(cleanup);

const stream = (event: Record<string, unknown>, parent?: string) => ({
  type: 'stream_event',
  parent_tool_use_id: parent ?? null,
  event,
});
const start = (id: string, parent?: string) =>
  stream({ type: 'message_start', message: { id } }, parent);
const parentEvents = () => [
  start('parent-message'),
  stream({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', name: 'Agent', id: 'agent-call' },
  }),
  stream({ type: 'content_block_stop', index: 0 }),
];
const taskStarted = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'task-1',
  tool_use_id: 'agent-call',
};
const notification = (status: string) => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: 'task-1',
  tool_use_id: 'agent-call',
  status,
  summary: 'private provider diagnostic',
  output_file: '/private/provider-output',
});
const childOutput = () => [
  start('child-message', 'agent-call'),
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, 'agent-call'),
  stream(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Retained public output' },
    },
    'agent-call',
  ),
  stream({ type: 'content_block_stop', index: 0 }, 'agent-call'),
];

async function run(events: Record<string, unknown>[]) {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-claude-child-'));
  const store = new EventStore(join(directory, 'events.db'));
  const sent: Record<string, unknown>[] = [];
  const session = {
    transport: {
      send: (event: Record<string, unknown>) => sent.push(event),
      isOpen: () => true,
      close: vi.fn(),
    },
    sessionId: 'test-session',
    cumulativeSessionTokens: 0,
    cumulativeCostUsd: 0,
    currentSnapshot: null,
    cwd: '/test',
    mode: 'agent',
    observers: new Set(),
    activeTaskIds: new Map<string, string>(),
  };
  const registry = {
    get: () => session,
    setSessionId: vi.fn(),
    isAttached: () => true,
    isSuspended: () => false,
    bufferEvent: vi.fn(),
    remove: vi.fn(),
  } as unknown as SessionRegistry;
  try {
    async function* source() {
      yield* events;
    }
    await runQueryLoop(source(), 'test-client', registry, new AbortController(), store);
    let state = INITIAL_MESSAGES_STATE;
    const callbacks = {
      onSessionAssigned: vi.fn(),
      onSessionExpired: vi.fn(),
      onMessagesRestored: vi.fn(),
      onSessionRenamed: vi.fn(),
      setWsRunning: vi.fn(),
    };
    for (const event of sent) {
      const parsed = parseServerMessage(
        event as never,
        { currentSessionId: 'test-session' },
        callbacks,
        'session:test-session',
      );
      for (const action of parsed.messagesActions) state = messagesReducer(state, action);
    }
    const replay = replayEventsToMessages(store.getSessionEvents('test-session'));
    return { state, replay, sent, session };
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('Claude task outcomes through adapter, client, replay and inline UI', () => {
  it.each([
    ['failed', 'failed', 'Failed'],
    ['stopped', 'cancelled', 'Cancelled'],
    ['completed', 'completed', 'Complete'],
  ])('%s preserves output and its distinct outcome', async (sdkStatus, status, label) => {
    const { state, replay, session } = await run([
      ...parentEvents(),
      taskStarted,
      ...childOutput(),
      notification(sdkStatus),
    ]);
    const live = state.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.toolId === 'agent-call')?.subagent;
    const restored = replay
      .flatMap((message) => message.blocks)
      .find((block) => block.toolId === 'agent-call')?.subagent;
    expect(live).toMatchObject({
      status,
      blocks: [expect.objectContaining({ content: 'Retained public output' })],
    });
    expect(restored).toMatchObject({
      status,
      blocks: [expect.objectContaining({ content: 'Retained public output' })],
    });
    expect(session.activeTaskIds.size).toBe(0);
    render(
      <MemoryRouter>
        <SubagentCard subagent={live!} />
      </MemoryRouter>,
    );
    expect(screen.getByText(label)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('Retained public output')).toBeTruthy();
    expect(screen.queryByText('Running...')).toBeNull();
  });

  it.each(['failed', 'stopped', 'completed'])(
    'shows %s even before any child output',
    async (status) => {
      const { state, replay } = await run([...parentEvents(), taskStarted, notification(status)]);
      const expected = status === 'stopped' ? 'cancelled' : status;
      expect(state.messages[0].blocks[0].subagent).toMatchObject({ status: expected, blocks: [] });
      expect(replay[0].blocks[0].subagent).toMatchObject({ status: expected, blocks: [] });
    },
  );

  it('does not let assistant envelopes or duplicate/late events erase a task failure', async () => {
    const { state, replay, sent, session } = await run([
      ...parentEvents(),
      taskStarted,
      ...childOutput(),
      { type: 'assistant', parent_tool_use_id: 'agent-call' },
      notification('failed'),
      notification('failed'),
      taskStarted,
      start('late-child', 'agent-call'),
      notification('completed'),
    ]);
    expect(state.messages[0].blocks[0].subagent).toMatchObject({ status: 'failed' });
    expect(replay[0].blocks[0].subagent).toMatchObject({ status: 'failed' });
    expect(sent.filter((event) => event.type === 'subagent_end')).toHaveLength(1);
    expect(session.activeTaskIds.size).toBe(0);
    expect(JSON.stringify(sent)).not.toContain('private provider diagnostic');
  });

  it('routes background completion to the original parent after a newer parent turn', async () => {
    const { state, replay } = await run([
      ...parentEvents(),
      taskStarted,
      ...childOutput(),
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'agent-call', content: 'Running in background' },
          ],
        },
      },
      { type: 'assistant' },
      start('new-parent-message'),
      notification('failed'),
    ]);
    expect(
      state.messages.find((message) => message.messageId === 'parent-message')?.blocks[0].subagent,
    ).toMatchObject({ status: 'failed' });
    expect(
      replay.find((message) => message.messageId === 'parent-message')?.blocks[0].subagent,
    ).toMatchObject({ status: 'failed' });
  });

  it('retains activity as unavailable if the query ends without a task outcome', async () => {
    const { state, replay } = await run([...parentEvents(), taskStarted, ...childOutput()]);
    expect(state.messages[0].blocks[0].subagent).toMatchObject({ status: 'unavailable' });
    expect(replay[0].blocks[0].subagent).toMatchObject({ status: 'unavailable' });
  });
});

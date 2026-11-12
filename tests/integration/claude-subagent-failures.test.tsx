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
import { reportClaudeChildDiagnostic } from '../../server/claude-child-diagnostics.js';

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

async function run(
  events: Array<
    Record<string, unknown> | ((runtime: object, activeTasks: Map<string, string>) => void)
  >,
) {
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
    queryInstance: { interrupt: vi.fn(), stopTask: vi.fn(), close: vi.fn() },
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
    const echo = {
      v: 2,
      type: 'user_message',
      sessionId: 'test-session',
      messageId: 'input-1',
      text: 'Continue',
    };
    store.append('test-session', 'user_message', echo);
    sent.push(echo);
    async function* source() {
      for (const event of events) {
        if (typeof event === 'function') event(session.queryInstance, session.activeTaskIds);
        else yield event;
      }
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
      expect(
        state.messages.find((m) => m.messageId === 'parent-message')?.blocks[0].subagent,
      ).toMatchObject({ status: expected, blocks: [] });
      expect(
        replay.find((m) => m.messageId === 'parent-message')?.blocks[0].subagent,
      ).toMatchObject({ status: expected, blocks: [] });
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
    expect(
      state.messages.find((m) => m.messageId === 'parent-message')?.blocks[0].subagent,
    ).toMatchObject({ status: 'failed' });
    expect(replay.find((m) => m.messageId === 'parent-message')?.blocks[0].subagent).toMatchObject({
      status: 'failed',
    });
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
    expect(
      state.messages.find((m) => m.messageId === 'parent-message')?.blocks[0].subagent,
    ).toMatchObject({ status: 'unavailable' });
    expect(replay.find((m) => m.messageId === 'parent-message')?.blocks[0].subagent).toMatchObject({
      status: 'unavailable',
    });
  });

  it('retains rejected stop uncertainty through the adapter, replay and inline UI', async () => {
    const diagnostic = {
      code: 'claude_child_stop_failed' as const,
      correlationId: 'stop-reference',
    };
    const { state, replay } = await run([
      ...parentEvents(),
      taskStarted,
      ...childOutput(),
      (runtime) => {
        expect(reportClaudeChildDiagnostic(runtime, 'task-1', 'agent-call', diagnostic)).toBe(true);
      },
    ]);
    for (const messages of [state.messages, replay]) {
      const subagent = messages.find((m) => m.messageId === 'parent-message')?.blocks[0].subagent;
      expect(subagent).toMatchObject({ status: 'unavailable', diagnostic });
      render(
        <MemoryRouter>
          <SubagentCard subagent={subagent as never} />
        </MemoryRouter>,
      );
      expect(screen.getByText('Status unavailable')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { expanded: false }));
      expect(screen.getByText('stop-reference')).toBeTruthy();
      expect(screen.getByText('Retained public output')).toBeTruthy();
      cleanup();
    }
  });

  it('does not infer task success from an assistant envelope before its failed notification', async () => {
    const { state, replay } = await run([
      ...parentEvents(),
      ...childOutput(),
      { type: 'assistant', parent_tool_use_id: 'agent-call' },
      notification('failed'),
    ]);
    for (const messages of [state.messages, replay])
      expect(
        messages.find((m) => m.messageId === 'parent-message')?.blocks[0].subagent,
      ).toMatchObject({ status: 'failed' });
  });

  it('keeps receiving output after stop rejection until a confirmed outcome', async () => {
    const { state, replay } = await run([
      ...parentEvents(),
      taskStarted,
      start('child-message', 'agent-call'),
      stream(
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        'agent-call',
      ),
      stream(
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Before ' } },
        'agent-call',
      ),
      (runtime) => {
        reportClaudeChildDiagnostic(runtime, 'task-1', 'agent-call', {
          code: 'claude_child_stop_failed',
          correlationId: 'reference',
        });
      },
      stream(
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'and after' } },
        'agent-call',
      ),
      stream({ type: 'content_block_stop', index: 0 }, 'agent-call'),
      notification('completed'),
    ]);
    for (const messages of [state.messages, replay]) {
      const child = messages.find((m) => m.messageId === 'parent-message')?.blocks[0].subagent;
      expect(child).toMatchObject({
        status: 'completed',
        blocks: [expect.objectContaining({ content: 'Before and after' })],
      });
    }
  });

  it('preserves every child block when background output continues across parent turns', async () => {
    const { state, replay } = await run([
      ...parentEvents(),
      taskStarted,
      ...childOutput(),
      { type: 'assistant' },
      start('new-parent'),
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', name: 'Read', id: 'new-call' },
      }),
      stream({ type: 'content_block_stop', index: 0 }),
      start('second-child-message', 'agent-call'),
      stream(
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        'agent-call',
      ),
      stream(
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Later child output' },
        },
        'agent-call',
      ),
      stream({ type: 'content_block_stop', index: 0 }, 'agent-call'),
      notification('failed'),
    ]);
    for (const messages of [state.messages, replay])
      expect(
        messages
          .find((m) => m.messageId === 'parent-message')
          ?.blocks[0].subagent?.blocks.map((b) => b.content),
      ).toEqual(['Retained public output', 'Later child output']);
  });

  it('tracks generic Bash background tasks without inventing child activity', async () => {
    const events = parentEvents();
    events[1] = stream({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', name: 'Bash', id: 'agent-call' },
    });
    let tracked = false;
    const { sent } = await run([
      ...events,
      taskStarted,
      (runtime, tasks) => {
        expect(tasks.get('task-1')).toBe('agent-call');
        tracked = reportClaudeChildDiagnostic(runtime, 'task-1', 'agent-call', {
          code: 'claude_child_stop_failed',
          correlationId: 'generic',
        });
      },
      notification('completed'),
    ]);
    // The runtime reporter exists, but a Bash task must never create a subagent.
    expect(tracked).toBe(true);
    expect(
      sent.filter(
        (e) => e.type === 'subagent_start' || e.code === 'claude_child_parent_unavailable',
      ),
    ).toHaveLength(0);
  });

  it('keeps completed sibling usage when another child updates a finalized parent', async () => {
    const { state, replay } = await run([
      ...parentEvents(),
      taskStarted,
      stream({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', name: 'Agent', id: 'second-agent' },
      }),
      stream({ type: 'content_block_stop', index: 1 }),
      { ...taskStarted, task_id: 'task-2', tool_use_id: 'second-agent' },
      stream(
        {
          type: 'message_start',
          message: { id: 'child-message', usage: { input_tokens: 50, output_tokens: 25 } },
        },
        'agent-call',
      ),
      ...childOutput().slice(1),
      notification('completed'),
      { type: 'assistant' },
      start('new-parent'),
      { ...notification('failed'), task_id: 'task-2', tool_use_id: 'second-agent' },
    ]);
    for (const messages of [state.messages, replay])
      expect(
        messages.find((m) => m.messageId === 'parent-message')?.blocks[0].subagent?.usage,
      ).toMatchObject({ inputTokens: 50, outputTokens: 25 });
  });

  it.each([false, true])(
    'uses the foreground Agent result as outcome (error=%s)',
    async (isError) => {
      const { state, replay, session } = await run([
        ...parentEvents(),
        ...childOutput(),
        { type: 'assistant', parent_tool_use_id: 'agent-call' },
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'agent-call',
                content: 'Finished',
                is_error: isError,
              },
            ],
          },
        },
      ]);
      for (const messages of [state.messages, replay])
        expect(
          messages.find((m) => m.messageId === 'parent-message')?.blocks[0].subagent,
        ).toMatchObject({ status: isError ? 'failed' : 'completed' });
      expect(
        reportClaudeChildDiagnostic(session.queryInstance, 'task-1', 'agent-call', {
          code: 'claude_child_stop_failed',
          correlationId: 'expired',
        }),
      ).toBe(false);
    },
  );

  it('keeps late output on its original parent when a newer turn reuses block IDs', async () => {
    const { state, replay } = await run([
      ...parentEvents(),
      taskStarted,
      ...childOutput(),
      { type: 'assistant' },
      start('new-parent'),
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', name: 'Read', id: 'new-call' },
      }),
      stream({ type: 'content_block_stop', index: 0 }),
      notification('failed'),
    ]);
    for (const messages of [state.messages, replay]) {
      expect(
        messages.find((m) => m.messageId === 'parent-message')?.blocks[0].subagent,
      ).toMatchObject({ status: 'failed' });
      expect(
        messages.find((m) => m.messageId === 'new-parent')?.blocks[0].subagent,
      ).toBeUndefined();
    }
  });

  it('reports an unknown parent once and never projects its child output as parent output', async () => {
    const { state, replay, sent } = await run([
      { type: 'user', uuid: 'input-1', message: { content: 'Continue' } },
      start('parent-message'),
      ...childOutput(),
      ...childOutput(),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Parent still works' },
      }),
      stream({ type: 'content_block_stop', index: 0 }),
    ]);
    expect(sent.filter((e) => e.code === 'claude_child_parent_unavailable')).toHaveLength(1);
    expect(sent.filter((e) => e.type === 'subagent_start')).toHaveLength(0);
    for (const messages of [state.messages, replay]) {
      expect(JSON.stringify(messages)).not.toContain('Retained public output');
      expect(JSON.stringify(messages)).toContain('Parent still works');
      expect(JSON.stringify(messages)).toContain('Subagent activity could not be linked');
    }
  });
});

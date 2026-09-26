import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { SymposiumSeatExecution } from '../symposium-orchestrator.js';
import {
  claudeVertexArgv,
  createClaudeVertexSeat,
  readClaudeVertexEvent,
} from '../symposium-claude-native.js';

const execution = {
  sessionId: 'symposium',
  deliveryId: 'delivery',
  claimToken: 'claim',
  idempotencyKey: 'idempotency',
  content: 'Only this routed excerpt.',
  seat: {
    id: 'reviewer',
    name: 'Reviewer',
    model: 'claude-test',
    systemPrompt: 'Review safely.',
    color: '#112233',
    role: 'reviewer',
  },
  provenance: { membershipGeneration: 2 },
  signal: new AbortController().signal,
} as SymposiumSeatExecution;
const route = {
  kind: 'claude-vertex' as const,
  provider: 'vertex-work',
  providerId: 'vertex-object',
  model: 'claude-test',
  effort: 'low',
  projectId: 'project-1',
  region: 'us-east5',
  readOnly: true,
};

describe('Claude Vertex native seat', () => {
  it('refuses the real launch path without a durable host attempt registry', async () => {
    const native = await createClaudeVertexSeat({
      sandbox: { sandboxName: 'shared', workdir: '/sandbox/workspaces/mgmt' },
      route,
      execution,
    });
    expect(() => native.run(execution, { beforeDispatch: () => {}, accepted: () => {} })).toThrow(
      /registry is unavailable/,
    );
  });
  it('uses a pinned gateway route, private thread, and tool ceiling without putting user text in argv', () => {
    const argv = claudeVertexArgv(route, execution);
    expect(argv).toContain('CLAUDE_CODE_USE_VERTEX=1');
    expect(argv).toContain('CLAUDE_CODE_SKIP_VERTEX_AUTH=1');
    expect(argv).toContain('ANTHROPIC_VERTEX_PROJECT_ID=project-1');
    expect(argv).toContain('CLOUD_ML_REGION=us-east5');
    expect(argv).toContain('--session-id');
    expect(argv).toContain('--include-partial-messages');
    expect(argv).toContain('--append-system-prompt');
    expect(argv).not.toContain('--system-prompt');
    expect(argv).toContain('Read,Glob,Grep');
    expect(argv).not.toContain(execution.content);
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv).not.toContain('--allow-dangerously-skip-permissions');
  });
  it('resumes only the provider thread pinned to this seat attempt', () => {
    const argv = claudeVertexArgv(route, {
      ...execution,
      providerThreadId: 'pinned-thread',
    } as SymposiumSeatExecution);
    expect(argv.slice(-2)).toEqual(['--resume', 'pinned-thread']);
    expect(argv).not.toContain('--session-id');
  });
  it('treats an assistant message as acceptance and ignores initialization alone', () => {
    expect(
      readClaudeVertexEvent({ type: 'system', subtype: 'init', session_id: 'thread' }),
    ).toEqual({
      kind: 'init',
      threadId: 'thread',
    });
    expect(
      readClaudeVertexEvent({
        type: 'stream_event',
        session_id: 'thread',
        event: { type: 'message_start', message: { id: 'message-1' } },
      }),
    ).toEqual({ kind: 'native', threadId: 'thread', turnId: 'message-1' });
    expect(
      readClaudeVertexEvent({
        type: 'user',
        session_id: 'thread',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] },
      }),
    ).toEqual({ kind: 'native', threadId: 'thread' });
    expect(
      readClaudeVertexEvent({
        type: 'assistant',
        session_id: 'thread',
        message: {
          id: 'message-1',
          content: [{ type: 'text', text: 'Review complete.' }],
        },
      }),
    ).toEqual({
      kind: 'assistant',
      threadId: 'thread',
      turnId: 'message-1',
      text: 'Review complete.',
    });
    expect(
      readClaudeVertexEvent({
        type: 'result',
        session_id: 'thread',
        is_error: false,
        result: 'done',
        total_cost_usd: 0.01,
      }),
    ).toEqual({
      kind: 'result',
      threadId: 'thread',
      success: true,
      costUsd: 0.01,
    });
  });
  it('accepts at native message start before forwarding text and tool events', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: NodeJS.Signals) => boolean;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const seen: string[] = [];
    const native = await createClaudeVertexSeat({
      sandbox: { sandboxName: 'shared', workdir: '/sandbox/workspaces/mgmt' },
      route,
      execution,
      spawnProcess: () => child,
      onEvent: (event) => seen.push(String(event.type)),
    });
    const argv = claudeVertexArgv(route, execution);
    const thread = argv[argv.indexOf('--session-id') + 1];
    const run = native.run(execution, {
      beforeDispatch: () => seen.push('dispatch'),
      accepted: (_thread, turn) => seen.push(`accepted:${turn}`),
    });
    const emit = (event: Record<string, unknown>) =>
      child.stdout.write(JSON.stringify(event) + '\n');
    emit({
      type: 'stream_event',
      session_id: thread,
      event: { type: 'message_start', message: { id: 'message-1' } },
    });
    emit({
      type: 'stream_event',
      session_id: thread,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
    });
    emit({
      type: 'user',
      session_id: thread,
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Done' }] },
    });
    emit({
      type: 'assistant',
      session_id: thread,
      message: { id: 'message-1', content: [{ type: 'text', text: 'Hi' }] },
    });
    emit({ type: 'result', session_id: thread, is_error: false, total_cost_usd: 0.01 });
    child.emit('close', 0);
    await expect(run).resolves.toMatchObject({ content: 'Hi', costUsd: 0.01 });
    expect(seen).toEqual([
      'dispatch',
      'accepted:message-1',
      'stream_event',
      'stream_event',
      'user',
      'assistant',
      'result',
    ]);
  });
  it('rejects a terminal result without a provider turn acceptance', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: NodeJS.Signals) => boolean;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const native = await createClaudeVertexSeat({
      sandbox: { sandboxName: 'shared', workdir: '/sandbox/workspaces/mgmt' },
      route,
      execution,
      spawnProcess: () => child,
    });
    const argv = claudeVertexArgv(route, execution);
    const thread = argv[argv.indexOf('--session-id') + 1];
    const accepted = vi.fn();
    const run = native.run(execution, { beforeDispatch: vi.fn(), accepted });
    child.stdout.write(
      JSON.stringify({ type: 'result', session_id: thread, is_error: false }) + '\n',
    );
    child.emit('close', 0);
    await expect(run).rejects.toThrow(/uncertain outcome/);
    expect(accepted).not.toHaveBeenCalled();
  });
  it('sends only the routed prompt over stdin and records acceptance after a provider assistant event', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: NodeJS.Signals) => boolean;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    let sent = '';
    child.stdin.on('data', (chunk) => {
      sent += chunk.toString();
    });
    const native = await createClaudeVertexSeat({
      sandbox: { sandboxName: 'shared', workdir: '/sandbox/workspaces/mgmt' },
      route,
      execution,
      spawnProcess: () => child,
    });
    const argv = claudeVertexArgv(route, execution);
    const thread = argv[argv.indexOf('--session-id') + 1];
    const events: string[] = [];
    const result = native.run(execution, {
      beforeDispatch: () => events.push('dispatch'),
      accepted: (_thread, turn) => events.push(turn),
    });
    child.stdout.write(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: thread }) + '\n',
    );
    expect(events).toEqual(['dispatch']);
    child.stdout.write(
      JSON.stringify({
        type: 'assistant',
        session_id: thread,
        message: {
          id: 'message-1',
          content: [{ type: 'text', text: 'Reviewed.' }],
        },
      }) + '\n',
    );
    child.stdout.write(
      JSON.stringify({
        type: 'result',
        session_id: thread,
        is_error: false,
        total_cost_usd: 0.01,
      }) + '\n',
    );
    child.emit('close', 0);
    await expect(result).resolves.toEqual({
      providerThreadId: thread,
      content: 'Reviewed.',
      costUsd: 0.01,
    });
    expect(sent).toBe('Only this routed excerpt.');
    expect(events).toEqual(['dispatch', 'message-1']);
  });
});

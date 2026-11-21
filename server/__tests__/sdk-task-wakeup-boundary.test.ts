import { afterEach, expect, it, vi } from 'vitest';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue.js';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
} from '../ordinary-local-vertex-sdk-query.js';

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../logger.js', () => ({ createLogger: () => log }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
afterEach(() => vi.clearAllMocks());

// These are current fail-closed guarantees, not an implementation of wake-up
// admission. The proposed replacement contract lives in the design document.
function fixture() {
  const runs: Array<{ options: Options; events: AsyncQueue<Record<string, unknown>> }> = [];
  vi.mocked(query).mockImplementation((request) => {
    const events = new AsyncQueue<Record<string, unknown>>();
    runs.push({ options: request.options!, events });
    return {
      close: vi.fn(),
      [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    } as never;
  });
  const controller = new AbortController();
  const promptHook = vi.fn(async () => ({ continue: true }));
  const permission = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }));
  const owner = createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
    options: {
      sessionId: 'original',
      hooks: { UserPromptSubmit: [{ hooks: [promptHook] }] },
      canUseTool: permission,
    },
    input: new AsyncQueue(),
    controller,
    lifetime: new SdkHookLifetime(),
    sdkSessionId: 'original',
    cwd: '/offline',
    authorize: async () => controller.signal.throwIfAborted(),
    authorizeSync: () => controller.signal.throwIfAborted(),
    adapt: (native) => native as never,
    settings: () => ({}),
    inputChanged: () => {},
    onUnsent: (_message, error) => {
      throw error;
    },
  });
  owner.bindCommandToolAuthority({ commandId: 'launch-command', checkTool: () => 'allow' });
  return { runs, controller, owner, promptHook, permission };
}

it.each(['completed', 'retired', 'stopped'] as const)(
  'refuses repeated task-notification prompts after the launch query is %s without reviving its callbacks',
  async (phase) => {
    const f = fixture();
    const output = f.owner.query[Symbol.asyncIterator]();
    try {
      await f.owner.apply({ model: 'first' } as never);
      if (phase === 'completed') {
        f.runs[0].events.push({
          type: 'result',
          session_id: 'original',
          result: 'launch finished',
        });
        expect((await output.next()).value).toMatchObject({ result: 'launch finished' });
      } else if (phase === 'retired') {
        await f.owner.apply({ model: 'second' } as never);
        f.owner.bindCommandToolAuthority({ commandId: 'successor', checkTool: () => 'allow' });
      } else f.controller.abort();

      // A native-looking prefix is data, not a new host admission. Replay does
      // not restore the old scope, even when the native SDK reuses its signal.
      const signal = new AbortController().signal;
      const prompt = '<task-notification>private-task-output</task-notification>';
      const retired = f.runs[0].options;
      for (let delivery = 0; delivery < 2; delivery++) {
        expect(
          await retired.hooks!.UserPromptSubmit![0].hooks[0](
            { hook_event_name: 'UserPromptSubmit', prompt } as never,
            'notification',
            { signal },
          ),
        ).toMatchObject({
          continue: false,
          stopReason: 'This completed SDK query has been retired.',
        });
        expect(
          await retired.canUseTool!(
            'Bash',
            { command: 'private-effect' },
            { signal, toolUseID: 'old' },
          ),
        ).toMatchObject({ behavior: 'deny' });
      }
      expect(f.promptHook).not.toHaveBeenCalled();
      expect(f.permission).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith('Retired SDK query refused a turn the CLI started', {
        code: 'sdk_retired_query_prompt_refused',
        stage: 'user_prompt_submit',
        commandId: 'launch-command',
        inputKind: 'task_notification',
      });
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private-');
      expect(f.controller.signal.aborted).toBe(phase === 'stopped');
      if (phase === 'retired') {
        expect(
          await f.runs[1].options.hooks!.UserPromptSubmit![0].hooks[0](
            { hook_event_name: 'UserPromptSubmit', prompt: 'new operator input' } as never,
            'successor',
            { signal },
          ),
        ).toMatchObject({ continue: true });
        expect(f.promptHook).toHaveBeenCalledOnce();
      }
    } finally {
      f.controller.abort();
      for (const run of f.runs) run.events.close();
      await output.return?.();
    }
  },
);

it.each(['success', 'error_during_execution'] as const)(
  'does not assign a refused task wake-up %s result or replay echo to the next command',
  async (subtype) => {
    const f = fixture();
    const output = f.owner.query[Symbol.asyncIterator]();
    try {
      await f.owner.apply({ model: 'first' } as never);
      f.runs[0].events.push({ type: 'result', session_id: 'original', result: 'launch finished' });
      expect((await output.next()).value).toMatchObject({ result: 'launch finished' });
      await f.owner.apply({ model: 'second' } as never);
      f.owner.bindCommandToolAuthority({ commandId: 'successor', checkTool: () => 'allow' });
      const echo = {
        type: 'user',
        session_id: 'original',
        uuid: 'notification-uuid',
        isReplay: true,
        parent_tool_use_id: null,
        message: { role: 'user', content: '<task-notification>finished</task-notification>' },
      };
      for (let delivery = 0; delivery < 2; delivery++) {
        f.runs[0].events.push({
          type: 'system',
          subtype: 'task_notification',
          task_id: 'task',
          status: 'completed',
          session_id: 'original',
        });
        f.runs[0].events.push(echo);
        f.runs[0].events.push({
          type: 'result',
          subtype,
          is_error: subtype !== 'success',
          num_turns: 1,
          session_id: 'original',
          result: 'late wake-up',
        });
      }
      f.runs[0].events.close();
      f.runs[1].events.push({
        type: 'assistant',
        session_id: 'original',
        uuid: 'successor-output',
      });
      f.runs[1].events.push({
        type: 'result',
        session_id: 'original',
        result: 'successor finished',
      });
      expect((await output.next()).value).toMatchObject({ type: 'sdk_query_retired' });
      expect(f.owner.isCommandInputEcho(echo)).toBe(false);
      expect((await output.next()).value).toMatchObject({
        type: 'assistant',
        uuid: 'successor-output',
      });
      expect((await output.next()).value).toMatchObject({
        type: 'result',
        result: 'successor finished',
      });
      expect(f.controller.signal.aborted).toBe(false);
    } finally {
      f.controller.abort();
      for (const run of f.runs) run.events.close();
      await output.return?.();
    }
  },
);

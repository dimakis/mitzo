import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  HookCallback,
  Options,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue.js';

// Qualification of the actual pinned native transport, not proof that Mitzo's
// per-command authority can safely reuse it. See docs/design/claude-process-reuse.md.
const require = createRequire(import.meta.url);
const sdk =
  require('@anthropic-ai/claude-agent-sdk') as typeof import('@anthropic-ai/claude-agent-sdk');
const executable = join(
  dirname(require.resolve('@anthropic-ai/claude-agent-sdk')),
  '..',
  `claude-agent-sdk-${process.platform}-${process.arch}`,
  'claude',
);
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const firstUuid = '11111111-1111-4111-8111-111111111111';
const secondUuid = '22222222-2222-4222-8222-222222222222';
const afterStopUuid = '33333333-3333-4333-8333-333333333333';
const user = (uuid: SDKUserMessage['uuid']): SDKUserMessage => ({
  type: 'user',
  uuid,
  session_id: '',
  parent_tool_use_id: null,
  message: { role: 'user', content: 'Synthetic offline command' },
});

function answer(response: ServerResponse, background: boolean) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type: string, data: object) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit('message_start', {
    message: {
      id: 'offline',
      type: 'message',
      role: 'assistant',
      model: 'claude-offline',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  emit('content_block_start', {
    index: 0,
    content_block: background
      ? { type: 'tool_use', id: 'toolu_background', name: 'Bash', input: {} }
      : { type: 'text', text: '' },
  });
  emit('content_block_delta', {
    index: 0,
    delta: background
      ? {
          type: 'input_json_delta',
          partial_json: JSON.stringify({
            command: 'sleep 120',
            description: 'Offline retained process',
            run_in_background: true,
          }),
        }
      : { type: 'text_delta', text: 'Offline response.' },
  });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', {
    delta: { stop_reason: background ? 'tool_use' : 'end_turn' },
    usage: { output_tokens: 1 },
  });
  emit('message_stop', {});
  response.end();
}

async function fixture(hook: HookCallback, background = false) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-cli-reuse-')));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'config'), { mode: 0o700 });
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (!request.url?.includes('messages') || request.url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"input_tokens":1}');
      } else {
        requests++;
        answer(response, background && requests === 1);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const children: ChildProcess[] = [];
  cleanups.push(() => {
    for (const child of children) {
      if (!child.pid) continue;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  });
  // The child receives only this synthetic environment, never the host's
  // provider selection, auth variables, proxy credentials or login files.
  const offlineEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: home,
    CLAUDE_CODE_TMPDIR: home,
    CLAUDE_CONFIG_DIR: join(home, 'config'),
    ANTHROPIC_API_KEY: 'offline-only',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
  };
  const options: Options = {
    cwd: home,
    pathToClaudeCodeExecutable: executable,
    settingSources: [],
    model: 'claude-offline',
    permissionMode: 'default',
    canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
    hooks: { UserPromptSubmit: [{ hooks: [hook] }], Stop: [{ hooks: [hook] }] },
    extraArgs: { 'replay-user-messages': null },
    spawnClaudeCodeProcess: (options) => {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: offlineEnv,
        detached: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      children.push(child);
      return child;
    },
    env: offlineEnv,
  };
  const input = new AsyncQueue<SDKUserMessage>();
  const native = sdk.query({ prompt: input, options });
  const deadline = setTimeout(() => native.close(), 25_000);
  cleanups.push(() => {
    clearTimeout(deadline);
    input.close();
    native.close();
  });
  return { native, input, children, requests: () => requests };
}

it.skipIf(!existsSync(executable))(
  'keeps one native process but exposes no input UUID in the pre-effect prompt hook',
  async () => {
    const order: Array<{ type: string; uuid?: string; promptId?: string }> = [];
    const prompts: Array<Record<string, unknown>> = [];
    const f = await fixture(async (data) => {
      order.push({ type: data.hook_event_name, promptId: data.prompt_id });
      if (data.hook_event_name === 'UserPromptSubmit')
        prompts.push(data as unknown as Record<string, unknown>);
      return {};
    });
    f.input.push(user(firstUuid));
    const results: SDKMessage[] = [];
    for await (const event of f.native) {
      order.push({ type: event.type, uuid: event.uuid });
      if (event.type === 'result') {
        results.push(event);
        if (results.length === 2) break;
        f.input.push(user(secondUuid));
      }
    }
    expect(f.children).toHaveLength(1);
    expect(f.requests()).toBe(2);
    expect(results).toEqual([
      expect.objectContaining({ subtype: 'success', user_message_uuid: firstUuid }),
      expect.objectContaining({ subtype: 'success', user_message_uuid: secondUuid }),
    ]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].prompt_id).not.toBe(prompts[1].prompt_id);
    for (const [index, uuid] of [firstUuid, secondUuid].entries()) {
      const prompt = prompts[index];
      expect(prompt.prompt_id).toEqual(expect.any(String));
      expect(prompt.prompt_id).not.toBe(uuid);
      // These assertions intentionally pin the observed gap. An SDK upgrade that
      // supplies a witness needs a reviewed qualification, not a silent fallback.
      expect(prompt).not.toHaveProperty('user_message_uuid');
      expect(prompt).not.toHaveProperty('uuid');
      expect(prompt).not.toHaveProperty('source');
      expect(
        order.findIndex((e) => e.type === 'UserPromptSubmit' && e.promptId === prompt.prompt_id),
      ).toBeLessThan(order.findIndex((e) => e.type === 'user' && e.uuid === uuid));
    }
  },
  30_000,
);

it.skipIf(!existsSync(executable))(
  'refuses before any provider request when the prompt hook lacks a required native witness',
  async () => {
    let refused = 0;
    const f = await fixture(async (data) => {
      if (data.hook_event_name !== 'UserPromptSubmit') return {};
      refused++;
      return { continue: false, stopReason: 'Offline qualification: input witness unavailable' };
    });
    f.input.push(user(firstUuid));
    for await (const event of f.native) if (event.type === 'result') break;
    expect(refused).toBe(1);
    expect(f.requests()).toBe(0);
  },
  30_000,
);

it.skipIf(!existsSync(executable))(
  'retains a real background task across the next message and stops only that task',
  async () => {
    const f = await fixture(async () => ({}), true);
    const events: SDKMessage[] = [];
    let taskId: string | undefined;
    let results = 0;
    let stopped = false;
    let continued = false;
    f.input.push(user(firstUuid));
    for await (const event of f.native) {
      events.push(event);
      if (event.type === 'system' && event.subtype === 'task_started') taskId = event.task_id;
      if (event.type === 'result') {
        if ('user_message_uuid' in event && event.user_message_uuid === afterStopUuid) {
          expect(event).toMatchObject({ subtype: 'success' });
          continued = true;
          break;
        }
        if (stopped) continue; // Any CLI-generated notification turn is not our input.
        results++;
        expect(event).toMatchObject({ subtype: 'success' });
        if (results === 1) f.input.push(user(secondUuid));
        else if (results === 2) {
          expect(taskId).toBeDefined();
          expect(events.some((e) => e.type === 'system' && e.subtype === 'task_notification')).toBe(
            false,
          );
          await f.native.stopTask(taskId!);
        }
      }
      if (
        results >= 2 &&
        event.type === 'system' &&
        event.subtype === 'task_notification' &&
        event.task_id === taskId
      ) {
        expect(event.status).toBe('stopped');
        stopped = true;
        f.input.push(user(afterStopUuid));
      }
    }
    expect(stopped).toBe(true);
    expect(continued).toBe(true);
    expect(f.children).toHaveLength(1);
    expect(results).toBe(2);
    expect(events.filter((e) => e.type === 'result')[1]).toMatchObject({
      user_message_uuid: secondUuid,
    });
  },
  30_000,
);

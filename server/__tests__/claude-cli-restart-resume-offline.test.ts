import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue.js';

// Offline proof against the real bundled Claude CLI that a server restart in the
// middle of a tool call leaves a resumable SDK session: the whole CLI process
// group is SIGKILLed while Bash runs, then the next user message resumes it.
// The only provider is a loopback mock of the Messages API; no model is called.
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

type Event = [string, Record<string, unknown>];
function stream(response: import('node:http').ServerResponse, events: Event[]) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [type, data] of events)
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  response.end();
}
const start = (id: string): Event => [
  'message_start',
  {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-offline',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
];
/** First request runs a side-effecting long Bash; later requests answer text. */
async function mockMessagesApi(marker: string) {
  const requests: Array<Array<{ role: string; content: unknown }>> = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (!request.url?.includes('messages') || request.url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"input_tokens":1}');
        return;
      }
      const messages = (JSON.parse(body || '{}') as { messages?: [] }).messages ?? [];
      requests.push(messages);
      if (!JSON.stringify(messages).includes('toolu_restart'))
        return stream(response, [
          start('tool'),
          [
            'content_block_start',
            {
              index: 0,
              content_block: { type: 'tool_use', id: 'toolu_restart', name: 'Bash', input: {} },
            },
          ],
          [
            'content_block_delta',
            {
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify({
                  command: `echo ran >> '${marker}'; sleep 120; echo done >> '${marker}'`,
                  description: 'Long side-effecting command',
                }),
              },
            },
          ],
          ['content_block_stop', { index: 0 }],
          ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }],
          ['message_stop', {}],
        ]);
      stream(response, [
        start(`text-${requests.length}`),
        ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Resumed.' } }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
        ['message_stop', {}],
      ]);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, requests };
}
const user = (text: string): SDKUserMessage => ({
  type: 'user',
  session_id: '',
  parent_tool_use_id: null,
  message: { role: 'user', content: text },
});

it.skipIf(!existsSync(executable))(
  'resumes a session whose CLI was killed mid tool call without replaying the tool',
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-cli-restart-')));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    await mkdir(join(home, 'config'), { mode: 0o700 });
    const marker = join(home, 'marker');
    const api = await mockMessagesApi(marker);
    const children: ChildProcess[] = [];
    // Like the server's SDK boundary: the CLI runs in its own process group.
    const spawnDetached: NonNullable<
      Parameters<typeof sdk.query>[0]['options']
    >['spawnClaudeCodeProcess'] = (options) => {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      children.push(child);
      return child;
    };
    const killGroups = () => {
      for (const child of children)
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch (error) {
          // Only an already-exited group is expected here.
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
    };
    cleanups.push(killGroups);
    const options = {
      cwd: home,
      pathToClaudeCodeExecutable: executable,
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      model: 'claude-offline',
      spawnClaudeCodeProcess: spawnDetached,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: home,
        CLAUDE_CODE_TMPDIR: home,
        CLAUDE_CONFIG_DIR: join(home, 'config'),
        ANTHROPIC_API_KEY: 'offline-only',
        ANTHROPIC_BASE_URL: api.url,
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    };

    const firstInput = new AsyncQueue<SDKUserMessage>();
    const first = sdk.query({ prompt: firstInput, options });
    cleanups.push(() => first.close());
    firstInput.push(user('Run the long command'));
    let sessionId: string | undefined;
    let firstResult: SDKMessage | undefined;
    const drained = (async () => {
      try {
        for await (const event of first) {
          sessionId ??= event.session_id || undefined;
          if (event.type === 'result') firstResult = event;
        }
      } catch (error) {
        // The killed CLI ends this query with a transport error: the simulated restart.
        return error;
      }
    })();
    const deadline = Date.now() + 30_000;
    while (!existsSync(marker) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(marker)).toBe(true);
    // The server dies mid tool call: its CLI process group goes with it.
    killGroups();
    firstInput.close();
    await drained;
    expect(sessionId).toBeDefined();
    // The cut turn never produced a result.
    expect(firstResult).toBeUndefined();

    const nextInput = new AsyncQueue<SDKUserMessage>();
    const next = sdk.query({ prompt: nextInput, options: { ...options, resume: sessionId } });
    cleanups.push(() => next.close());
    nextInput.push(user('What happened? Continue.'));
    const seen: SDKMessage[] = [];
    for await (const event of next) {
      seen.push(event);
      if (event.type === 'result') break;
    }

    expect(seen.at(-1)).toMatchObject({ type: 'result', subtype: 'success', is_error: false });
    // One request ran the tool and one carried the explicit next message: the
    // CLI sent nothing on its own after resuming.
    expect(api.requests).toHaveLength(2);
    const resumed = JSON.stringify(api.requests[1]);
    expect(resumed).toContain('What happened? Continue.');
    const toolResult = api.requests[1]!.flatMap((message) =>
      Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [],
    ).find((block) => block.type === 'tool_result' && block.tool_use_id === 'toolu_restart');
    // The cut call is recorded as an error with an unknown outcome, not replayed.
    expect(toolResult).toMatchObject({ is_error: true });
    expect(await readFile(marker, 'utf8')).toBe('ran\n');
  },
  90_000,
);

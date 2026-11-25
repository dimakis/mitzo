import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue.js';

// Offline replay of chat df1fd50b against the real bundled Claude CLI: a long
// foreground Bash runs, a 'next'-priority steer is queued, then Stop sends the
// native interrupt. The only provider is a loopback mock of the Messages API;
// credentials and homes are synthetic. No model is called.
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
/** First request runs a long foreground Bash; every later request answers text. */
async function mockMessagesApi() {
  let requests = 0;
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (!request.url?.includes('messages') || request.url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"input_tokens":1}');
        return;
      }
      requests++;
      const messages = JSON.stringify(
        (JSON.parse(body || '{}') as { messages?: unknown }).messages,
      );
      if (!messages.includes('tool_result'))
        return stream(response, [
          start('tool'),
          [
            'content_block_start',
            {
              index: 0,
              content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
            },
          ],
          [
            'content_block_delta',
            {
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify({
                  command: 'node -e "setTimeout(() => {}, 120000)"',
                  description: 'Long foreground command',
                }),
              },
            },
          ],
          ['content_block_stop', { index: 0 }],
          ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }],
          ['message_stop', {}],
        ]);
      stream(response, [
        start(`text-${requests}`),
        ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Paused.' } }],
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
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}
const user = (uuid: string, text: string, priority?: 'next'): SDKUserMessage => ({
  type: 'user',
  uuid: uuid as SDKUserMessage['uuid'],
  session_id: '',
  parent_tool_use_id: null,
  ...(priority ? { priority } : {}),
  message: { role: 'user', content: text },
});

it.skipIf(!existsSync(executable))(
  'ends a running tool turn on interrupt even with a queued steer, then runs the steer as a separate turn',
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-cli-stop-')));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    await mkdir(join(home, 'config'), { mode: 0o700 });
    const input = new AsyncQueue<SDKUserMessage>();
    const native = sdk.query({
      prompt: input,
      options: {
        cwd: home,
        pathToClaudeCodeExecutable: executable,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        model: 'claude-offline',
        extraArgs: { 'replay-user-messages': null },
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: home,
          CLAUDE_CODE_TMPDIR: home,
          CLAUDE_CONFIG_DIR: join(home, 'config'),
          ANTHROPIC_API_KEY: 'offline-only',
          ANTHROPIC_BASE_URL: await mockMessagesApi(),
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
      },
    });
    cleanups.push(() => native.close());
    input.push(user('11111111-1111-4111-8111-111111111111', 'Run the long command'));
    const seen: SDKMessage[] = [];
    let interruptedAt: number | undefined;
    for await (const event of native) {
      seen.push(event);
      if (event.type === 'system' && event.subtype === 'task_started' && !interruptedAt) {
        input.push(user('22222222-2222-4222-8222-222222222222', 'lets pause safely here', 'next'));
        await new Promise((resolve) => setTimeout(resolve, 500));
        interruptedAt = Date.now();
        await native.interrupt();
      }
      if (seen.filter((e) => e.type === 'result').length === 2) break;
    }
    const results = seen.filter((e) => e.type === 'result');
    const echoes = seen.filter(
      (e): e is SDKUserMessage => e.type === 'user' && typeof e.message.content === 'string',
    );
    // The interrupt ends the tool turn promptly with its own result...
    expect(interruptedAt).toBeDefined();
    expect(results[0]).toMatchObject({ subtype: 'error_during_execution', is_error: true });
    // ...and the queued steer is echoed only afterwards, as a separate turn with
    // its own result. Mitzo's Stop must therefore settle on the first result.
    expect(echoes.map((e) => e.uuid)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect(seen.indexOf(echoes[1]!)).toBeGreaterThan(seen.indexOf(results[0]!));
    expect(results[1]).toMatchObject({ subtype: 'success' });
  },
  60_000,
);

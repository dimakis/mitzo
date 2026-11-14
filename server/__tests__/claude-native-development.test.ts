import './fixtures/offline-user-home.js';
import { expect, it } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { claudePersonalToolPermission } from '../claude-personal-policy.js';
import {
  buildPermissionHandler,
  SessionRegistry,
  resolvePending,
  setSkillPolicy,
  getPendingRequestsBySession,
} from '@mitzo/harness';
import { buildSessionPermissionHooks } from '../session-permission-policy.js';

// Real Bash tool execution with canned Messages responses, entirely on loopback.
// Synthetic API auth substitutes only for inference: no real model or login.
it('executes or refuses native SDK Bash through the canonical permission owner for Vertex and personal policies', async () => {
  const require = createRequire(import.meta.url);
  const executable = join(
    dirname(require.resolve('@anthropic-ai/claude-agent-sdk')),
    '..',
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    'claude',
  );
  const observations = [];
  const scenarios = [
    { provider: 'vertex-like', mode: 'auto', decision: 'automatic', allowed: true },
    { provider: 'personal-policy', mode: 'auto', decision: 'automatic', allowed: true },
    { provider: 'enmaas-like', mode: 'auto', decision: 'automatic', allowed: true },
    { provider: 'vertex-like', mode: 'ask', decision: 'automatic', allowed: false },
    { provider: 'personal-policy', mode: 'agent', decision: 'once', allowed: true },
    { provider: 'vertex-like', mode: 'agent', decision: 'deny', allowed: false },
    { provider: 'personal-policy', mode: 'agent', decision: 'cancel', allowed: false },
    { provider: 'vertex-like', mode: 'agent', decision: 'revoked', allowed: false },
    { provider: 'personal-policy', mode: 'agent', decision: 'interrupt', allowed: false },
    { provider: 'personal-policy', mode: 'auto', decision: 'restricted-skill', allowed: false },
    { provider: 'vertex-like', mode: 'auto', decision: 'workspace', allowed: false },
  ] as const;
  for (const scenario of scenarios) {
    const { provider, mode, decision } = scenario;
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-command-diagnostic-')));
    const config = join(root, 'account'),
      cwd = join(root, 'repo'),
      temporary = join(root, 'tmp');
    for (const path of [config, cwd, temporary]) mkdirSync(path, { mode: 0o700 });
    execFileSync('git', ['init', '-q', cwd], {
      env: { PATH: process.env.PATH!, TMPDIR: temporary },
    });
    const command = `pwd && git status --short && printf inside > probe.txt && git init -q '${root}/second-repo' && printf outside > '${root}/second-repo/probe.txt'`;
    let received: unknown;
    let calls = 0;
    const server = createServer(async (request, response) => {
      let data = '';
      for await (const chunk of request) data += String(chunk);
      if (request.url?.includes('count_tokens')) {
        response.setHeader('content-type', 'application/json');
        response.end('{"input_tokens":10}');
        return;
      }
      const body = JSON.parse(data);
      calls++;
      const toolResults = body.messages
        ?.flatMap((message: { content: unknown }) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .filter((content: { type?: string }) => content.type === 'tool_result');
      if (toolResults?.length) received = toolResults;
      const tool = !toolResults?.length;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (type: string, value: unknown) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
      event('message_start', {
        type: 'message_start',
        message: {
          id: `offline-${calls}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      });
      event('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: tool
          ? { type: 'tool_use', id: 'offline-bash', name: 'Bash', input: {} }
          : { type: 'text', text: '' },
      });
      event('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: tool
          ? {
              type: 'input_json_delta',
              partial_json: JSON.stringify({
                command,
                description: 'Offline repository probe',
                timeout: 10000,
              }),
            }
          : { type: 'text_delta', text: 'Offline probe complete.' },
      });
      event('content_block_stop', { type: 'content_block_stop', index: 0 });
      event('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 10 },
      });
      event('message_stop', { type: 'message_stop' });
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Offline endpoint unavailable');
    const controller = new AbortController();
    const sessionController = new AbortController();
    const registry = new SessionRegistry();
    const cards: Record<string, unknown>[] = [];
    let current = true;
    registry.register('native-fixture', {
      sessionId: 'native-fixture',
      cwd,
      mode,
      abortController: sessionController,
      sessionAllowList: new Set(),
      transport: {
        isOpen: () => true,
        send: (event) => {
          if (event.type !== 'permission_request') return;
          cards.push(event);
          queueMicrotask(() => {
            if (decision === 'interrupt') void native!.interrupt();
            else if (decision === 'cancel') sessionController.abort();
            else {
              if (decision === 'revoked') current = false;
              resolvePending(
                String(event.permId),
                decision === 'deny' ? 'deny' : decision === 'revoked' ? 'always' : 'once',
                undefined,
                'native-fixture',
              );
            }
          });
        },
      },
    });
    if (decision === 'workspace')
      registry
        .get('native-fixture')!
        .worktreePaths.set('repo', { path: cwd, wtId: 'native-fixture' });
    if (decision === 'restricted-skill') setSkillPolicy(registry, 'native-fixture', ['Read']);
    const sharedDecision = buildPermissionHandler('native-fixture', registry, {
      assertCurrentSync() {
        if (!current) throw Error('Synthetic account/workspace authority revoked');
      },
    });
    const decide: typeof sharedDecision = (name, input, options) => {
      const personal =
        provider === 'personal-policy'
          ? claudePersonalToolPermission(name, input, cwd, config)
          : undefined;
      return personal ? Promise.resolve(personal) : sharedDecision(name, input, options);
    };
    const env = {
      HOME: root,
      CLAUDE_CONFIG_DIR: config,
      PATH: process.env.PATH!,
      TMPDIR: temporary,
      CLAUDE_CODE_TMPDIR: temporary,
      ANTHROPIC_API_KEY: 'offline-synthetic',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_AUTOUPDATER: '1',
      ...(provider === 'enmaas-like' ? { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } : {}),
    };
    let stderr = '';
    let native: ReturnType<typeof query> | undefined;
    const observe = () => ({
      ...scenario,
      calls,
      received,
      cards: cards.length,
      retainedGrants: registry.get('native-fixture')!.sessionAllowList.size,
      pendingAtResult: getPendingRequestsBySession('native-fixture').length,
      insideWritten: existsSync(join(cwd, 'probe.txt')),
      siblingWritten: existsSync(join(root, 'second-repo', 'probe.txt')),
      stderr,
    });
    const timer = setTimeout(() => controller.abort(Error('Offline Bash probe deadline')), 20000);
    try {
      native = query({
        prompt: 'Run the supplied offline repository probe.',
        options: {
          cwd,
          env,
          abortController: controller,
          pathToClaudeCodeExecutable: executable,
          persistSession: false,
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          permissionMode: mode === 'ask' ? 'plan' : 'default',
          maxTurns: 3,
          tools: ['Bash'],
          canUseTool: decide,
          hooks: buildSessionPermissionHooks(decide),
          spawnClaudeCodeProcess: (options) => {
            const child = spawn(options.command, options.args, {
              cwd,
              env,
              stdio: ['pipe', 'pipe', 'pipe'],
              signal: controller.signal,
            });
            child.stderr.on('data', (chunk) => {
              stderr = (stderr + String(chunk)).slice(-1500);
            });
            return child;
          },
        },
      });
      for await (const message of native) {
        if (message.type === 'result' && message.is_error) stderr += JSON.stringify(message);
      }
      observations.push(observe());
    } catch (error) {
      observations.push({ ...observe(), error: String(error) });
    } finally {
      clearTimeout(timer);
      native?.close();
      controller.abort();
      sessionController.abort();
      registry.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(root, { recursive: true, force: true });
    }
  }
  for (const [index, scenario] of scenarios.entries()) {
    const observation = observations[index];
    if (scenario.decision !== 'interrupt') expect(observation).not.toHaveProperty('error');
    expect(observation, JSON.stringify(observation, null, 2)).toMatchObject({
      ...scenario,
      insideWritten: scenario.allowed,
      siblingWritten: scenario.allowed,
      cards: ['once', 'deny', 'cancel', 'revoked', 'interrupt'].includes(scenario.decision) ? 1 : 0,
      retainedGrants: 0,
      pendingAtResult: 0,
      ...(scenario.decision === 'interrupt'
        ? {}
        : {
            received: [
              expect.objectContaining({
                tool_use_id: 'offline-bash',
                ...(scenario.allowed ? {} : { is_error: true }),
              }),
            ],
          }),
    });
  }
}, 120000);

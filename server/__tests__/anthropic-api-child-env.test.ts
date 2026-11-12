import './fixtures/offline-user-home.js';
import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AccountProfiles } from '../account-profiles.js';
import { AnthropicApiCustody } from '../anthropic-api-custody.js';
import {
  lockedClaudeExecutable,
  lockedClaudeBashCredentialObservation,
  lockedClaudeStartupMode,
  lockedClaudeControlMode,
} from './fixtures/native-claude-qualification.js';

const keychain = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../keychain-rotation-credentials.js', () => ({
  KeychainRotationCredentials: class {
    read = keychain.read;
  },
}));

it.each(['api-key', 'bearer'] as const)(
  'keeps %s authentication at the locked SDK boundary and out of native Bash children',
  async (authentication) => {
    const version = 'eec02914-ac1f-4369-ab86-8e4f130abc92';
    const synthetic = 'offline-synthetic-billing-sentinel';
    keychain.read.mockResolvedValue({ value: synthetic, version, managed: true });
    const profiles = new AccountProfiles([
      {
        id: 'synthetic',
        label: 'Synthetic',
        provider: 'anthropic-api',
        credentialRef: {
          provider: 'keychain',
          service: 'mitzo.anthropic.fixture',
          account: 'api-key',
        },
        credentialVersion: version,
        connection: {
          endpoint: 'https://models.example.com',
          protocol: 'messages',
          authentication,
          qualification: {
            source: 'operator',
            streaming: true,
            toolCalls: true,
            continuation: true,
            cancellation: true,
          },
        },
        models: [{ id: 'hosted/claude', label: 'Synthetic model' }],
      },
    ]);
    const base = profiles.sdkEnv(profiles.resolve('synthetic', 'hosted/claude'), {
      PATH: '/usr/bin:/bin',
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
    });
    const custody = AnthropicApiCustody.capture(base);
    const env = await custody.inferenceEnvironment(base, new AbortController().signal);
    let received: NodeJS.ProcessEnv | undefined;
    let args: string[] = [];
    const capture = async () => {
      const native = query({
        prompt: 'Offline boundary qualification',
        options: {
          env,
          model: 'gateway/claude:latest',
          pathToClaudeCodeExecutable: lockedClaudeExecutable,
          persistSession: false,
          settingSources: [],
          mcpServers: {},
          spawnClaudeCodeProcess: (input) => {
            received = input.env;
            args = input.args;
            throw Error('OFFLINE_STOP_BEFORE_CLAUDE_START');
          },
        },
      });
      await native[Symbol.asyncIterator]().next();
      throw Error('Unexpected offline SDK output');
    };
    await expect(capture()).rejects.toThrow('OFFLINE_STOP_BEFORE_CLAUDE_START');
    const selected = authentication === 'bearer' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY';
    expect(received?.[selected] === synthetic).toBe(true);
    expect(received?.ANTHROPIC_BASE_URL).toBe('https://models.example.com');
    expect(received?.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-ts');
    expect(args).toContain('--model=gateway/claude:latest');
    const observed = await lockedClaudeBashCredentialObservation(received!);
    expect(observed).toBe('scrubbed');
    expect(received?.[selected] === synthetic).toBe(true);
    expect(() =>
      custody.assertCurrent({ ...base, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0' }),
    ).toThrow();
  },
  20000,
);

it('the installed SDK control API restores plan after scrub startup without sending model input', async () => {
  const env = { PATH: '/usr/bin:/bin', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' };
  let mode = lockedClaudeStartupMode(env, 'plan');
  expect(mode).toBe('default');
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  let buffer = '';
  const subtypes: string[] = [];
  let userInputs = 0;
  stdin.on('data', (chunk) => {
    buffer += String(chunk);
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.type === 'user') userInputs++;
      if (message.type !== 'control_request') continue;
      subtypes.push(message.request.subtype);
      let response = {};
      if (message.request.subtype === 'set_permission_mode') {
        const accepted = lockedClaudeControlMode(message.request.mode, mode);
        mode = accepted.mode;
        response = { mode };
      }
      stdout.write(
        JSON.stringify({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: message.request_id,
            response,
          },
        }) + '\n',
      );
    }
  });
  const process = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    exitCode: null,
    kill: () => {
      stdout.end();
      stderr.end();
      process.emit('close', 0, null);
      return true;
    },
  });
  const prompt = new (await import('../async-queue.js')).AsyncQueue<
    import('@anthropic-ai/claude-agent-sdk').SDKUserMessage
  >();
  const native = query({
    prompt,
    options: {
      env,
      permissionMode: 'plan',
      pathToClaudeCodeExecutable: lockedClaudeExecutable,
      settingSources: [],
      mcpServers: {},
      spawnClaudeCodeProcess: () => process,
    },
  });
  try {
    await native.setPermissionMode('plan');
    expect(subtypes).toEqual(['initialize', 'set_permission_mode']);
    expect(mode).toBe('plan');
    expect(userInputs).toBe(0);
  } finally {
    prompt.close();
    native.close();
  }
});

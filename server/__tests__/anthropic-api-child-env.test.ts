import './fixtures/offline-user-home.js';
import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AccountProfiles } from '../account-profiles.js';
import { AnthropicApiCustody } from '../anthropic-api-custody.js';
import {
  lockedClaudeExecutable,
  lockedClaudeSubprocessEnvironment,
} from './fixtures/locked-claude-subprocess-env.js';

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
    const capture = async () => {
      const native = query({
        prompt: 'Offline boundary qualification',
        options: {
          env,
          pathToClaudeCodeExecutable: lockedClaudeExecutable,
          persistSession: false,
          settingSources: [],
          mcpServers: {},
          spawnClaudeCodeProcess: (input) => {
            received = input.env;
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
    const childEnv = lockedClaudeSubprocessEnvironment(received!);
    const observed = execFileSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        'if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$ANTHROPIC_AUTH_TOKEN" ]; then printf scrubbed; else printf inherited; fi',
      ],
      { env: childEnv, encoding: 'utf8' },
    );
    expect(observed).toBe('scrubbed');
    expect(received?.[selected] === synthetic).toBe(true);
    expect(() =>
      custody.assertCurrent({ ...base, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0' }),
    ).toThrow();
  },
);

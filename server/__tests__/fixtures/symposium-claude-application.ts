import { afterAll, expect, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { createApplicationJourney } from './symposium-application-journey.js';
import { sdkInputReplay, sdkQueryPeer } from './sdk-query-peer.js';

const observed = vi.hoisted(() => ({
  inputs: [] as Array<{ sessionId: string; text: string }>,
  holdNext: false,
  settle: undefined as (() => void) | undefined,
  interrupts: 0,
  holdInputAuthority: false,
  releaseInput: undefined as (() => void) | undefined,
}));
export function sdkApplicationState() {
  return observed;
}
vi.mock('../../claude-account-history.js', () => ({
  readClaudeAccountHistory: async (sessionId: string, cwd: string) => ({
    info: { sessionId, cwd },
    messages: [{ type: 'user', uuid: 'retained-offline-input' }],
  }),
}));
vi.mock('../../credential-sdk-boundary.js', async (original) => ({
  ...(await original<object>()),
  credentialSdkBoundary: (await import('./sdk-query-peer.js')).sdkFixtureBoundary,
  runtimeFilesystemSdkBoundary: (await import('./sdk-query-peer.js')).sdkFixtureBoundary,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  getSessionInfo: async (sessionId: string, options: { dir: string }) => ({
    sessionId,
    cwd: options.dir,
  }),
  getSessionMessages: async () => [{ type: 'user', uuid: 'retained-offline-input' }],
  query: vi.fn((request) => {
    const sessionId = request.options.sessionId ?? request.options.resume;
    const stream = async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        tools: [],
        model: 'fixture-model',
      };
      for await (const input of request.prompt) {
        const content = input.message.content;
        const text =
          typeof content === 'string'
            ? content
            : content.map((block: { text?: string }) => block.text ?? '').join('');
        observed.inputs.push({ sessionId, text });
        const uuid = input.uuid ?? `private-claude-input-${observed.inputs.length}`;
        yield sdkInputReplay({ ...input, uuid }, sessionId);
        if (observed.holdNext) {
          observed.holdNext = false;
          await new Promise<void>((resolve) => {
            observed.settle = resolve;
          });
          observed.settle = undefined;
        }
        yield {
          type: 'stream_event',
          session_id: sessionId,
          parent_tool_use_id: null,
          event: {
            type: 'message_start',
            message: {
              id: `claude-visible-${observed.inputs.length}`,
              role: 'assistant',
              content: [],
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
        };
        yield {
          type: 'stream_event',
          session_id: sessionId,
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
        };
        yield {
          type: 'stream_event',
          session_id: sessionId,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Personal Claude reviewed the selected design.' },
          },
        };
        yield {
          type: 'stream_event',
          session_id: sessionId,
          event: { type: 'content_block_stop', index: 0 },
        };
        yield { type: 'stream_event', session_id: sessionId, event: { type: 'message_stop' } };
        yield {
          type: 'assistant',
          session_id: sessionId,
          uuid: `assistant-event-${observed.inputs.length}`,
          parent_tool_use_id: null,
          message: {
            id: `claude-visible-${observed.inputs.length}`,
            type: 'message',
            role: 'assistant',
            model: 'fixture-model',
            content: [{ type: 'text', text: 'Personal Claude reviewed the selected design.' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: 'result',
          session_id: sessionId,
          subtype: 'success',
          is_error: false,
          result: 'Personal Claude reviewed the selected design.',
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
        };
      }
    };
    return Object.assign(sdkQueryPeer(request, stream()), {
      accountInfo: async () => {
        if (observed.holdInputAuthority) {
          observed.holdInputAuthority = false;
          await new Promise<void>((resolve) => {
            observed.releaseInput = resolve;
          });
          observed.releaseInput = undefined;
        }
        return {
          email: 'claude@example.invalid',
          subscriptionType: 'max',
          apiProvider: 'firstParty',
          apiKeySource: 'none',
        };
      },
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      setPermissionMode: async () => {},
      interrupt: async () => {
        observed.interrupts++;
      },
    });
  }),
}));

export const journey = createApplicationJourney({
  retainedArtifactOwner: true,
  additionalAccountIds: ['offline-api', 'offline-messages'],
  participant: {
    accountId: 'offline-claude',
    harness: 'claude-sdk',
    targetId: 'offline-claude-target',
  },
  configureExternalTarget: async (root, fresh) => {
    const { KeychainCredentialProvider } = await import('../../credentials.js');
    vi.spyOn(KeychainCredentialProvider.prototype, 'resolve').mockImplementation(async (ref) => {
      expect(ref).toEqual({ provider: 'keychain', service: 'offline-test', account: 'api' });
      return 'synthetic-api-key';
    });
    const { KeychainRotationCredentials } = await import('../../keychain-rotation-credentials.js');
    const read = KeychainRotationCredentials.prototype.read;
    vi.spyOn(KeychainRotationCredentials.prototype, 'read').mockImplementation((ref, signal) =>
      ref.service === 'offline-messages'
        ? Promise.resolve({
            value: 'synthetic-messages-key',
            version: 'eec02914-ac1f-4369-ab86-8e4f130abc92',
            managed: true,
          })
        : read.call(new KeychainRotationCredentials(), ref, signal),
    );
    const config = join(root, 'claude-subscription');
    const executable = join(root, 'inert-claude');
    const target = join(root, 'claude-target.json');
    const { ClaudeSubscriptionCustody } = await import('../../claude-subscription-custody.js');
    const capture = ClaudeSubscriptionCustody.capture;
    vi.spyOn(ClaudeSubscriptionCustody, 'capture').mockImplementation((env) =>
      capture(env, executable),
    );
    vi.spyOn(ClaudeSubscriptionCustody.prototype, 'verify').mockResolvedValue();
    if (fresh) {
      await mkdir(config, { mode: 0o700 });
      await writeFile(executable, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
      const { ordinaryLocalVertexContractRevision } =
        await import('../../ordinary-local-vertex-capabilities.js');
      await writeFile(
        target,
        JSON.stringify({
          version: 1,
          targetId: 'offline-claude-target',
          label: 'Offline Claude',
          hostId: hostname(),
          runtimeContractRevision: ordinaryLocalVertexContractRevision(),
        }),
        { mode: 0o600 },
      );
      const path = join(root, 'accounts.json');
      const accounts = JSON.parse(await readFile(path, 'utf8'));
      accounts.push({
        id: 'offline-claude',
        label: 'Personal Claude subscription',
        provider: 'anthropic-claude',
        credentialRef: config,
        email: 'claude@example.invalid',
        planType: 'max',
        models: [{ id: 'fixture-model', label: 'Offline Claude', reasoningEfforts: ['low'] }],
      });
      accounts.push({
        id: 'offline-api',
        label: 'Separate API-key participant',
        provider: 'openai',
        credentialRef: { provider: 'keychain', service: 'offline-test', account: 'api' },
        models: [{ id: 'fixture-model', label: 'Offline API', reasoningEfforts: ['low'] }],
      });
      accounts.push({
        id: 'offline-messages',
        label: 'Qualified Anthropic Messages endpoint',
        provider: 'anthropic-api',
        credentialRef: { provider: 'keychain', service: 'offline-messages', account: 'api' },
        credentialVersion: 'eec02914-ac1f-4369-ab86-8e4f130abc92',
        connection: {
          endpoint: 'https://messages.example.invalid',
          protocol: 'messages',
          authentication: 'api-key',
          qualification: {
            source: 'operator',
            streaming: true,
            toolCalls: true,
            continuation: true,
            cancellation: true,
          },
        },
        models: [{ id: 'fixture-model', label: 'Offline Messages', reasoningEfforts: ['low'] }],
      });
      await writeFile(path, JSON.stringify(accounts), { mode: 0o600 });
    }
    vi.stubEnv('MITZO_ORDINARY_LOCAL_VERTEX_ENABLED', '1');
    vi.stubEnv('MITZO_ORDINARY_LOCAL_VERTEX_TARGET_FILE', target);
  },
});
afterAll(async () => {
  try {
    await journey.close();
  } finally {
    vi.restoreAllMocks();
  }
});

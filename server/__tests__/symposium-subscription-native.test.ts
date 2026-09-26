import { describe, expect, it, vi } from 'vitest';
import { type CodexAccountProfile } from '../codex-account.js';
import type { CodexConversationOptions } from '../codex-conversation.js';
import type { SymposiumSeatExecution } from '../symposium-orchestrator.js';
import {
  assertSubscriptionControllerCommand,
  createChatGptSubscriptionSeat,
  SYMPOSIUM_SUBSCRIPTION_CONTROLLER_COMMAND,
} from '../symposium-subscription-native.js';

const profile: CodexAccountProfile = {
  accountId: 'personal',
  accountLabel: 'Personal',
  email: 'personal@example.test',
  planType: 'plus',
  model: 'gpt-6-luna',
  nativeAuth: 'sandbox-chatgpt',
  sandboxProvider: 'personal-codex',
  sandboxProviderId: 'provider-1',
  sandboxProviderType: 'codex',
};
async function fixture() {
  const rpc = {
    initialize: vi.fn(),
    close: vi.fn(),
    request: vi.fn().mockImplementation(async (method: string) =>
      method === 'model/list'
        ? {
            data: [
              {
                model: profile.model,
                displayName: 'Luna',
                supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
              },
            ],
          }
        : {
            account: { type: 'chatgpt', email: 'synthetic@invalid.local', planType: 'synthetic' },
          },
    ),
  };
  const binding = {
    accountId: profile.accountId,
    accountLabel: profile.accountLabel,
    provider: 'openai-codex' as const,
    model: profile.model,
    profileRevision: 'revision-personal',
  };
  const execution = {
    sessionId: 'symposium',
    claimToken: 'claim',
    content: 'Selected excerpt',
    seat: {
      id: 'personal-seat',
      name: 'Personal',
      role: 'coder',
      accountBinding: binding,
      systemPrompt: 'Only selected content',
    },
    provenance: { membershipGeneration: 2 },
    signal: new AbortController().signal,
  } as SymposiumSeatExecution;
  return {
    execution,
    rpc,
    sandbox: {
      sandboxName: 'private-seat',
      workdir: '/sandbox/workspaces/mgmt',
      cli: 'openshell',
      gateway: 'test-gateway',
      workspace: 'test-workspace',
      gatewayInsecure: false,
    },
    route: {
      kind: 'chatgpt-subscription-native' as const,
      accountId: profile.accountId,
      provider: 'personal-codex',
      providerId: 'provider-1',
      profile,
      model: profile.model,
      effort: null,
      readOnly: false,
    },
    store: {} as never,
    verifyPrivateAuth: vi.fn().mockResolvedValue(undefined),
  };
}

describe('native personal subscription seat (mocked only)', () => {
  it('pins native ChatGPT and rejects API or altered commands', () => {
    expect(() =>
      assertSubscriptionControllerCommand(SYMPOSIUM_SUBSCRIPTION_CONTROLLER_COMMAND),
    ).not.toThrow();
    expect(() => assertSubscriptionControllerCommand(['/usr/bin/codex', 'app-server'])).toThrow(
      'reviewed native launcher',
    );
    expect(SYMPOSIUM_SUBSCRIPTION_CONTROLLER_COMMAND.join(' ')).not.toMatch(
      /inference.local|openshell|OPENAI_API_KEY/,
    );
  });

  it('uses the existing receipt, streaming, completion and exact-stop lifecycle', async () => {
    const input = await fixture();
    let options!: CodexConversationOptions;
    const stopped = vi.fn().mockResolvedValue(undefined);
    const seat = await createChatGptSubscriptionSeat({
      ...input,
      testConfirmStopped: stopped,
      createConversation: (opts) => {
        options = opts;
        return {
          initialize: async () => {
            await opts.verifyBinding!(input.rpc, input.execution.seat.accountBinding);
          },
          getThreadId: () => 'thread-personal',
          send: async (command) => {
            expect(command.model).toBe('gpt-6-luna');
            expect(command.prompt).toBe('Selected excerpt');
            await opts.verifyBinding!(input.rpc, input.execution.seat.accountBinding);
            opts.onProviderDispatch!(command.id);
            opts.onProviderAccepted!(command.id, 'thread-personal', 'turn-personal');
            opts.emit({
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'Personal answer' }] },
            });
            opts.onProviderTerminal!(command.id, 'turn-personal', 'completed');
            opts.onProviderComplete!(command.id, 'completed');
          },
          interrupt: async () => undefined,
          close: vi.fn(),
        };
      },
    });
    const callbacks = { beforeDispatch: vi.fn(), accepted: vi.fn() };
    await expect(seat.run(input.execution, callbacks)).resolves.toEqual({
      providerThreadId: 'thread-personal',
      content: 'Personal answer',
    });
    expect(options.modelProvider).toBe('openai');
    expect(options.runtimeConfig?.forced_login_method).toBe('chatgpt');
    expect(callbacks.accepted).toHaveBeenCalledWith('thread-personal', 'turn-personal');
    expect(input.verifyPrivateAuth).toHaveBeenCalledTimes(3);
    expect(stopped).toHaveBeenCalledOnce();
  });

  it('rejects an API login before any native dispatch', async () => {
    const input = await fixture();
    input.rpc.request.mockResolvedValue({ account: { type: 'apiKey' } });
    const close = vi.fn();
    await expect(
      createChatGptSubscriptionSeat({
        ...input,
        createConversation: (opts) => ({
          initialize: async () => {
            await opts.verifyBinding!(input.rpc, input.execution.seat.accountBinding);
          },
          getThreadId: () => 'wrong-thread',
          send: vi.fn(),
          interrupt: vi.fn(),
          close,
        }),
      }),
    ).rejects.toThrow('not authenticated with ChatGPT');
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects host login and broker fallback even through a trusted factory', async () => {
    const input = await fixture();
    await expect(
      createChatGptSubscriptionSeat({
        ...input,
        route: { ...input.route, profile: { ...profile, credentialRef: '/host/auth.json' } },
      }),
    ).rejects.toThrow('host, workspace, API or brokered');
    await expect(
      createChatGptSubscriptionSeat({
        ...input,
        route: { ...input.route, profile: { ...profile, workspaceId: 'work' } },
      }),
    ).rejects.toThrow('host, workspace, API or brokered');
  });
  it('cancels only after the matching provider terminal and controller stop proof', async () => {
    const input = await fixture();
    const stopped = vi.fn().mockResolvedValue(undefined);
    const interrupt = vi.fn();
    let options!: CodexConversationOptions;
    const seat = await createChatGptSubscriptionSeat({
      ...input,
      testConfirmStopped: stopped,
      createConversation: (opts) => {
        options = opts;
        interrupt.mockImplementation(async () => {
          opts.onProviderTerminal!('claim', 'turn-personal', 'interrupted');
          opts.onProviderComplete!('claim', 'interrupted');
        });
        return {
          initialize: async () => undefined,
          getThreadId: () => 'thread-personal',
          send: async () => {
            opts.onProviderDispatch!('claim');
            opts.onProviderAccepted!('claim', 'thread-personal', 'turn-personal');
          },
          interrupt,
          close: vi.fn(),
        };
      },
    });
    const result = seat.run(input.execution, { beforeDispatch: vi.fn(), accepted: vi.fn() });
    const rejected = expect(result).rejects.toThrow('did not complete');
    options.onProviderTerminal!('another-claim', 'turn-personal', 'completed');
    await seat.cancel();
    await rejected;
    expect(interrupt).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledOnce();
  });

  it('rechecks private identity and rejects changed auth on a reconnect boundary', async () => {
    const input = await fixture();
    let options!: CodexConversationOptions;
    await createChatGptSubscriptionSeat({
      ...input,
      createConversation: (opts) => {
        options = opts;
        return {
          initialize: async () => undefined,
          getThreadId: () => 'thread-personal',
          send: vi.fn(),
          interrupt: vi.fn(),
          close: vi.fn(),
        };
      },
    });
    input.verifyPrivateAuth.mockRejectedValue(new Error('Provider account revoked'));
    await expect(
      options.verifyBinding!(input.rpc, input.execution.seat.accountBinding),
    ).rejects.toThrow('Provider account revoked');
    expect(input.rpc.request).not.toHaveBeenCalled();
  });

  it('rejects provider thread substitution on recovery', async () => {
    const input = await fixture();
    input.execution.providerThreadId = 'retained-thread';
    const stopped = vi.fn().mockResolvedValue(undefined);
    await expect(
      createChatGptSubscriptionSeat({
        ...input,
        testConfirmStopped: stopped,
        createConversation: () => ({
          initialize: async () => undefined,
          getThreadId: () => 'different-thread',
          send: vi.fn(),
          interrupt: vi.fn(),
          close: vi.fn(),
        }),
      }),
    ).rejects.toThrow('resumed a different provider thread');
    expect(stopped).toHaveBeenCalledOnce();
  });

  it('rejects an unavailable model or effort without substituting another model', async () => {
    for (const effort of [null, 'ultra']) {
      const input = await fixture();
      const model = effort === null ? 'other-model' : profile.model;
      input.rpc.request.mockImplementation(async (method: string) =>
        method === 'model/list'
          ? {
              data: [
                {
                  model,
                  displayName: 'Available',
                  supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
                },
              ],
            }
          : { account: { type: 'chatgpt' } },
      );
      await expect(
        createChatGptSubscriptionSeat({
          ...input,
          route: { ...input.route, effort },
          createConversation: (opts) => ({
            initialize: async () => {
              await opts.verifyBinding!(input.rpc, input.execution.seat.accountBinding);
            },
            getThreadId: () => 'thread-personal',
            send: vi.fn(),
            interrupt: vi.fn(),
            close: vi.fn(),
          }),
        }),
      ).rejects.toThrow('model or reasoning effort is unavailable');
    }
  });

  it('rejects mismatched physical routing before private auth or launch', async () => {
    const input = await fixture();
    await expect(
      createChatGptSubscriptionSeat({
        ...input,
        route: { ...input.route, providerId: 'another-provider' },
      }),
    ).rejects.toThrow('account or model changed');
    expect(input.verifyPrivateAuth).not.toHaveBeenCalled();
  });
});

import { expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManagedSession } from '@mitzo/harness';
import { ExecutionController } from '../execution-controller.js';

const responses = vi.hoisted(() => ({
  prepare: vi.fn(),
}));
const profiles = vi.hoisted(() => ({
  validateModelSelection: vi.fn(),
}));

vi.mock('../responses-chat-session.js', () => ({
  getResponsesRuntime: () => responses,
  openResponsesChat: vi.fn(),
}));
vi.mock('../account-profiles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../account-profiles.js')>()),
  loadAccountProfiles: () => profiles,
}));

const chat = await import('../chat.js');

it('stages validated interrupt images into Responses provider input once', async () => {
  const clientId = `responses-image-${Date.now()}`;
  const sessionId = `responses-image-session-${Date.now()}`;
  const cwd = mkdtempSync(join(tmpdir(), 'mitzo-responses-image-'));
  const transport = { send: vi.fn(), isOpen: () => true };
  const push = vi.fn();
  responses.prepare.mockReset();
  profiles.validateModelSelection.mockReset();
  chat.registry.register(clientId, {
    transport,
    abortController: new AbortController(),
    mode: 'agent',
    sessionId,
    cwd,
    sessionAllowList: new Set(),
  });
  try {
    const session = chat.registry.get(clientId)!;
    session.inputQueue = { push, close: vi.fn() } as unknown as ManagedSession['inputQueue'];
    session.queryInstance = { interrupt: vi.fn(), close: vi.fn(), stopTask: vi.fn() };
    chat.eventStore.upsertSession({ sessionId });
    session.currentExecution = chat.eventStore.beginExecution(
      sessionId,
      'responses-old-image-turn',
    ).token;
    const images = [
      { data: Buffer.from('responses-provider-image').toString('base64'), mediaType: 'image/png' },
    ];

    await expect(
      chat.interruptChat(clientId, 'inspect image', images, undefined, 'responses-image-interrupt'),
    ).resolves.toEqual({ kind: 'accepted' });
    const providerPrompt = responses.prepare.mock.calls[0][1] as string;
    const stagedPath = providerPrompt.match(/- (.+\.png)$/m)?.[1];
    expect(stagedPath).toMatch(new RegExp(`^${join(cwd, '.mitzo-images')}/`));
    expect(readFileSync(stagedPath!)).toEqual(Buffer.from('responses-provider-image'));
    expect(
      (push.mock.calls[0][0] as { message: { message: { content: string } } }).message.message
        .content,
    ).toBe(providerPrompt);

    await expect(
      chat.interruptChat(clientId, 'inspect image', images, undefined, 'responses-image-interrupt'),
    ).resolves.toEqual({ kind: 'duplicate_already_accepted' });
    expect(responses.prepare).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledOnce();
    expect(readdirSync(join(cwd, '.mitzo-images'))).toHaveLength(1);
  } finally {
    chat.registry.abort(clientId);
    rmSync(cwd, { recursive: true, force: true });
  }
});

it('does not prepare or push a Responses replacement after stop wins during interrupt idle wait', async () => {
  const clientId = `responses-stop-race-${Date.now()}`;
  const sessionId = `responses-stop-race-session-${Date.now()}`;
  const transport = { send: vi.fn(), isOpen: () => true };
  const push = vi.fn();
  let releaseInterrupt!: () => void;
  const interrupt = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        releaseInterrupt = resolve;
      }),
  );
  responses.prepare.mockReset();
  chat.registry.register(clientId, {
    transport,
    abortController: new AbortController(),
    mode: 'agent',
    sessionId,
    sessionAllowList: new Set(),
  });
  try {
    const session = chat.registry.get(clientId)!;
    session.inputQueue = { push, close: vi.fn() } as unknown as ManagedSession['inputQueue'];
    session.queryInstance = { interrupt, close: vi.fn(), stopTask: vi.fn() };
    chat.eventStore.upsertSession({ sessionId });
    session.currentExecution = chat.eventStore.beginExecution(
      sessionId,
      'responses-old-turn',
    ).token;

    const replacement = chat.interruptChat(
      clientId,
      'replacement prompt',
      undefined,
      undefined,
      'responses-stop-race-message',
    );
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledOnce());

    const lease = chat.registry.getRuntimeLease(clientId)!;
    const replacementToken = chat.registry.get(clientId)!.currentExecution!;
    await expect(
      new ExecutionController({
        registry: chat.registry,
        eventStore: chat.eventStore,
      }).stopExecution(lease, replacementToken),
    ).resolves.toMatchObject({ transition: { applied: true } });
    releaseInterrupt();

    // The durable admission remains the acknowledgement; dispatch is fenced
    // by the exact current token after the provider's interrupt/idle wait.
    await expect(replacement).resolves.toEqual({ kind: 'accepted' });
    expect(responses.prepare).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(chat.eventStore.getSession(sessionId)).toMatchObject({
      executionPhase: 'TERMINAL',
      executionGeneration: 2,
      executionTerminalReason: 'stopped',
    });
  } finally {
    chat.registry.abort(clientId);
  }
});

it('validates and durably persists the effective Responses replacement selection before dispatch', async () => {
  const clientId = `responses-selection-${Date.now()}`;
  const sessionId = `responses-selection-session-${Date.now()}`;
  const transport = { send: vi.fn(), isOpen: () => true };
  const push = vi.fn();
  responses.prepare.mockReset();
  profiles.validateModelSelection.mockReset();
  chat.registry.register(clientId, {
    transport,
    abortController: new AbortController(),
    mode: 'agent',
    sessionId,
    model: 'default-model',
    sessionAllowList: new Set(),
  });
  try {
    const session = chat.registry.get(clientId)!;
    session.inputQueue = { push, close: vi.fn() } as unknown as ManagedSession['inputQueue'];
    session.queryInstance = { interrupt: vi.fn(), close: vi.fn(), stopTask: vi.fn() };
    chat.eventStore.upsertSession({
      sessionId,
      accountBinding: {
        accountId: 'native-account',
        accountLabel: 'Native account',
        provider: 'openai',
        model: 'default-model',
        profileRevision: 'test',
      },
      selectedModel: 'default-model',
      reasoningEffort: 'low',
    });
    session.currentExecution = chat.eventStore.beginExecution(
      sessionId,
      'responses-selection-old',
    ).token;

    await expect(
      chat.interruptChat(
        clientId,
        'use the selected native model',
        undefined,
        undefined,
        'responses-selection-message',
        'selected-model',
        'high',
      ),
    ).resolves.toEqual({ kind: 'accepted' });
    expect(profiles.validateModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'native-account' }),
      'selected-model',
      'high',
    );
    expect(chat.eventStore.getSession(sessionId)).toMatchObject({
      selectedModel: 'selected-model',
      reasoningEffort: 'high',
    });
    expect(responses.prepare).toHaveBeenCalledWith(
      'responses-selection-message',
      expect.any(String),
      { model: 'selected-model', reasoningEffort: 'high' },
    );

    profiles.validateModelSelection.mockImplementation(() => {
      throw new Error('profile no longer permits this model');
    });
    // The durable receipt is resolved before current profile availability.
    await expect(
      chat.interruptChat(
        clientId,
        'use the selected native model',
        undefined,
        undefined,
        'responses-selection-message',
        'selected-model',
        'high',
      ),
    ).resolves.toEqual({ kind: 'duplicate_already_accepted' });
    const before = chat.eventStore.getSessionEvents(sessionId);
    await expect(
      chat.interruptChat(
        clientId,
        'invalid native model',
        undefined,
        undefined,
        'responses-selection-invalid',
        'not-allowed',
      ),
    ).resolves.toEqual({ kind: 'unavailable_unreported' });
    expect(chat.eventStore.getSessionEvents(sessionId)).toEqual(before);
    expect(responses.prepare).toHaveBeenCalledOnce();
  } finally {
    chat.registry.abort(clientId);
  }
});

it('returns an omitted-model Responses receipt after later runtime selection changes', async () => {
  const clientId = `responses-omitted-retry-${Date.now()}`;
  const sessionId = `responses-omitted-retry-session-${Date.now()}`;
  const transport = { send: vi.fn(), isOpen: () => true };
  const push = vi.fn();
  responses.prepare.mockReset();
  profiles.validateModelSelection.mockReset();
  chat.registry.register(clientId, {
    transport,
    abortController: new AbortController(),
    mode: 'agent',
    sessionId,
    model: 'initial-model',
    cwd: '/first/worktree',
    sessionAllowList: new Set(),
  });
  try {
    const session = chat.registry.get(clientId)!;
    session.inputQueue = { push, close: vi.fn() } as unknown as ManagedSession['inputQueue'];
    session.queryInstance = { interrupt: vi.fn(), close: vi.fn(), stopTask: vi.fn() };
    chat.eventStore.upsertSession({
      sessionId,
      accountBinding: {
        accountId: 'native-account',
        accountLabel: 'Native account',
        provider: 'openai',
        model: 'initial-model',
        profileRevision: 'test',
      },
      selectedModel: 'initial-model',
      reasoningEffort: 'low',
    });
    session.currentExecution = chat.eventStore.beginExecution(
      sessionId,
      'responses-omitted-old',
    ).token;
    const clientMsgId = 'responses-omitted-model-retry';

    await expect(
      chat.interruptChat(clientId, 'same wire request', undefined, undefined, clientMsgId),
    ).resolves.toEqual({ kind: 'accepted' });

    // A later generation/runtime can legitimately choose a different native
    // selection and workspace. Those are durable execution metadata, never
    // the original command's receipt identity.
    session.model = 'later-model';
    session.mode = 'auto';
    session.cwd = '/later/worktree';
    chat.eventStore.upsertSession({
      sessionId,
      selectedModel: 'later-model',
      reasoningEffort: 'high',
    });
    // A profile can disappear after durable admission. This must not turn an
    // exact lost-ack retry into a fresh native-selection validation.
    profiles.validateModelSelection.mockImplementation(() => {
      throw new Error('native account profile was removed');
    });
    await expect(
      chat.interruptChat(clientId, 'same wire request', undefined, undefined, clientMsgId),
    ).resolves.toEqual({ kind: 'duplicate_already_accepted' });
    expect(responses.prepare).toHaveBeenCalledOnce();

    await expect(
      chat.interruptChat(
        clientId,
        'same wire request',
        undefined,
        undefined,
        clientMsgId,
        'explicitly-different-wire-model',
      ),
    ).resolves.toEqual({ kind: 'conflict' });
    await expect(
      chat.interruptChat(
        clientId,
        'new command must still validate the current profile',
        undefined,
        undefined,
        'responses-omitted-model-new-command',
        'later-model',
      ),
    ).resolves.toEqual({ kind: 'unavailable_unreported' });
    expect(responses.prepare).toHaveBeenCalledOnce();
  } finally {
    chat.registry.abort(clientId);
  }
});

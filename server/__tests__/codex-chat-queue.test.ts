import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManagedSession } from '@mitzo/harness';
const runtime = vi.hoisted(() => ({
  admitExplicitSend: vi.fn(),
  enqueue: vi.fn(),
  send: vi.fn().mockResolvedValue(undefined),
  resumeAfterExplicitSend: vi.fn().mockResolvedValue(undefined),
  interrupt: vi.fn().mockResolvedValue(undefined),
  validateModel: vi.fn(),
}));
vi.mock('../codex-chat-session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../codex-chat-session.js')>()),
  getCodexRuntime: () => runtime,
  openCodexChat: vi.fn(),
}));
const root = mkdtempSync(join(tmpdir(), 'codex-queue-retry-'));
vi.stubEnv('REPO_PATH', root);
const chat = await import('../chat.js');
beforeEach(() => {
  runtime.admitExplicitSend.mockReset().mockResolvedValue({
    model: 'gpt',
    reasoningEffort: undefined,
  });
  runtime.enqueue.mockReset();
  runtime.interrupt.mockReset().mockResolvedValue(undefined);
  runtime.validateModel.mockReset();
  runtime.resumeAfterExplicitSend.mockReset().mockResolvedValue(undefined);
  runtime.send.mockReset().mockImplementation(async (_input, onEnqueued?: () => void) => {
    onEnqueued?.();
  });
});

const invalidApiImages = [
  {
    name: 'noncanonical base64 padding',
    image: () => ({ data: 'ab==', mediaType: 'image/png' }),
    error: 'API image data must be valid nonempty base64',
  },
  {
    name: 'unpadded base64',
    image: () => ({ data: 'aGk', mediaType: 'image/png' }),
    error: 'API image data must be valid nonempty base64',
  },
  {
    name: 'malformed base64',
    image: () => ({ data: 'bad!', mediaType: 'image/png' }),
    error: 'API image data must be valid nonempty base64',
  },
  {
    name: 'more than 10 MiB decoded',
    image: () => ({
      data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'),
      mediaType: 'image/png',
    }),
    error: 'API images must be at most 10 MiB each',
  },
  {
    name: 'unsupported MIME',
    image: () => ({ data: 'aGk=', mediaType: 'image/svg+xml' }),
    error: 'Unsupported image media type for API chat',
  },
];

it.each(
  invalidApiImages.flatMap((input) =>
    ['send', 'interrupt'].flatMap((command) =>
      ['registry', 'durable'].map((bindingSource) => ({ ...input, command, bindingSource })),
    ),
  ),
)(
  'rejects OpenShell API $command with $name before queue admission, echo, or interruption ($bindingSource binding)',
  async ({ name, image, error, command, bindingSource }) => {
    const send = vi.fn();
    const push = vi.fn();
    const queryInterrupt = vi.fn();
    const sessionId = `api-invalid-${command}-${bindingSource}-${name.replaceAll(' ', '-')}`;
    const binding = {
      accountId: 'work-api',
      accountLabel: 'Work API',
      provider: 'openai' as const,
      model: 'gpt',
      profileRevision: 'offline-fixture',
    };
    const session = {
      inputQueue: { push },
      queryInstance: { interrupt: queryInterrupt },
      sessionId,
      cwd: root,
      model: 'gpt',
      ...(bindingSource === 'registry' ? { accountBinding: binding } : {}),
      transport: { send, isOpen: () => true },
      observers: new Set(),
    } as unknown as ManagedSession;
    vi.spyOn(chat.registry, 'get').mockReturnValue(session);
    chat.eventStore.upsertSession({ sessionId, accountBinding: binding, selectedModel: 'gpt' });
    const echo = vi.spyOn(chat.eventStore, 'hasUserMessage').mockReturnValue(false);
    echo.mockClear();
    const images = [image()];
    const dispatch = command === 'send' ? chat.sendToChat : chat.interruptChat;
    await expect(
      dispatch('api-client', 'Inspect image', images, undefined, 'invalid-image-command'),
    ).resolves.toBe(false);
    expect(runtime.admitExplicitSend).not.toHaveBeenCalled();
    expect(runtime.enqueue).not.toHaveBeenCalled();
    expect(runtime.resumeAfterExplicitSend).not.toHaveBeenCalled();
    expect(runtime.interrupt).not.toHaveBeenCalled();
    expect(queryInterrupt).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(echo).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'error', sessionId, error });
    expect(session.model).toBe('gpt');
    expect(
      chat.eventStore.getExecutionAdmission(sessionId, 'invalid-image-command'),
    ).toBeUndefined();
  },
);

it.each(['send', 'interrupt'] as const)(
  'admits a valid OpenShell API image $0 with its unchanged attachment payload',
  async (command) => {
    const send = vi.fn();
    const sessionId = `api-valid-${command}`;
    const binding = {
      accountId: 'work-api',
      accountLabel: 'Work API',
      provider: 'openai' as const,
      model: 'gpt',
      profileRevision: 'offline-fixture',
    };
    vi.spyOn(chat.registry, 'get').mockReturnValue({
      inputQueue: {},
      queryInstance: { interrupt: vi.fn() },
      sessionId,
      cwd: root,
      model: 'gpt',
      accountBinding: binding,
      transport: { send, isOpen: () => true },
      observers: new Set(),
    } as unknown as ManagedSession);
    chat.eventStore.upsertSession({ sessionId, accountBinding: binding });
    vi.spyOn(chat.eventStore, 'hasUserMessage').mockReturnValue(false);
    const images = [{ data: 'aGk=', mediaType: 'image/png' }];
    const dispatch = command === 'send' ? chat.sendToChat : chat.interruptChat;
    await expect(
      dispatch('api-client', 'Inspect image', images, undefined, 'valid-image-command'),
    ).resolves.toBe(true);
    expect(runtime.admitExplicitSend).toHaveBeenCalledExactlyOnceWith(
      {
        id: 'valid-image-command',
        prompt: 'Inspect image',
        intent: 'Inspect image',
        images,
        reasoningEffort: undefined,
      },
      undefined,
    );
    expect(runtime.interrupt).toHaveBeenCalledTimes(command === 'interrupt' ? 1 : 0);
    expect(runtime.resumeAfterExplicitSend).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user_message', images: ['data:image/png;base64,aGk='] }),
    );
  },
);
afterAll(() => {
  chat.eventStore.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
it('waits for recovery-aware admission before acknowledging an idle follow-up', async () => {
  const send = vi.fn();
  let admit!: (selection: { model: string; reasoningEffort?: string | null }) => void;
  runtime.admitExplicitSend.mockImplementationOnce(() => {
    return new Promise((resolve) => {
      admit = resolve;
    });
  });
  vi.spyOn(chat.registry, 'get').mockReturnValue({
    inputQueue: {},
    sessionId: 's',
    cwd: root,
    transport: { send, isOpen: () => true },
    observers: new Set(),
  } as unknown as ManagedSession);
  vi.spyOn(chat.eventStore, 'hasUserMessage').mockReturnValue(true);
  const result = chat.sendToChat('c', 'hello', undefined, undefined, 'same-id');
  expect(runtime.admitExplicitSend).toHaveBeenCalledWith(
    {
      id: 'same-id',
      prompt: 'hello',
      intent: 'hello',
      images: undefined,
      reasoningEffort: undefined,
    },
    undefined,
  );
  expect(runtime.enqueue).not.toHaveBeenCalled();
  expect(runtime.resumeAfterExplicitSend).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();

  admit({ model: 'gpt', reasoningEffort: undefined });
  await expect(result).resolves.toBe(true);
  expect(runtime.resumeAfterExplicitSend).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
});
it('does not acknowledge or echo a message when durable enqueue fails', async () => {
  const send = vi.fn();
  vi.spyOn(chat.registry, 'get').mockReturnValue({
    inputQueue: {},
    sessionId: 's',
    cwd: root,
    transport: { send, isOpen: () => true },
    observers: new Set(),
  } as unknown as ManagedSession);
  const echo = vi.spyOn(chat.eventStore, 'hasUserMessage').mockReturnValue(false);
  echo.mockClear();
  runtime.admitExplicitSend.mockRejectedValueOnce(new Error('disk full'));
  await expect(chat.sendToChat('c', 'hello', undefined, undefined, 'new-id')).resolves.toBe(false);
  expect(echo).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
});

it('queues image and thinking input on an existing conversation', async () => {
  const images = [{ data: 'aGVsbG8=', mediaType: 'image/png' }];
  runtime.admitExplicitSend.mockResolvedValueOnce({ model: 'gpt', reasoningEffort: 'high' });
  await expect(
    chat.sendToChat('c', 'describe', images, undefined, 'image-followup', 'gpt', 'high'),
  ).resolves.toBe(true);
  expect(runtime.admitExplicitSend).toHaveBeenLastCalledWith(
    {
      id: 'image-followup',
      prompt: 'describe',
      intent: 'describe',
      model: 'gpt',
      reasoningEffort: 'high',
      images,
    },
    undefined,
  );
});

it('keeps an admitted message saved and reports a bounded reconnect failure', async () => {
  const { KnowledgePublicationUnavailableError } =
    await import('../knowledge-publication-bridge.js');
  const send = vi.fn();
  vi.spyOn(chat.registry, 'get').mockReturnValue({
    inputQueue: {},
    sessionId: 's',
    cwd: root,
    transport: { send, isOpen: () => true },
    observers: new Set(),
  } as unknown as ManagedSession);
  vi.spyOn(chat.eventStore, 'hasUserMessage').mockReturnValue(true);
  runtime.resumeAfterExplicitSend.mockRejectedValueOnce(new KnowledgePublicationUnavailableError());
  await expect(chat.sendToChat('c', 'hello', undefined, undefined, 'saved-id')).resolves.toBe(true);
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        sessionId: 's',
        error:
          'Message saved. Knowledge publication is unavailable. Check the knowledge publisher before retrying. No provider turn was started.',
      }),
    ),
  );
});

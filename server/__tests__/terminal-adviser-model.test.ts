import { it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  key: vi.fn(async () => 'private-key'),
  config: vi.fn(),
  validate: vi.fn(),
  binding: { accountId: 'work', provider: 'openai', model: 'luna', profileRevision: 'pin' },
  profiles: {},
}));
vi.mock('../account-profiles.js', () => ({
  loadAccountProfiles: () => ({
    resolve: () => mocks.binding,
    validateModelSelection: mocks.validate,
    apiProfile: () => ({ credentialRef: { kind: 'test' } }),
    isEnrolledOpenAIAccount: () => false,
  }),
}));
vi.mock('../credentials.js', () => ({ credentials: { resolve: mocks.key } }));
vi.mock('../connections-runtime.js', () => ({ getConnectionsRuntime: () => undefined }));
vi.mock('../openai-key-controller.js', () => ({ assertOpenAIKeyController: () => {} }));
vi.mock('../openai-key-operation-store.js', () => ({ openAIKeyResourceBindings: () => [] }));
vi.mock('@mitzo/harness', () => ({
  ResponsesSession: class {
    constructor(config: unknown) {
      mocks.config(config);
    }
  },
}));
import { createTerminalAdviserSession } from '../terminal-adviser-model.js';
it('resolves the selected API account and validates thinking before credentials', async () => {
  const input = {
    accountId: 'work',
    model: 'luna',
    reasoningEffort: 'low',
    messages: [{ role: 'user' as const, content: 'help' }],
  };
  await createTerminalAdviserSession(
    { model: 'luna', systemPrompt: 'test', maxTokens: 4096, tools: [] },
    input,
  );
  expect(mocks.validate).toHaveBeenCalledWith(mocks.binding, 'luna', 'low');
  expect(mocks.key).toHaveBeenCalledWith({ kind: 'test' });
  mocks.key.mockClear();
  mocks.validate.mockImplementationOnce(() => {
    throw Error('Thinking unavailable');
  });
  await expect(
    createTerminalAdviserSession(
      { model: 'luna', systemPrompt: 'test', maxTokens: 4096, tools: [] },
      input,
    ),
  ).rejects.toThrow();
  expect(mocks.key).not.toHaveBeenCalled();
});
it('rejects subscription accounts instead of inheriting host or API credentials', async () => {
  mocks.key.mockClear();
  mocks.binding.provider = 'openai-codex';
  await expect(
    createTerminalAdviserSession(
      { model: 'luna', systemPrompt: 'test', maxTokens: 4096, tools: [] },
      { accountId: 'work', model: 'luna', messages: [{ role: 'user', content: 'help' }] },
    ),
  ).rejects.toThrow('subscription');
  expect(mocks.key).not.toHaveBeenCalled();
});

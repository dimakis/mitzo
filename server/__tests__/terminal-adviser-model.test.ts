import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  validate: vi.fn(),
  binding: { accountId: 'work', provider: 'openai', model: 'gpt-6-luna', profileRevision: 'pin' },
  native: vi.fn(async () => ({ provider: 'codex', turn: async function* () {} })),
}));
vi.mock('../account-profiles.js', () => ({
  loadAccountProfiles: () => ({
    resolve: () => mocks.binding,
    validateModelSelection: mocks.validate,
  }),
}));
vi.mock('../adviser-harness-runtime.js', () => ({ createNativeAdviserSession: mocks.native }));
import { createTerminalAdviserSession } from '../terminal-adviser-model.js';
const config = { model: 'gpt-6-luna', systemPrompt: 'Explain', maxTokens: 4096, tools: [] };
const request = {
  accountId: 'work',
  model: 'gpt-6-luna',
  messages: [{ role: 'user' as const, content: 'Reviewed' }],
};
const owner = {
  authSessionId: 'operator',
  operatorConnectionId: 'feature-operation',
  feature: { kind: 'terminal' as const, terminalId: 'term' },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.binding.provider = 'openai';
});
it.each(['openai', 'openai-codex', 'anthropic-vertex'])(
  'routes %s through the actual shared harness owner',
  async (provider) => {
    mocks.binding.provider = provider;
    await createTerminalAdviserSession(config, request, owner);
    expect(mocks.validate).toHaveBeenCalledWith(mocks.binding, 'gpt-6-luna', undefined);
    expect(mocks.native).toHaveBeenCalledWith(config, request, owner, mocks.binding);
  },
);
it('refuses invalid thinking before allocating a harness and never changes route', async () => {
  mocks.validate.mockImplementationOnce(() => {
    throw Error('Thinking unavailable');
  });
  await expect(createTerminalAdviserSession(config, request, owner)).rejects.toThrow();
  expect(mocks.native).not.toHaveBeenCalled();
});
it('requires authenticated feature scope and explains separate plan-registration migration without credential access', async () => {
  await expect(createTerminalAdviserSession(config, request)).rejects.toThrow('feature');
  await expect(
    createTerminalAdviserSession(config, { ...request, accountId: 'chatgpt_plan_saved' }, owner),
  ).rejects.toThrow(/Codex.*registration|registration.*Codex/i);
  expect(mocks.native).not.toHaveBeenCalled();
});

import './fixtures/offline-user-home.js';
import { expect, it, vi } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue.js';
import { adaptSdkQuery } from '../chat.js';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
} from '../ordinary-local-vertex-sdk-query.js';
import {
  lockedClaudeStartupMode,
  lockedClaudeControlMode,
} from './fixtures/locked-claude-subprocess-env.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  getSessionInfo: vi.fn(async () => ({ sessionId: 'original', cwd: '/task' })),
  getSessionMessages: vi.fn(async () => [{ uuid: 'input' }]),
}));

it.each([
  ['ask', 'plan'],
  ['agent', 'default'],
  ['auto', 'default'],
] as const)(
  'uses the actual adapter for %s → %s and retains its SDK mode on continuation',
  async (mode, sdkMode) => {
    const initial = sdkMode === 'plan' ? 'default' : 'plan';
    const env = {
      MITZO_ANTHROPIC_API_CUSTODY: 'synthetic-custody',
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    };
    const prompts: AsyncIterable<SDKUserMessage>[] = [];
    const states: Array<{ mode: string; set: ReturnType<typeof vi.fn> }> = [];
    vi.mocked(query).mockImplementation((request) => {
      prompts.push(request.prompt as AsyncIterable<SDKUserMessage>);
      const state = {
        mode: lockedClaudeStartupMode(env, request.options!.permissionMode as typeof sdkMode),
        set: vi.fn(),
      };
      state.set.mockImplementation(async (value: typeof sdkMode) => {
        // This peer qualifies only plan/default. Reject a wrong projection
        // before invoking unrelated native auto-mode eligibility dependencies.
        expect(['plan', 'default']).toContain(value);
        const accepted = lockedClaudeControlMode(value, state.mode);
        expect(accepted.responses).toMatchObject([
          { response: { subtype: 'success', response: { mode: value } } },
        ]);
        state.mode = accepted.mode;
      });
      states.push(state);
      return {
        setPermissionMode: state.set,
        close: vi.fn(),
        async *[Symbol.asyncIterator]() {},
      } as never;
    });
    const controller = new AbortController();
    const owner = createOrdinaryLocalVertexSdkQuery({
      options: { env, permissionMode: initial },
      input: new AsyncQueue(),
      lifetime: new SdkHookLifetime(),
      sdkSessionId: 'original',
      cwd: '/task',
      controller,
      authorize: async () => {},
      authorizeSync: () => {},
      adapt: adaptSdkQuery,
      settings: () => ({}),
      inputChanged: () => {},
    });
    const message: SDKUserMessage = {
      type: 'user',
      session_id: 'original',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Offline' },
    };
    try {
      await owner.apply({ model: 'gateway/claude:latest' } as never);
      owner.push(message);
      const first = prompts[0][Symbol.asyncIterator]();
      expect((await first.next()).value).toEqual(message);
      expect(states[0].set).toHaveBeenCalledWith(initial);
      expect(states[0].mode).toBe(initial);
      await first.return?.();
      await owner.query.setPermissionMode!(mode);
      expect(states[0].set).toHaveBeenLastCalledWith(sdkMode);
      expect(states[0].mode).toBe(sdkMode);
      await owner.apply({ model: 'gateway/claude:max' } as never);
      owner.push(message);
      const resumed = prompts[1][Symbol.asyncIterator]();
      expect((await resumed.next()).value).toEqual(message);
      expect(states[1].set).toHaveBeenCalledWith(sdkMode);
      expect(states[1].mode).toBe(sdkMode);
      await resumed.return?.();
    } finally {
      controller.abort();
    }
  },
);

it('does not yield input before a mode acknowledgement and aborts visibly on refusal', async () => {
  let prompt!: AsyncIterable<SDKUserMessage>;
  let refuse!: (error: Error) => void;
  const setPermissionMode = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        refuse = reject;
      }),
  );
  vi.mocked(query).mockImplementation((request) => {
    prompt = request.prompt as AsyncIterable<SDKUserMessage>;
    return { setPermissionMode, close: vi.fn(), async *[Symbol.asyncIterator]() {} } as never;
  });
  const controller = new AbortController();
  const owner = createOrdinaryLocalVertexSdkQuery({
    options: { env: { MITZO_ANTHROPIC_API_CUSTODY: 'synthetic-custody' }, permissionMode: 'plan' },
    input: new AsyncQueue(),
    lifetime: new SdkHookLifetime(),
    sdkSessionId: 'original',
    cwd: '/task',
    controller,
    authorize: async () => {},
    authorizeSync: () => {},
    adapt: (native) => native as never,
    settings: () => ({}),
    inputChanged: () => {},
  });
  owner.push({
    type: 'user',
    session_id: 'original',
    parent_tool_use_id: null,
    message: { role: 'user', content: 'Offline' },
  });
  const result = prompt[Symbol.asyncIterator]().next();
  let yielded = false;
  void result.then(
    () => {
      yielded = true;
    },
    () => {},
  );
  await vi.waitFor(() => expect(setPermissionMode).toHaveBeenCalledWith('plan'));
  expect(yielded).toBe(false);
  const failure = new Error('OFFLINE_MODE_REFUSED');
  refuse(failure);
  await expect(result).rejects.toThrow('OFFLINE_MODE_REFUSED');
  expect(controller.signal.aborted).toBe(true);
  expect(controller.signal.reason).toBe(failure);
});

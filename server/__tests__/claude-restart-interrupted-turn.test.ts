import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ownedVertexRuntimeFixture } from './fixtures/owned-local-vertex-runtime.js';
import {
  ClaudeSubscriptionCustody,
  claudeSdkInstallation,
} from '../claude-subscription-custody.js';
import {
  OrdinaryLocalVertexOwnedRuntime,
  type OrdinaryLocalVertexOwnedDispatch,
} from '../ordinary-local-vertex-owned-runtime.js';
import { OrdinarySdkTurnEvidence } from '../ordinary-sdk-turn-evidence.js';
import { recoverAfterRestart } from '../restart-interruption.js';
import { replayEventsToMessages } from '../conversation-transcript.js';
import { readClaudeAccountHistory } from '../claude-account-history.js';
import { getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

// Each case builds a real repository workspace and owned SDK route; bound it
// like the sibling owned-runtime suites rather than the 5s default.
vi.setConfig({ testTimeout: 20_000 });
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
// Same offline host harness as claude-repository-deploy-continuity.test.ts.
vi.mock('../claude-account-history.js', () => ({
  readClaudeAccountHistory: vi.fn(async (sessionId: string, cwd: string) => ({
    info: { sessionId, cwd },
    messages: [{ type: 'user', uuid: 'retained' }],
  })),
}));
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  hasPersistentRevocationAuthority: () => true,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  getSessionInfo: vi.fn(async (id: string, options: { dir: string }) => ({
    sessionId: id,
    cwd: options.dir,
    summary: 'Offline SDK history',
    lastModified: 1,
  })),
  getSessionMessages: vi.fn(async () => [
    { type: 'user', uuid: 'original-input', message: { role: 'user', content: 'retained input' } },
  ]),
}));
beforeEach(resetOfflineUserEnvironment);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A Personal Claude repository chat whose first command reached the SDK route. */
async function claudeChat(firstDispatch?: () => Promise<void>) {
  // Capture the fixture's installed SDK binary, as the deploy-continuity suite
  // does: claudeSdkExecutable() exists only on Darwin, and CI runs on Linux.
  const capture = ClaudeSubscriptionCustody.capture;
  vi.spyOn(ClaudeSubscriptionCustody, 'capture').mockImplementation((env) =>
    capture(env, claudeSdkInstallation.executable()!),
  );
  vi.spyOn(ClaudeSubscriptionCustody.prototype, 'verify').mockResolvedValue();
  const f = await ownedVertexRuntimeFixture(cleanups, {
    personal: true,
    ordinaryPreparation: true,
    localRepository: true,
    chatRoute: true,
  });
  const dispatch = vi.fn<(input: OrdinaryLocalVertexOwnedDispatch) => Promise<void>>(
    async () => {},
  );
  if (firstDispatch) dispatch.mockImplementationOnce(firstDispatch);
  const create = (commandId: string) => {
    const owner = new OrdinaryLocalVertexOwnedRuntime({
      enabled: true,
      eventStore: f.events,
      library: f.library,
      workspace: f.workspace,
      reservation: f.reservation,
      commandId,
      operatorConnectionId: f.dependencies.operatorConnectionId,
      signal: f.signal.signal,
      env: f.dependencies.env,
      dispatch,
      dispatchContinuation: dispatch,
    });
    cleanups.push(() => owner.close());
    return owner;
  };
  const sessionId = f.reservation.conversationId;
  return { f, create, dispatch, sessionId };
}

/** Persist what the query loop writes for a top-level tool call. */
function toolCall(
  f: Awaited<ReturnType<typeof claudeChat>>['f'],
  sessionId: string,
  toolId: string,
  toolName: string,
  input: string,
  result?: string,
) {
  f.events.append(sessionId, 'block_end', {
    type: 'block_end',
    v: 2,
    sessionId,
    messageId: `message-${toolId}`,
    blockId: `block-${toolId}`,
    blockType: 'tool_use',
    toolName,
    toolId,
    input,
  });
  if (result !== undefined)
    f.events.append(sessionId, 'tool_result', {
      type: 'tool_result',
      v: 2,
      sessionId,
      messageId: `message-${toolId}`,
      toolId,
      result,
      isError: false,
    });
}

const restartErrors = (f: Awaited<ReturnType<typeof claudeChat>>['f'], sessionId: string) =>
  f.events
    .getSessionEvents(sessionId)
    .filter((event) => event.type === 'error')
    .map((event) => event.payload as Record<string, unknown>);

it('ends a turn a restart interrupted mid tool call recoverably and accepts the next message', async () => {
  const { f, create, dispatch, sessionId } = await claudeChat();
  const first = create(f.request.clientMsgId);
  await expect(first.admit(f.request)).resolves.toEqual({ dispatched: true });
  // The SDK owner began the turn and the CLI echoed its input...
  f.events.beginOrdinaryLocalVertexCommandExecution(sessionId, f.request.clientMsgId);
  const custody = f.events.getOrdinaryLocalVertexCustody(sessionId)!;
  new OrdinarySdkTurnEvidence(f.events, sessionId, custody.sdkSessionId).accepted(
    f.request.clientMsgId,
    'input-uuid',
  );
  // ...one tool settled and another was still running when the server died.
  toolCall(f, sessionId, 'toolu_settled', 'Read', 'README.md', 'contents');
  toolCall(f, sessionId, 'toolu_running', 'Bash', 'npm test');
  first.close();
  expect(f.events.getSession(sessionId)?.executionPhase).toBe('RUNNING');

  recoverAfterRestart(f.events);

  expect(f.events.getSession(sessionId)?.executionPhase).toBe('TERMINAL');
  const [notice, ...others] = restartErrors(f, sessionId);
  expect(others).toEqual([]);
  expect(notice).toMatchObject({
    v: 2,
    sessionId,
    interruption: {
      reason: 'server_restart',
      commandId: f.request.clientMsgId,
      uncertainOperations: [{ toolUseId: 'toolu_running', toolName: 'Bash', input: 'npm test' }],
    },
  });
  expect(notice!.error).toMatch(/Mitzo restarted while this turn was running/);
  expect(notice!.error).toMatch(/Bash/);
  // Recovery replays nothing; only the next explicit message dispatches.
  expect(dispatch).toHaveBeenCalledTimes(1);
  await expect(create('next').admitResume({ ...f.request, clientMsgId: 'next' })).resolves.toEqual({
    dispatched: true,
  });
  expect(dispatch).toHaveBeenCalledTimes(2);
  // A second startup does not repeat the notice.
  recoverAfterRestart(f.events);
  expect(restartErrors(f, sessionId)).toHaveLength(1);
});

it('names a restart before the agent received a message and does not brick the chat', async () => {
  // The server dies after claiming dispatch but before the SDK owner started an
  // execution, so the CLI never received this input.
  const { f, create, dispatch, sessionId } = await claudeChat(async () => {
    throw Error('server terminated during cold start');
  });
  await expect(create(f.request.clientMsgId).admit(f.request)).rejects.toThrow();
  expect(f.events.getOrdinaryLocalVertexCommandAdmission(f.request.clientMsgId)?.state).toBe(
    'uncertain',
  );
  expect(f.events.hasUncertainOrdinaryCommand(sessionId)).toBe(true);
  // Without restart reconciliation this receipt refuses every later message.
  await expect(
    create('blocked').admitResume({ ...f.request, clientMsgId: 'blocked' }),
  ).rejects.toThrow();
  expect(f.events.getSendCommand('blocked')).toBeUndefined();

  recoverAfterRestart(f.events);

  expect(f.events.hasUncertainOrdinaryCommand(sessionId)).toBe(false);
  expect(f.events.getSendCommand(f.request.clientMsgId)?.error).toMatch(
    /before this message reached the agent/,
  );
  expect(restartErrors(f, sessionId)).toEqual([
    expect.objectContaining({
      restartCommandId: f.request.clientMsgId,
      error: expect.stringMatching(/before this message reached the agent/),
    }),
  ]);
  await expect(create('next').admitResume({ ...f.request, clientMsgId: 'next' })).resolves.toEqual({
    dispatched: true,
  });
  expect(dispatch).toHaveBeenCalledTimes(2);
});

it('keeps unknown delivery visible when the restart hit between execution start and input echo', async () => {
  const { f, create, sessionId } = await claudeChat(async () => {
    throw Error('server terminated during dispatch');
  });
  await expect(create(f.request.clientMsgId).admit(f.request)).rejects.toThrow();
  f.events.beginOrdinaryLocalVertexCommandExecution(sessionId, f.request.clientMsgId);

  recoverAfterRestart(f.events);

  expect(f.events.hasUncertainOrdinaryCommand(sessionId)).toBe(false);
  const errors = restartErrors(f, sessionId);
  // Delivery is unknown, so only the command notice is shown; no turn notice
  // claims that any tool ran.
  expect(errors).toEqual([
    expect.objectContaining({
      restartCommandId: f.request.clientMsgId,
      error: expect.stringMatching(/may not have received it/),
    }),
  ]);
  await expect(create('next').admitResume({ ...f.request, clientMsgId: 'next' })).resolves.toEqual({
    dispatched: true,
  });
});

/** Run with no native CLI history for any conversation, then restore the mocks. */
async function withoutNativeHistory<T>(run: () => Promise<T>): Promise<T> {
  const account = vi.mocked(readClaudeAccountHistory);
  const info = vi.mocked(getSessionInfo);
  const messages = vi.mocked(getSessionMessages);
  const originals = [
    account.getMockImplementation(),
    info.getMockImplementation(),
    messages.getMockImplementation(),
  ] as const;
  account.mockResolvedValue({ info: undefined, messages: [] } as never);
  info.mockResolvedValue(undefined as never);
  messages.mockResolvedValue([]);
  try {
    return await run();
  } finally {
    account.mockImplementation(originals[0]!);
    info.mockImplementation(originals[1]!);
    messages.mockImplementation(originals[2]!);
  }
}

/** What a reopened chat shows: the stored stream through the public replay contract. */
const restoredText = (f: Awaited<ReturnType<typeof claudeChat>>['f'], sessionId: string) =>
  replayEventsToMessages(f.events.getSessionEvents(sessionId))
    .flatMap((message) => message.blocks.map((block) => ('content' in block ? block.content : '')))
    .join('\n');

it('attaches a restart notice to an already echoed message in restored history', async () => {
  const { f, create, sessionId } = await claudeChat(async () => {
    throw Error('server terminated during cold start');
  });
  await expect(create(f.request.clientMsgId).admit(f.request)).rejects.toThrow();
  // A command echoed before the restart (e.g. a later message in a chat whose
  // CLI had already initialized). The first command's echo is covered below.
  if (!f.events.hasUserMessage(sessionId, f.request.clientMsgId))
    f.events.append(sessionId, 'user_message', {
      v: 2,
      type: 'user_message',
      messageId: f.request.clientMsgId,
      text: 'Do the work',
    });

  recoverAfterRestart(f.events);

  const [notice] = restartErrors(f, sessionId);
  expect(notice).toMatchObject({
    clientMsgId: f.request.clientMsgId,
    retainedCommandFailure: true,
    restartSettlement: 'not_delivered',
    error: expect.stringMatching(/^Message saved\. Mitzo restarted before this message/),
  });
  expect(restoredText(f, sessionId)).toMatch(
    /Mitzo restarted before this message reached the agent/,
  );
});

it.each([
  ['not_delivered', false, /Mitzo restarted before this message reached the agent/],
  ['unknown', true, /Mitzo restarted while this message was being delivered/],
] as const)(
  'shows a %s restart notice for an unechoed first command in restored history',
  async (settlement, executionBegan, text) => {
    const { f, create, sessionId } = await claudeChat(async () => {
      throw Error('server terminated before the CLI initialized');
    });
    await expect(create(f.request.clientMsgId).admit(f.request)).rejects.toThrow();
    if (executionBegan)
      f.events.beginOrdinaryLocalVertexCommandExecution(sessionId, f.request.clientMsgId);
    // The first command's echo is written only at CLI init, which never happened.
    expect(f.events.hasUserMessage(sessionId, f.request.clientMsgId)).toBe(false);
    expect(restoredText(f, sessionId)).not.toMatch(text);

    recoverAfterRestart(f.events);

    const [notice] = restartErrors(f, sessionId);
    expect(notice).toMatchObject({
      restartCommandId: f.request.clientMsgId,
      restartSettlement: settlement,
    });
    // Session level: never attributed to a command the transcript cannot show.
    expect(notice).not.toHaveProperty('clientMsgId');
    expect(restoredText(f, sessionId)).toMatch(text);
  },
);

it('replays restart settlement only with its exact sanctioned text', async () => {
  const { f, sessionId } = await claudeChat();
  f.events.append(sessionId, 'error', {
    type: 'error',
    v: 2,
    sessionId,
    restartCommandId: 'forged',
    restartSettlement: 'not_delivered',
    error: 'Arbitrary startup diagnostic /private/path',
  });
  expect(restoredText(f, sessionId)).not.toContain('Arbitrary startup diagnostic');
});

it('admits the next message on a cold start when the restart preceded the CLI', async () => {
  const { f, create, dispatch, sessionId } = await claudeChat(async () => {
    throw Error('server terminated before the CLI started');
  });
  await expect(create(f.request.clientMsgId).admit(f.request)).rejects.toThrow();
  expect(f.events.getExecutionAdmission(sessionId, f.request.clientMsgId)).toBeUndefined();

  recoverAfterRestart(f.events);
  expect(f.events.getOrdinarySdkInputRestartUndelivered(sessionId, f.request.clientMsgId)).toBe(
    true,
  );
  expect(f.events.hasOnlyCancelledOrdinarySdkInputs(sessionId)).toBe(true);

  await expect(
    withoutNativeHistory(() => create('next').admitResume({ ...f.request, clientMsgId: 'next' })),
  ).resolves.toEqual({ dispatched: true });
  expect(dispatch).toHaveBeenCalledTimes(2);
});

it.each([
  ['before the input was pushed', false],
  ['after the input was pushed but before its echo', true],
] as const)(
  'admits the next message with no CLI history when delivery was unknown %s',
  async (_label, pushed) => {
    const { f, create, dispatch, sessionId } = await claudeChat(
      pushed
        ? undefined
        : async () => {
            throw Error('server terminated during CLI startup');
          },
    );
    const admitted = create(f.request.clientMsgId).admit(f.request);
    if (pushed) await expect(admitted).resolves.toEqual({ dispatched: true });
    else await expect(admitted).rejects.toThrow();
    f.events.beginOrdinaryLocalVertexCommandExecution(sessionId, f.request.clientMsgId);
    if (pushed) f.events.completeOrdinaryLocalVertexCommand(f.request.clientMsgId);

    recoverAfterRestart(f.events);

    expect(restartErrors(f, sessionId)).toEqual([
      expect.objectContaining({ restartSettlement: 'unknown' }),
    ]);
    expect(
      f.events.getOrdinarySdkInputRestartUnacknowledged(sessionId, f.request.clientMsgId),
    ).toBe(true);
    expect(f.events.hasOnlyCancelledOrdinarySdkInputs(sessionId)).toBe(true);
    await expect(
      withoutNativeHistory(() => create('next').admitResume({ ...f.request, clientMsgId: 'next' })),
    ).resolves.toEqual({ dispatched: true });
    expect(dispatch).toHaveBeenCalledTimes(2);
  },
);

it('still requires native history after a restart cut a turn the CLI acknowledged', async () => {
  const { f, create, sessionId } = await claudeChat();
  await expect(create(f.request.clientMsgId).admit(f.request)).resolves.toEqual({
    dispatched: true,
  });
  f.events.beginOrdinaryLocalVertexCommandExecution(sessionId, f.request.clientMsgId);
  const custody = f.events.getOrdinaryLocalVertexCustody(sessionId)!;
  new OrdinarySdkTurnEvidence(f.events, sessionId, custody.sdkSessionId).accepted(
    f.request.clientMsgId,
    'input-uuid',
  );

  recoverAfterRestart(f.events);

  // The CLI acknowledged this input, so its transcript must exist; absent
  // history is a real failure, never a fresh start.
  expect(f.events.getOrdinarySdkInputRestartUnacknowledged(sessionId, f.request.clientMsgId)).toBe(
    false,
  );
  expect(f.events.hasOnlyCancelledOrdinarySdkInputs(sessionId)).toBe(false);
  await expect(
    withoutNativeHistory(() => create('next').admitResume({ ...f.request, clientMsgId: 'next' })),
  ).rejects.toThrow();
});

it('does not treat absent history as undelivered without restart settlement evidence', async () => {
  const { f, create, sessionId } = await claudeChat(async () => {
    throw Error('server terminated before the CLI started');
  });
  await expect(create(f.request.clientMsgId).admit(f.request)).rejects.toThrow();
  // No restart settlement ran: the uncertain claim is not positive evidence.
  expect(f.events.hasOnlyCancelledOrdinarySdkInputs(sessionId)).toBe(false);
});

it('names unknown delivery when the restart hit after input was pushed but before its echo', async () => {
  const { f, create, sessionId } = await claudeChat();
  await expect(create(f.request.clientMsgId).admit(f.request)).resolves.toEqual({
    dispatched: true,
  });
  // The owner began the execution, pushed the input and consumed the receipt;
  // the CLI echo never arrived before the server died.
  f.events.beginOrdinaryLocalVertexCommandExecution(sessionId, f.request.clientMsgId);
  f.events.completeOrdinaryLocalVertexCommand(f.request.clientMsgId);
  expect(f.events.getOrdinaryLocalVertexCommandAdmission(f.request.clientMsgId)?.state).toBe(
    'consumed',
  );

  recoverAfterRestart(f.events);

  expect(f.events.getSession(sessionId)?.executionPhase).toBe('TERMINAL');
  const errors = restartErrors(f, sessionId);
  expect(errors).toEqual([
    expect.objectContaining({
      restartCommandId: f.request.clientMsgId,
      restartSettlement: 'unknown',
      error: expect.stringMatching(/may not have received it/),
    }),
  ]);
  expect(f.events.getSendCommand(f.request.clientMsgId)?.error).toMatch(/may not have received it/);
  // No turn notice claims a tool ran, and a second startup adds nothing.
  recoverAfterRestart(f.events);
  expect(restartErrors(f, sessionId)).toHaveLength(1);
  await expect(create('next').admitResume({ ...f.request, clientMsgId: 'next' })).resolves.toEqual({
    dispatched: true,
  });
});

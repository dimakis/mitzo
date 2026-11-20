import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ownedVertexRuntimeFixture } from './fixtures/owned-local-vertex-runtime.js';
import { ClaudeSubscriptionCustody } from '../claude-subscription-custody.js';
import {
  OrdinaryLocalVertexOwnedRuntime,
  type OrdinaryLocalVertexOwnedDispatch,
} from '../ordinary-local-vertex-owned-runtime.js';
import { OrdinarySdkTurnEvidence } from '../ordinary-sdk-turn-evidence.js';
import { recoverAfterRestart } from '../restart-interruption.js';

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
      clientMsgId: f.request.clientMsgId,
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
      clientMsgId: f.request.clientMsgId,
      error: expect.stringMatching(/may not have received it/),
    }),
  ]);
  await expect(create('next').admitResume({ ...f.request, clientMsgId: 'next' })).resolves.toEqual({
    dispatched: true,
  });
});

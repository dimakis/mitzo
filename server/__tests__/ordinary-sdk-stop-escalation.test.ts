import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ManagedSession } from '@mitzo/harness';
import { OrdinaryLocalVertexCommandOwner } from '../ordinary-local-vertex-command-owner.js';
import { OrdinarySdkTurnEvidence } from '../ordinary-sdk-turn-evidence.js';

vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../app.js', () => ({
  buildSkillRegistry: () => new Map(),
  isAllowedPath: () => true,
  NATIVE_COMMAND_NAMES: new Set(),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => {
    throw Error('Real model calls are forbidden');
  }),
}));
const logged = vi.hoisted(() => [] as Array<{ module: string; message: string; ctx: object }>);
vi.mock('../logger.js', async (original) => {
  const actual = await original<typeof import('../logger.js')>();
  return {
    ...actual,
    createLogger: (module: string) => {
      const record =
        (level: string) =>
        (message: string, ctx: Record<string, unknown> = {}) => {
          logged.push({ module, message, ctx: { level, ...ctx } });
        };
      return {
        debug: record('debug'),
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
      };
    },
  };
});

let chat: typeof import('../chat.js');
let root: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-sdk-stop-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  writeFileSync(join(root, 'mcp.json'), '{"mcpServers":{}}');
  vi.stubEnv('MCP_CONFIG_PATH', join(root, 'mcp.json'));
  chat = await import('../chat.js');
});
afterAll(() => {
  chat?.eventStore.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
beforeEach(() => {
  logged.splice(0);
  chat.ordinarySdkStopEscalation.timeoutMs = 30_000;
});

const binding = {
  version: 2 as const,
  account: {
    accountId: 'personal',
    provider: 'anthropic-claude' as const,
    profileRevision: 'exact-profile',
  },
  harness: { implementation: 'claude-sdk' as const },
  execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'exact-target' },
};
const command = (id: string) => ({
  clientMsgId: id,
  requestFingerprint: `exact-${id}`,
  payload: { text: id },
  selection: {
    version: 1 as const,
    agent: { profileId: 'published', revision: 1 },
    context: { source: 'none' as const, revision: null },
    permission: { mode: 'ask' as const, revision: 0 },
    model: 'first',
    thinking: null,
  },
});
const stopOutcomes = (sessionId: string) =>
  logged
    .filter((entry) => entry.message === 'Ordinary SDK Stop outcome')
    .map((entry) => entry.ctx as Record<string, unknown>)
    .filter((ctx) => ctx.sessionId === sessionId);

/** Chat df1fd50b: a long foreground tool was running and a steer was queued
 * when Stop was pressed. The native interrupt was acknowledged, but no result
 * ever arrived, so the turn stayed STOPPING and six further Stops did nothing. */
async function wedgedTurn(sessionId: string) {
  const store = chat.eventStore;
  const meta = {
    sessionId,
    repositoryWorkspaceId: 'workspace',
    cwd: root,
    accountBinding: { ...binding.account, accountLabel: 'Personal', model: 'first' },
  };
  store.admitOrdinaryLocalVertexCommand(meta, binding, command(`${sessionId}-first`));
  const native = {
    interrupt: vi.fn(async () => true),
    abort: vi.fn(),
  };
  const owners = {
    store,
    sessionId,
    assertCurrent: vi.fn(),
    assertCurrentSync: vi.fn(),
    turnEvidence: new OrdinarySdkTurnEvidence(store, sessionId, 'sdk-thread'),
    ownsClaim: (id: string) =>
      store.getOrdinaryLocalVertexCommandAdmission(id)?.state === 'consumed',
    query: {
      setModel: vi.fn(async () => {}),
      setMaxThinkingTokens: vi.fn(async () => {}),
      push: vi.fn(async () => {}),
      captureInterruptTarget: () => ({}),
      interruptIfCurrent: native.interrupt,
      abort: native.abort,
    },
    settings: () => ({ model: 'first', thinkingTokens: null }),
  };
  const owner = new OrdinaryLocalVertexCommandOwner(owners);
  await owner.enqueue(`${sessionId}-first`);
  owner.assertInputCurrent(`${sessionId}-first`);
  owner.inputObserved('input-echo');
  // The steer is queued behind the running tool; it never becomes this command.
  store.admitOrdinaryLocalVertexContinuation(meta, binding, command(`${sessionId}-next`));
  await owner.enqueue(`${sessionId}-next`);
  const clientId = `client-${sessionId}`;
  chat.registry.register(clientId, {
    transport: { send: vi.fn(), isOpen: () => true },
    abortController: new AbortController(),
    sessionId,
    sessionAllowList: new Set(),
    mode: 'ask',
    cwd: root,
  });
  chat.registry.get(clientId)!.ordinaryRuntimeOwner = {
    sdkTurns: {
      stop: (requestId: string) => owner.stop(requestId),
      stopBeforeInput: (id: string, requestId: string) => owner.stopBeforeInput(id, requestId),
      escalateStop: () => owner.escalateStop(),
      resumeQueue: () => owner.resumeQueue(),
      captureInterruptTarget: () => owner.captureInterruptTarget(),
      interruptIfCurrent: (requestId: string, target: never) =>
        owner.interruptIfCurrent(requestId, target),
    },
  } as unknown as ManagedSession['ordinaryRuntimeOwner'];
  return { store, owners, owner, native, clientId, restart: () => owners };
}

/** After escalation, a fresh owner for the same conversation (the cold-resume
 * path) dispatches the next queued message from the retained ledger. */
async function nextMessageRuns(
  sessionId: string,
  owners: ConstructorParameters<typeof OrdinaryLocalVertexCommandOwner>[0],
) {
  const pushed: string[] = [];
  const resumed = new OrdinaryLocalVertexCommandOwner({
    ...owners,
    query: {
      ...owners.query,
      push: vi.fn(async (id: string) => {
        pushed.push(id);
      }),
    },
  });
  await resumed.resumeQueue();
  await resumed.enqueue(`${sessionId}-next`);
  return pushed;
}

it('escalates a repeated Stop on a wedged turn, logs each outcome, and lets the next message run', async () => {
  const f = await wedgedTurn('repeat');
  chat.stopOrdinaryChat(f.clientId);
  await vi.waitFor(() => expect(f.native.interrupt).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(stopOutcomes('repeat').map((ctx) => ctx.code)).toEqual([
      'ordinary_sdk_stop_requested',
      'ordinary_sdk_stop_accepted',
    ]),
  );
  expect(f.store.getSession('repeat')?.executionPhase).toBe('STOPPING');
  // Before this fix the second Stop returned silently and the chat stayed wedged.
  chat.stopOrdinaryChat(f.clientId);
  expect(f.native.abort).toHaveBeenCalledOnce();
  expect(f.store.getSession('repeat')).toMatchObject({
    executionPhase: 'TERMINAL',
    executionTerminalReason: 'stopped',
  });
  const outcomes = stopOutcomes('repeat');
  expect(outcomes.map((ctx) => ctx.code)).toEqual([
    'ordinary_sdk_stop_requested',
    'ordinary_sdk_stop_accepted',
    'ordinary_sdk_stop_escalated',
  ]);
  for (const ctx of outcomes) {
    expect(ctx).toMatchObject({ sessionId: 'repeat', commandId: 'repeat-first' });
    expect(ctx.requestId).toEqual(expect.any(String));
  }
  expect(outcomes[2]).toMatchObject({ trigger: 'repeat_stop', inputAcknowledged: true });
  // A third Stop after escalation is still observable, never a silent return.
  chat.stopOrdinaryChat(f.clientId);
  expect(stopOutcomes('repeat').at(-1)?.code).toBe('ordinary_sdk_stop_not_running');
  expect(await nextMessageRuns('repeat', f.owners)).toEqual(['repeat-next']);
});

it('escalates a wedged Stop after the bounded timeout without a second Stop', async () => {
  chat.ordinarySdkStopEscalation.timeoutMs = 20;
  const f = await wedgedTurn('timeout');
  chat.stopOrdinaryChat(f.clientId);
  await vi.waitFor(() => expect(f.native.abort).toHaveBeenCalledOnce());
  expect(f.store.getSession('timeout')).toMatchObject({
    executionPhase: 'TERMINAL',
    executionTerminalReason: 'stopped',
  });
  expect(stopOutcomes('timeout').at(-1)).toMatchObject({
    code: 'ordinary_sdk_stop_escalated',
    trigger: 'timeout',
    commandId: 'timeout-first',
  });
  expect(await nextMessageRuns('timeout', f.owners)).toEqual(['timeout-next']);
});

it('leaves a closed or replaced runtime alone when the bound elapses', async () => {
  chat.ordinarySdkStopEscalation.timeoutMs = 20;
  const f = await wedgedTurn('replaced');
  chat.stopOrdinaryChat(f.clientId);
  await vi.waitFor(() => expect(f.native.interrupt).toHaveBeenCalledOnce());
  // The runtime closed (for example at shutdown, when the store also closes).
  chat.registry.get(f.clientId)!.ordinaryRuntimeOwner = undefined;
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(f.native.abort).not.toHaveBeenCalled();
  expect(stopOutcomes('replaced').map((ctx) => ctx.code)).not.toContain(
    'ordinary_sdk_stop_escalated',
  );
});

it('does not escalate when the stopped turn settles within the bound', async () => {
  chat.ordinarySdkStopEscalation.timeoutMs = 20;
  const f = await wedgedTurn('settled');
  chat.stopOrdinaryChat(f.clientId);
  await vi.waitFor(() => expect(f.native.interrupt).toHaveBeenCalledOnce());
  await f.owner.resultObserved('input-echo', true, { dispatchSuccessor: false });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(f.native.abort).not.toHaveBeenCalled();
  expect(f.store.getSession('settled')).toMatchObject({
    executionPhase: 'TERMINAL',
    executionTerminalReason: 'stopped',
  });
  expect(stopOutcomes('settled').map((ctx) => ctx.code)).not.toContain(
    'ordinary_sdk_stop_escalated',
  );
});

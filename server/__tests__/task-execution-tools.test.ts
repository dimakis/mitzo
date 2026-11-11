import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import {
  bindAgentLibraryTransport,
  OperatorAuthorizationError,
} from '../agent-library-transport.js';
import { TaskExecutionStore } from '../task-execution-store.js';
import { sessionTaskExecutionTools } from '../task-execution-tools.js';
import { revokeAuthSession } from '../auth.js';
import { retainNativeHostToolOperator } from '../native-host-tool-operator.js';
import { SessionCapabilityGrants } from '../session-capability-grants.js';
import { callbackOutcome, retainCallbackOutcome } from '../turn-callbacks.js';

const execution = vi.hoisted(() => ({
  waitForAbort: false,
  fail: false,
  failAuthentication: false,
  returnedFailure: undefined as 'settled' | 'unknown' | undefined,
  calls: [] as Array<{ block: unknown; options: Record<string, unknown> }>,
}));
vi.mock('../native-tool-executor.js', () => ({
  createNativeToolExecutor:
    (_client: string, _registry: unknown, options: Record<string, unknown>) =>
    async (block: unknown, signal: AbortSignal) => {
      (options.assertRuntimeCurrent as () => void)();
      execution.calls.push({ block, options });
      if (execution.failAuthentication)
        throw new OperatorAuthorizationError('Operator authorization revoked');
      if (execution.fail) throw Error('Runner connection lost');
      if (execution.returnedFailure)
        return retainCallbackOutcome(
          {
            type: 'tool_result',
            tool_use_id: 'call',
            content: 'Test exited with code 1',
            is_error: true,
          },
          execution.returnedFailure,
        );
      if (execution.waitForAbort)
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      return { type: 'tool_result', tool_use_id: 'call', content: '3 passed', is_error: false };
    },
}));
const cleanup: Array<() => void> = [];
it('inherits development consent for command variants and stops on its revocation', async () => {
  const f = fixture();
  const parent = f.registry.findBySessionId('parent')!.session;
  parent.accountBinding = {
    accountId: 'a',
    accountLabel: 'Offline',
    provider: 'openai-codex',
    model: 'm',
    profileRevision: 'r',
  };
  const grants = new SessionCapabilityGrants(f.registry);
  const consent = grants.create('operator', {
    sessionIds: ['parent'],
    capability: { kind: 'development' },
    durationMinutes: 60,
  });
  const approved = await f
    .tools('parent')
    .execute({ ...f.request, memberSessionIds: [], repositories: [] }, f.signal, f.call);
  expect(approved.isError).toBe(false);
  expect(f.sent.filter((event) => event.type === 'permission_request')).toHaveLength(0);
  const grant = JSON.parse(approved.content).grant;
  for (const command of ['npm test', 'npm run build']) {
    expect(
      (
        await f
          .tools('parent')
          .execute(
            { operation: 'run', grantId: grant.id, requestId: randomUUID(), command },
            f.signal,
            f.call,
          )
      ).isError,
    ).toBe(false);
  }
  await grants.revoke('operator', 'parent', consent.id);
  expect(
    JSON.parse((await f.tools('parent').execute({ operation: 'status' }, f.signal)).content).grants,
  ).toEqual([]);
  expect(
    (
      await f
        .tools('parent')
        .execute(
          { operation: 'run', grantId: grant.id, requestId: randomUUID(), command: 'npm test' },
          f.signal,
          f.call,
        )
    ).isError,
  ).toBe(true);
  expect(execution.calls).toHaveLength(2);
  expect(
    (await f.tools('parent').execute({ operation: 'revoke', grantId: grant.id }, f.signal, f.call))
      .isError,
  ).toBe(false);
});
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  execution.calls.length = 0;
  execution.waitForAbort = false;
  execution.fail = false;
  execution.failAuthentication = false;
  execution.returnedFailure = undefined;
  vi.useRealTimers();
});
function fixture(auth = { id: 'operator', expiresAt: Date.now() + 600_000 }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-tools-')));
  cleanup.push(() => rmSync(root, { recursive: true }));
  const store = new TaskExecutionStore(join(root, 'events.db'));
  cleanup.push(() => store.close());
  const registry = new SessionRegistry();
  cleanup.push(() => registry.dispose());
  const sent: Record<string, unknown>[] = [];
  for (const name of ['parent', 'worker', 'stranger']) {
    mkdirSync(join(root, name));
    registry.register(name + ':' + name, {
      transport: { send: (event) => sent.push(event), isOpen: () => true },
      sessionId: name,
      mode: 'agent',
      cwd: join(root, name),
      sessionAllowList: new Set(),
      abortController: new AbortController(),
      ownedLocalAuthSessionId: auth.id,
    });
    cleanup.push(bindAgentLibraryTransport(name, auth));
  }
  const tools = (id: string, prefix = '') =>
    sessionTaskExecutionTools({
      sessionId: id,
      session: registry.findBySessionId(id)!.session,
      registry,
      prefix,
      store: () => store,
      assertRuntimeCurrent: async () => {},
      assertRuntimeCurrentSync() {},
    });
  const call = { turnId: 'turn', callId: randomUUID() };
  const signal = new AbortController().signal;
  const request = {
    operation: 'authorize',
    requestId: randomUUID(),
    title: 'Implement change',
    memberSessionIds: ['worker'],
    repositories: ['owner/repo'],
    network: 'loopback',
    durationMinutes: 5,
  };
  async function authorize() {
    const pending = tools('parent').execute(request, signal, call);
    await vi.waitFor(() => expect(sent.some((x) => x.type === 'permission_request')).toBe(true));
    const card = sent.find((x) => x.type === 'permission_request')!;
    resolvePending(card.permId as string, 'once', undefined, 'parent');
    const result = await pending;
    expect(result.isError, result.content).toBe(false);
    return JSON.parse(result.content).grant;
  }
  return { root, store, registry, sent, tools, call, signal, request, authorize, auth };
}

it('reuses one task grant for different CI job logs and literal filters', async () => {
  const f = fixture();
  const grant = await f.authorize();
  f.sent.length = 0;
  for (const job of [123, 456]) {
    const result = await f.tools('worker').execute(
      {
        operation: 'github_read',
        grantId: grant.id,
        requestId: randomUUID(),
        endpoint: `/repos/owner/repo/actions/jobs/${job}/logs`,
        log: { query: 'FAIL', offset: 0 },
      },
      f.signal,
      f.call,
    );
    expect(result.isError, result.content).toBe(false);
  }
  expect(f.sent.filter((event) => event.type === 'permission_request')).toHaveLength(0);
  expect(execution.calls).toHaveLength(2);
  expect(execution.calls[1].block).toMatchObject({
    name: 'GitHubRead',
    input: { log: { query: 'FAIL', offset: 0 } },
  });
  const outside = await f.tools('worker').execute(
    {
      operation: 'github_read',
      grantId: grant.id,
      requestId: randomUUID(),
      endpoint: '/repos/other/repo/actions/jobs/456/logs',
      log: {},
    },
    f.signal,
    f.call,
  );
  expect(outside.isError).toBe(true);
  expect(execution.calls).toHaveLength(2);
});

it.each(['', 'mcp__mitzo-connections__'])(
  'returns current bounded execution routing for %s tools and removes it after revocation',
  async (prefix) => {
    const f = fixture();
    const grant = await f.authorize();
    const read = async () =>
      JSON.parse(
        (await f.tools('worker', prefix).execute({ operation: 'status' }, f.signal)).content,
      );
    const current = await read();
    expect(current.executionRoute).toEqual({
      tool: prefix + 'TaskExecution',
      grantIds: [grant.id],
      operations: ['run', 'github_read', 'commit'],
      executionLocation: 'host',
      nativeToolsCovered: false,
    });
    f.registry.findBySessionId('worker')!.session.mode = 'ask';
    expect((await read()).executionRoute).toBeNull();
    f.registry.findBySessionId('worker')!.session.mode = 'agent';
    f.store.revoke(grant.id, f.auth.id, 'parent');
    expect(await read()).toMatchObject({ grants: [], executionRoute: null });
  },
);
it.each(['settled', 'unknown'] as const)(
  'preserves a returned %s failure through task projection and identical retry',
  async (outcome) => {
    const f = fixture();
    const grant = await f.authorize();
    execution.returnedFailure = outcome;
    const input = {
      operation: 'run',
      grantId: grant.id,
      requestId: randomUUID(),
      command: 'npm test',
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await f.tools('worker').execute(input, f.signal, f.call);
      expect(result.isError).toBe(true);
      expect(callbackOutcome(result)).toBe(outcome);
      if (outcome === 'settled') expect(result.content).toBe('Test exited with code 1');
      expect(f.store.runStatus(grant.id, 'worker', input.requestId).state).toBe(
        outcome === 'settled' ? 'completed' : 'uncertain',
      );
    }
    expect(execution.calls).toHaveLength(1);
  },
);

it('cancels worker execution when a separately held parent capability is revoked', async () => {
  const f = fixture();
  const grants = new SessionCapabilityGrants(f.registry);
  const consents = ['parent', 'worker'].map((id) => {
    f.registry.findBySessionId(id)!.session.accountBinding = {
      accountId: 'a',
      accountLabel: 'Offline',
      provider: 'openai-codex',
      model: 'm',
      profileRevision: 'r',
    };
    return grants.create('operator', {
      sessionIds: [id],
      capability: { kind: 'development' },
      durationMinutes: 60,
    });
  });
  const approved = await f
    .tools('parent')
    .execute({ ...f.request, repositories: [] }, f.signal, f.call);
  expect(approved.isError).toBe(false);
  expect(f.sent).toHaveLength(0);
  const grant = JSON.parse(approved.content).grant;
  execution.waitForAbort = true;
  const input = {
    operation: 'run',
    grantId: grant.id,
    requestId: randomUUID(),
    command: 'npm test',
  };
  const pending = f.tools('worker').execute(input, f.signal, f.call);
  await vi.waitFor(() => expect(execution.calls).toHaveLength(1));
  await grants.revoke('operator', 'parent', consents[0].id);
  const status = await f.tools('worker').execute({ operation: 'status' }, f.signal);
  expect(JSON.parse(status.content).grants).toEqual([]);
  expect((await pending).isError).toBe(true);
  expect(f.store.runStatus(grant.id, 'worker', input.requestId).state).toBe('uncertain');
  expect(
    (await f.tools('worker').execute({ ...input, requestId: randomUUID() }, f.signal, f.call))
      .isError,
  ).toBe(true);
  expect(execution.calls).toHaveLength(1);
});
it('authorizes detached retained workers and executes their grant after viewer replacement', async () => {
  const f = fixture({ id: randomUUID(), expiresAt: Date.now() + 600000 });
  for (const id of ['parent', 'worker']) {
    const session = f.registry.findBySessionId(id)!.session;
    cleanup.push(retainNativeHostToolOperator(session, id));
    session.ownerConnectionId = 'disconnected-' + id;
  }
  const grant = await f.authorize();
  const result = await f.tools('worker').execute(
    {
      operation: 'run',
      grantId: grant.id,
      requestId: randomUUID(),
      command: 'npm test',
    },
    f.signal,
    f.call,
  );
  expect(result.isError, result.content).toBe(false);
  expect(execution.calls).toHaveLength(1);
  revokeAuthSession(f.auth);
  expect((await f.tools('worker').execute({ operation: 'status' }, f.signal)).isError).toBe(true);
});
it.each(['disconnected', 'expired'])(
  'explains %s operator authentication without circular status recovery',
  async (reason) => {
    const f = fixture();
    const session = f.registry.findBySessionId('worker')!.session;
    session.ownerConnectionId = 'unavailable-worker';
    if (reason === 'expired')
      cleanup.push(
        bindAgentLibraryTransport('unavailable-worker', {
          id: 'operator',
          expiresAt: Date.now() - 1,
        }),
      );
    const result = await f.tools('worker').execute({ operation: 'status' }, f.signal);
    expect(result.isError).toBe(true);
    const failure = JSON.parse(result.content);
    expect(failure).toMatchObject({
      code: 'operator_authentication_required',
      operation: 'status',
      effectStatus: 'not_started',
    });
    expect(failure.error).toMatch(/TaskExecution.*authenticated.*connection/i);
    expect(failure.error).not.toMatch(/agent profile/);
    expect(failure.recovery).toMatch(/reconnect.*chat/i);
    expect(failure.recovery).not.toMatch(/Inspect TaskExecution status|requestId/);
    expect(failure).not.toHaveProperty('requestId');
    expect(execution.calls).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
    session.ownerConnectionId = 'worker';
    const reconnected = await f.tools('worker').execute({ operation: 'status' }, f.signal);
    expect(reconnected.isError, reconnected.content).toBe(false);
    expect(execution.calls).toHaveLength(0);
  },
);

it('preserves an explicit task authorization denial without automatic recovery', async () => {
  const f = fixture();
  const pending = f.tools('parent').execute(f.request, f.signal, f.call);
  await vi.waitFor(() =>
    expect(f.sent.some((event) => event.type === 'permission_request')).toBe(true),
  );
  const card = f.sent.find((event) => event.type === 'permission_request')!;
  resolvePending(card.permId as string, 'deny', undefined, 'parent');
  const result = await pending;
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content).failure).toMatchObject({
    code: 'permission_denied',
    phase: 'approval',
    effectStatus: 'not_started',
    recovery: 'none',
  });
  expect(execution.calls).toHaveLength(0);
});

it('classifies invalid task input and cancellation before execution', async () => {
  const f = fixture();
  const invalid = await f.tools('parent').execute({ operation: 'missing' }, f.signal, f.call);
  expect(JSON.parse(invalid.content).failure).toMatchObject({
    code: 'invalid_input',
    effectStatus: 'not_started',
    recovery: 'correct_input',
  });
  const cancelled = AbortSignal.abort();
  const result = await f.tools('parent').execute({ operation: 'status' }, cancelled);
  expect(JSON.parse(result.content).failure).toMatchObject({
    code: 'cancelled',
    effectStatus: 'not_started',
    recovery: 'none',
  });
});
it('does not describe a rejected request as uncertain execution', async () => {
  const f = fixture();
  f.registry.findBySessionId('worker')!.session.mode = 'ask';
  const result = await f
    .tools('worker')
    .execute({ operation: 'authorize', title: 'Work', requestId: randomUUID() }, f.signal, f.call);
  const failure = JSON.parse(result.content);
  expect(failure.effectStatus).toBe('not_started');
  expect(failure.recovery).not.toMatch(/uncertain|Inspect TaskExecution status/);
  expect(execution.calls).toHaveLength(0);
});
it.each(['runner', 'authentication'])(
  'preserves receipt recovery after a dispatched %s failure',
  async (reason) => {
    const f = fixture();
    const grant = await f.authorize();
    execution.fail = reason === 'runner';
    execution.failAuthentication = reason === 'authentication';
    const requestId = randomUUID();
    const result = await f
      .tools('worker')
      .execute(
        { operation: 'run', grantId: grant.id, requestId, command: 'npm test' },
        f.signal,
        f.call,
      );
    expect(JSON.parse(result.content)).toMatchObject({
      operation: 'run',
      effectStatus: 'unknown',
      requestId,
      recovery: expect.stringMatching(/original requestId/),
    });
    if (reason === 'authentication') {
      expect(JSON.parse(result.content).recovery).toMatch(/Reconnect.*After reconnecting/);
      expect(JSON.parse(result.content).code).toBe('operator_authentication_required');
    }
    const status = await f
      .tools('worker')
      .execute({ operation: 'status', grantId: grant.id, requestId }, f.signal);
    expect(JSON.parse(status.content).run.state).toBe('uncertain');
    const retry = await f
      .tools('worker')
      .execute(
        { operation: 'run', grantId: grant.id, requestId, command: 'npm test' },
        f.signal,
        f.call,
      );
    expect(JSON.parse(retry.content)).toMatchObject({
      effectStatus: 'unknown',
      requestId,
      recovery: expect.stringMatching(/original grantId\/requestId/),
    });
    expect(execution.calls).toHaveLength(1);
  },
);
it.each(['revocation', 'expiry'])(
  'reports actual in-flight login %s as authentication loss',
  async (reason) => {
    vi.useFakeTimers();
    const f = fixture({ id: randomUUID(), expiresAt: Date.now() + 60_000 });
    const grant = await f.authorize();
    execution.waitForAbort = true;
    const requestId = randomUUID();
    const pending = f
      .tools('worker')
      .execute(
        { operation: 'run', grantId: grant.id, requestId, command: 'npm test' },
        f.signal,
        f.call,
      );
    await vi.waitFor(() => expect(execution.calls).toHaveLength(1));
    if (reason === 'revocation') revokeAuthSession(f.auth);
    else await vi.advanceTimersByTimeAsync(f.auth.expiresAt - Date.now() + 1);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      code: 'operator_authentication_required',
      effectStatus: 'unknown',
      requestId,
      recovery: expect.stringMatching(/Reconnect.*After reconnecting.*original requestId/),
    });
    expect(f.store.runStatus(grant.id, 'worker', requestId).state).toBe('uncertain');
    expect(execution.calls).toHaveLength(1);
  },
);
it('approves the selected task once and lets its worker run different commands', async () => {
  const f = fixture();
  const grant = await f.authorize();
  const card = f.sent.find((x) => x.type === 'permission_request')!;
  expect(card.allowSessionGrant).toBe(false);
  expect(card.toolInput).toContain('worker');
  for (const command of ['npm test -- first', 'npm test -- second']) {
    const result = await f
      .tools('worker')
      .execute(
        { operation: 'run', grantId: grant.id, requestId: randomUUID(), command },
        f.signal,
        f.call,
      );
    expect(result.isError, result.content).toBe(false);
  }
  expect(execution.calls).toHaveLength(2);
  expect(f.sent.filter((x) => x.type === 'permission_request')).toHaveLength(1);
});
it('retains an uncertain runner outcome and reports it without repeating the effect', async () => {
  const f = fixture();
  const grant = await f.authorize();
  const input = {
    operation: 'run',
    grantId: grant.id,
    requestId: randomUUID(),
    command: 'npm test',
  };
  f.store.begin(grant.id, 'worker', input.requestId, 'interrupted');
  const status = await f
    .tools('worker')
    .execute({ operation: 'status', grantId: grant.id, requestId: input.requestId }, f.signal);
  expect(status.isError).toBe(false);
  expect(JSON.parse(status.content).run.state).toBe('uncertain');
  expect(execution.calls).toHaveLength(0);
});
it('does not silently reuse a changed task authorization duration', async () => {
  const f = fixture();
  await f.authorize();
  const result = await f
    .tools('parent')
    .execute({ ...f.request, durationMinutes: 10 }, f.signal, f.call);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/changed/);
});
it('keeps completed command retries idempotent and task approval retries prompt-free', async () => {
  const f = fixture();
  const grant = await f.authorize();
  const input = {
    operation: 'run',
    grantId: grant.id,
    requestId: randomUUID(),
    command: 'npm test',
  };
  expect((await f.tools('worker').execute(input, f.signal, f.call)).isError).toBe(false);
  expect((await f.tools('worker').execute(input, f.signal, f.call)).isError).toBe(false);
  expect(execution.calls).toHaveLength(1);
  expect((await f.tools('parent').execute(f.request, f.signal, f.call)).isError).toBe(false);
  expect(f.sent.filter((x) => x.type === 'permission_request')).toHaveLength(1);
});
it('refuses an unrelated worker and a changed workspace before any command effect', async () => {
  const f = fixture();
  const grant = await f.authorize();
  const input = {
    operation: 'run',
    grantId: grant.id,
    requestId: randomUUID(),
    command: 'npm test',
  };
  expect((await f.tools('stranger').execute(input, f.signal, f.call)).isError).toBe(true);
  renameSync(join(f.root, 'worker'), join(f.root, 'old-worker'));
  mkdirSync(join(f.root, 'worker'));
  const result = await f.tools('worker').execute(input, f.signal, f.call);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/scope|workspace/);
  expect(execution.calls).toHaveLength(0);
});
it('does not turn a same-operator viewing transport into another runtime owner', async () => {
  const f = fixture();
  f.registry.findBySessionId('worker')!.session.ownedLocalAuthSessionId =
    'different-runtime-operator';
  const result = await f.tools('parent').execute(f.request, f.signal, f.call);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/operator/);
  expect(f.sent.filter((event) => event.type === 'permission_request')).toHaveLength(0);
});
it('honors Ask mode, revocation, expiration and missing verified call identity', async () => {
  const f = fixture();
  const grant = await f.authorize();
  const input = {
    operation: 'run',
    grantId: grant.id,
    requestId: randomUUID(),
    command: 'npm test',
  };
  expect((await f.tools('worker').execute(input, f.signal)).isError).toBe(true);
  f.registry.findBySessionId('worker')!.session.mode = 'ask';
  expect((await f.tools('worker').execute(input, f.signal, f.call)).isError).toBe(true);
  f.registry.findBySessionId('worker')!.session.mode = 'agent';
  f.store.revoke(grant.id, 'operator', 'parent');
  expect((await f.tools('worker').execute(input, f.signal, f.call)).content).toMatch(/revoked/);
  expect(execution.calls).toHaveLength(0);
});
it('cancels active worker execution on revocation while keeping its receipt inspectable', async () => {
  const f = fixture();
  const grant = await f.authorize();
  execution.waitForAbort = true;
  const requestId = randomUUID();
  const running = f
    .tools('worker')
    .execute(
      { operation: 'run', grantId: grant.id, requestId, command: 'npm test' },
      f.signal,
      f.call,
    );
  await vi.waitFor(() => expect(execution.calls).toHaveLength(1));
  f.store.revoke(grant.id, 'operator', 'parent');
  expect((await running).isError).toBe(true);
  const status = await f
    .tools('worker')
    .execute({ operation: 'status', grantId: grant.id, requestId }, f.signal);
  expect(status.isError, status.content).toBe(false);
  expect(JSON.parse(status.content).run.state).toBe('uncertain');
});
it('binds repository reads to the approved repositories and never grants account-wide reads', async () => {
  const f = fixture();
  const grant = await f.authorize();
  for (const endpoint of ['/user', '/repos/owner/another/pulls', '/repos/owner/repo-other/pulls']) {
    const result = await f
      .tools('worker')
      .execute(
        { operation: 'github_read', grantId: grant.id, requestId: randomUUID(), endpoint },
        f.signal,
        f.call,
      );
    expect(result.isError).toBe(true);
  }
  expect(
    (
      await f.tools('worker').execute(
        {
          operation: 'github_read',
          grantId: grant.id,
          requestId: randomUUID(),
          endpoint: '/repos/owner/repo/pulls',
        },
        f.signal,
        f.call,
      )
    ).isError,
  ).toBe(false);
  expect(execution.calls).toHaveLength(1);
});
it('exposes the same task scope through SDK-prefixed and ordinary tool calls', async () => {
  const f = fixture();
  const grant = await f.authorize();
  const result = await f
    .tools('worker', 'mcp__mitzo-connections__')
    .execute(
      { operation: 'run', grantId: grant.id, requestId: randomUUID(), command: 'npm test' },
      f.signal,
      f.call,
    );
  expect(result.isError, result.content).toBe(false);
  const status = await f.tools('worker').execute({ operation: 'status' }, f.signal);
  expect(JSON.parse(status.content).grants[0].id).toBe(grant.id);
});
it.each(['anthropic-vertex', 'openai', 'openai-codex'])(
  'shows the selected %s worker account in the task scope',
  async (provider) => {
    const f = fixture();
    f.registry.findBySessionId('worker')!.session.accountBinding = {
      accountId: 'selected-worker-account',
      accountLabel: 'Worker account',
      provider,
      profileRevision: 'revision',
      model: 'offline-fixture-model',
    };
    const grant = await f.authorize();
    const worker = grant.members.find(
      (member: { sessionId: string }) => member.sessionId === 'worker',
    );
    expect(worker.account.accountId).toBe('selected-worker-account');
    expect(worker.account.provider).toBe(provider);
  },
);

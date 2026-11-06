import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { TaskExecutionStore } from '../task-execution-store.js';
import { sessionTaskExecutionTools } from '../task-execution-tools.js';
import { retainNativeHostToolOperator } from '../native-host-tool-operator.js';

const execution = vi.hoisted(() => ({
  waitForAbort: false,
  calls: [] as Array<{ block: unknown; options: Record<string, unknown> }>,
}));
vi.mock('../native-tool-executor.js', () => ({
  createNativeToolExecutor:
    (_client: string, _registry: unknown, options: Record<string, unknown>) =>
    async (block: unknown, signal: AbortSignal) => {
      (options.assertRuntimeCurrent as () => void)();
      execution.calls.push({ block, options });
      if (execution.waitForAbort)
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      return { type: 'tool_result', tool_use_id: 'call', content: '3 passed', is_error: false };
    },
}));
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  execution.calls.length = 0;
  execution.waitForAbort = false;
  vi.useRealTimers();
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-tools-')));
  cleanup.push(() => rmSync(root, { recursive: true }));
  const store = new TaskExecutionStore(join(root, 'events.db'));
  cleanup.push(() => store.close());
  const registry = new SessionRegistry();
  cleanup.push(() => registry.dispose());
  const sent: Record<string, unknown>[] = [];
  const auth = { id: 'operator', expiresAt: Date.now() + 600_000 };
  const disconnects = new Map<string, () => void>();
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
    const disconnect = bindAgentLibraryTransport(name, auth);
    disconnects.set(name, disconnect);
    cleanup.push(disconnect);
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
  async function authorize(beforeDecision?: () => void) {
    const pending = tools('parent').execute(request, signal, call);
    await vi.waitFor(() => expect(sent.some((x) => x.type === 'permission_request')).toBe(true));
    const card = sent.find((x) => x.type === 'permission_request')!;
    beforeDecision?.();
    resolvePending(card.permId as string, 'once', undefined, 'parent');
    const result = await pending;
    expect(result.isError, result.content).toBe(false);
    return JSON.parse(result.content).grant;
  }
  const retain = (id: string) => {
    const release = retainNativeHostToolOperator(registry.findBySessionId(id)!.session, id);
    cleanup.push(release);
    return release;
  };
  const disconnect = (id: string) => disconnects.get(id)!();
  return {
    root,
    store,
    registry,
    sent,
    tools,
    call,
    signal,
    request,
    authorize,
    retain,
    disconnect,
  };
}
it('authorizes disconnected retained workers and keeps their task status and commands usable', async () => {
  const f = fixture();
  for (const id of ['parent', 'worker']) {
    f.retain(id);
    f.disconnect(id);
  }
  const grant = await f.authorize();
  const status = await f.tools('worker').execute({ operation: 'status' }, f.signal);
  expect(status.isError, status.content).toBe(false);
  expect(JSON.parse(status.content).grants[0].id).toBe(grant.id);
  const result = await f
    .tools('worker')
    .execute(
      { operation: 'run', grantId: grant.id, requestId: randomUUID(), command: 'npm test' },
      f.signal,
      f.call,
    );
  expect(result.isError, result.content).toBe(false);
  expect(execution.calls).toHaveLength(1);
});
it('keeps task approval bound to retained source and worker identities when viewers change', async () => {
  const f = fixture();
  for (const id of ['parent', 'worker']) f.retain(id);
  const grant = await f.authorize(() => {
    for (const id of ['parent', 'worker']) {
      f.disconnect(id);
      const viewer = `other-viewer-${id}`;
      cleanup.push(
        bindAgentLibraryTransport(viewer, {
          id: 'different-operator',
          expiresAt: Date.now() + 600_000,
        }),
      );
      f.registry.findBySessionId(id)!.session.ownerConnectionId = viewer;
    }
  });
  expect(grant.members.map((member: { sessionId: string }) => member.sessionId)).toEqual([
    'parent',
    'worker',
  ]);
  expect(execution.calls).toHaveLength(0);
});
it('does not fall back to a connected viewer after releasing a retained task operator', async () => {
  const f = fixture();
  const grant = await f.authorize();
  f.retain('worker')();
  const result = await f
    .tools('worker')
    .execute(
      { operation: 'run', grantId: grant.id, requestId: randomUUID(), command: 'npm test' },
      f.signal,
      f.call,
    );
  expect(result.isError).toBe(true);
  expect(execution.calls).toHaveLength(0);
});
it.each(['parent', 'worker'])(
  'refuses approval if the retained %s operator is released while waiting',
  async (id) => {
    const f = fixture();
    const releases = new Map(['parent', 'worker'].map((member) => [member, f.retain(member)]));
    const pending = f.tools('parent').execute(f.request, f.signal, f.call);
    await vi.waitFor(() =>
      expect(f.sent.some((event) => event.type === 'permission_request')).toBe(true),
    );
    releases.get(id)!();
    const card = f.sent.find((event) => event.type === 'permission_request')!;
    resolvePending(card.permId as string, 'once', undefined, 'parent');
    expect((await pending).isError).toBe(true);
    expect(f.store.active('operator', 'parent')).toHaveLength(0);
    expect(execution.calls).toHaveLength(0);
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

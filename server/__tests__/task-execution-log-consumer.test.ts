import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { TaskExecutionStore } from '../task-execution-store.js';
import { sessionTaskExecutionTools } from '../task-execution-tools.js';

// Keep task admission, native permission handling and trusted log paging real.
// Only the external GitHub process is substituted; no credentials/network used.
const github = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (...args: Parameters<typeof actual.execFile>) => {
      if (args[0] !== 'gh') throw Error('Unexpected external process in log fixture');
      return github.execute(...args);
    },
  };
});
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  github.execute.mockReset();
  vi.useRealTimers();
});

async function fixture(provider: string, prefix = '') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-log-consumer-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new TaskExecutionStore(join(root, 'events.db'));
  cleanup.push(() => store.close());
  const registry = new SessionRegistry();
  cleanup.push(() => registry.dispose());
  const sent: Record<string, unknown>[] = [];
  const auth = { id: randomUUID(), expiresAt: Date.now() + 600_000 };
  for (const name of ['owner', 'worker', 'unselected']) {
    mkdirSync(join(root, name));
    registry.register(name + ':' + name, {
      transport: { send: (event) => sent.push(event), isOpen: () => true },
      sessionId: name,
      mode: 'agent',
      cwd: join(root, name),
      sessionAllowList: new Set(),
      abortController: new AbortController(),
      ownedLocalAuthSessionId: auth.id,
      accountBinding: {
        accountId: 'offline-account',
        accountLabel: 'Offline fixture',
        provider,
        model: 'offline-fixture',
        profileRevision: 'fixture-revision',
      },
    });
    cleanup.push(bindAgentLibraryTransport(name, auth));
  }
  const tools = (name: string) =>
    sessionTaskExecutionTools({
      sessionId: name,
      session: registry.findBySessionId(name)!.session,
      registry,
      prefix,
      store: () => store,
      assertRuntimeCurrent: async () => {},
      assertRuntimeCurrentSync() {},
    });
  const signal = new AbortController().signal;
  const call = { turnId: 'offline-turn', callId: randomUUID() };
  const pending = tools('owner').execute(
    {
      operation: 'authorize',
      requestId: randomUUID(),
      title: 'Inspect CI failure logs',
      memberSessionIds: ['worker'],
      repositories: ['owner/repo'],
      network: 'none',
      durationMinutes: 5,
    },
    signal,
    call,
  );
  await vi.waitFor(() =>
    expect(sent.some((event) => event.type === 'permission_request')).toBe(true),
  );
  resolvePending(
    sent.find((event) => event.type === 'permission_request')!.permId as string,
    'once',
    undefined,
    'owner',
  );
  const approved = await pending;
  expect(approved.isError, approved.content).toBe(false);
  const grant = JSON.parse(approved.content).grant;
  const input = (job: number, query = 'FAIL') => ({
    operation: 'github_read',
    grantId: grant.id,
    requestId: randomUUID(),
    endpoint: `/repos/owner/repo/actions/jobs/${job}/logs`,
    log: { query, limit: 16000 },
  });
  return { store, registry, sent, auth, tools, signal, call, grant, input };
}

it.each([
  ['openai-codex', ''],
  ['anthropic', 'mcp__mitzo-connections__'],
  ['anthropic-vertex', 'mcp__mitzo-connections__'],
])(
  'reuses the selected %s worker grant through the real log consumer',
  async (provider, prefix) => {
    const f = await fixture(provider, prefix);
    github.execute.mockImplementation((_file, args, options, callback) => {
      expect(args.slice(0, 5)).toEqual(['api', '--hostname', 'github.com', '--method', 'GET']);
      expect(options.maxBuffer).toBe(8 * 1024 * 1024);
      callback(null, 'setup\nFAIL [literal] job failed\nPASS finished\n', '');
      return {};
    });
    const status = JSON.parse(
      (await f.tools('worker').execute({ operation: 'status' }, f.signal)).content,
    );
    expect(status.executionRoute).toMatchObject({
      tool: prefix + 'TaskExecution',
      grantIds: [f.grant.id],
      nativeToolsCovered: false,
    });
    expect(
      JSON.parse((await f.tools('unselected').execute({ operation: 'status' }, f.signal)).content)
        .grants,
    ).toEqual([]);
    for (const [job, query, content] of [
      [123, '[literal]', 'FAIL [literal] job failed'],
      [456, 'PASS', 'PASS finished'],
    ] as const) {
      const input = f.input(job, query);
      const result = await f.tools('worker').execute(input, f.signal, f.call);
      expect(result.isError, result.content).toBe(false);
      expect(JSON.parse(result.content)).toMatchObject({ content, nextOffset: null });
      // A repeated delivery keeps the original request ID and does not refetch.
      expect(await f.tools('worker').execute(input, f.signal, f.call)).toEqual(result);
      expect(f.store.runStatus(f.grant.id, 'worker', input.requestId).state).toBe('completed');
    }
    expect(github.execute).toHaveBeenCalledTimes(2);
    expect(f.sent.filter((event) => event.type === 'permission_request')).toHaveLength(1);
    const refused = await f.tools('unselected').execute(f.input(789), f.signal, f.call);
    expect(refused.isError).toBe(true);
    expect(github.execute).toHaveBeenCalledTimes(2);
  },
);

it.each(['revocation', 'expiry'] as const)(
  'cancels an in-flight log on %s and preserves its uncertain receipt',
  async (reason) => {
    const f = await fixture('openai-codex');
    vi.useFakeTimers();
    github.execute.mockImplementation((_file, _args, options, callback) => {
      options.signal.addEventListener(
        'abort',
        () =>
          callback(
            Object.assign(Error('transport aborted'), { code: 'ABORT_ERR', killed: true }),
            'PRIVATE PARTIAL LOG',
            '',
          ),
        { once: true },
      );
      return {};
    });
    const input = f.input(123);
    const pending = f.tools('worker').execute(input, f.signal, f.call);
    await vi.waitFor(() => expect(github.execute).toHaveBeenCalledOnce());
    if (reason === 'revocation') f.store.revoke(f.grant.id, f.auth.id, 'owner');
    else await vi.advanceTimersByTimeAsync(f.grant.expiresAt - Date.now());
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('PRIVATE PARTIAL LOG');
    expect(JSON.parse(result.content)).toMatchObject({
      requestId: input.requestId,
      effectStatus: 'unknown',
    });
    const status = await f
      .tools('worker')
      .execute({ operation: 'status', grantId: f.grant.id, requestId: input.requestId }, f.signal);
    expect(JSON.parse(status.content).run.state).toBe('uncertain');
    expect(
      JSON.parse((await f.tools('worker').execute({ operation: 'status' }, f.signal)).content)
        .executionRoute,
    ).toBeNull();
    expect((await f.tools('worker').execute(input, f.signal, f.call)).isError).toBe(true);
    expect(github.execute).toHaveBeenCalledOnce();
  },
);

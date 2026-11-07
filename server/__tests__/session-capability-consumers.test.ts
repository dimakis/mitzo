import { afterEach, expect, it, vi } from 'vitest';
import { capabilityFixture as fixture } from './fixtures/session-capabilities.js';
import { authorizeGitHubRead } from '../github-read-approval.js';
import { createCodexNativeApprovalHandler } from '../codex-native-approvals.js';
import { createWebAccessTool } from '../web-access-tool.js';
import { fetchPublicPage } from '../public-web-fetch.js';
import { createUrlAccessTool } from '../url-access-tool.js';
import { fetchApprovedUrl, type ApprovedUrlTarget } from '../approved-url-fetch.js';
import { captureNativeDevelopmentGrant } from '../native-development-grant.js';
import { NativeApprovalRequestSchema } from '../codex-native-permission-protocol.js';
vi.mock('../public-web-fetch.js', () => ({ fetchPublicPage: vi.fn().mockResolvedValue('page') }));
const publicTarget = (): ApprovedUrlTarget => ({
  url: 'https://example.com/',
  origin: 'https://example.com',
  addresses: [{ address: '93.184.216.34', family: 4 }],
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it('uses repository read grants and fences delivery after revocation', async () => {
  const f = fixture();
  const grant = f.grants.create('operator', {
    sessionIds: ['one'],
    capability: { kind: 'github-read', repository: 'example/repo' },
    durationMinutes: 60,
  });
  const decide = vi.fn();
  const current = await authorizeGitHubRead(
    { endpoint: '/repos/example/repo/pulls', access: 'authenticated' },
    {
      clientId: 'one',
      registry: f.registry,
      session: f.session,
      runtimeId: 'runtime',
      signal: new AbortController().signal,
      toolUseID: 'call',
      decide,
    },
  );
  expect(decide).not.toHaveBeenCalled();
  expect(current).not.toThrow();
  f.grants.revoke('operator', 'one', grant.id);
  expect(current).toThrow();
});
it('grants only the requested native overlay and retains the final response fence', async () => {
  const f = fixture();
  const grant = f.grants.create('operator', {
    sessionIds: ['one'],
    capability: { kind: 'development' },
    durationMinutes: 60,
  });
  let fence = () => {};
  const handler = createCodexNativeApprovalHandler({
    clientId: 'one',
    registry: f.registry,
    runtimeId: 'runtime',
    environmentId: 'local',
    deniedRoots: ['/credentials'],
    writeProtectedRoots: ['/authority'],
  });
  const result = await handler(
    'item/commandExecution/requestApproval',
    {
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'item',
      startedAtMs: Date.now(),
      environmentId: 'local',
      cwd: f.session.cwd,
      reason: null,
      kind: 'command',
      command: 'npm test',
      additionalPermissions: { network: { enabled: true }, fileSystem: null },
    },
    new AbortController().signal,
    {
      requestId: 'rpc',
      threadId: 'thread',
      turnId: 'turn',
      assertCurrentSync() {},
      registerResponseFence(f) {
        fence = f;
      },
    },
  );
  expect(result).toEqual({ decision: 'accept' });
  expect(f.sent).toEqual([]);
  expect(fence).not.toThrow();
  f.grants.revoke('operator', 'one', grant.id);
  expect(fence).toThrow();
});
it('development consent covers bounded network overlays, never opaque commands or filesystem expansion', () => {
  const f = fixture();
  f.grants.create('operator', {
    sessionIds: ['one'],
    capability: { kind: 'development' },
    durationMinutes: 60,
  });
  const request = (cwd: string, additionalPermissions: unknown) =>
    NativeApprovalRequestSchema.parse({
      method: 'item/commandExecution/requestApproval',
      id: 'rpc',
      params: {
        kind: 'command',
        threadId: 't',
        turnId: 'turn',
        itemId: 'i',
        startedAtMs: Date.now(),
        environmentId: 'local',
        cwd,
        command: 'npm test',
        additionalPermissions,
      },
    });
  expect(
    captureNativeDevelopmentGrant(
      f.session,
      request(f.session.cwd!, { network: { enabled: true }, fileSystem: null }),
    ),
  ).toBeTypeOf('function');
  expect(
    captureNativeDevelopmentGrant(
      f.session,
      request('/outside', { network: { enabled: true }, fileSystem: null }),
    ),
  ).toBeUndefined();
  expect(captureNativeDevelopmentGrant(f.session, request(f.session.cwd!, null))).toBeUndefined();
  expect(
    captureNativeDevelopmentGrant(
      f.session,
      request(f.session.cwd!, {
        network: { enabled: true },
        fileSystem: { read: null, write: ['/credentials'] },
      }),
    ),
  ).toBeUndefined();
});
it.each(['expiry', 'account', 'workspace'] as const)(
  'withholds GitHub delivery after %s invalidates the shared grant',
  async (change) => {
    const f = fixture();
    f.grants.create('operator', {
      sessionIds: ['one'],
      capability: { kind: 'github-read', repository: 'example/repo' },
      durationMinutes: 1,
    });
    const current = await authorizeGitHubRead(
      { endpoint: '/repos/example/repo/pulls' },
      {
        clientId: 'one',
        registry: f.registry,
        session: f.session,
        signal: new AbortController().signal,
        toolUseID: 'call',
        decide: vi.fn(),
      },
    );
    if (change === 'account') f.session.accountBinding!.accountId = 'other';
    if (change === 'workspace') f.session.cwd = f.root;
    if (change === 'expiry') {
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 60_001);
    }
    expect(current).toThrow();
  },
);
it('retained URL reads recheck preset revocation before both fetch and delivery', async () => {
  const f = fixture();
  const grant = f.grants.create('operator', {
    sessionIds: ['one'],
    capability: { kind: 'public-web' },
    durationMinutes: 60,
  });
  const fetch = vi.fn(async () => {
    await f.grants.revoke('operator', 'one', grant.id);
    return 'stale page';
  });
  const tool = createUrlAccessTool('one', f.registry, {
    now: Date.now,
    resolve: async () => publicTarget(),
    fetch,
  });
  const signal = new AbortController().signal;
  expect(
    (
      await tool.request(
        { operation: 'request_access', url: 'https://example.com/page', reason: 'Research' },
        signal,
      )
    ).isError,
  ).toBe(false);
  expect(f.sent).toEqual([]);
  const result = await tool.fetch('https://example.com/page', signal);
  expect(result?.isError).toBe(true);
  expect(result?.content).not.toContain('stale page');
  await tool.fetch('https://example.com/page', signal);
  expect(fetch).toHaveBeenCalledOnce();
});
it.each(['expiry', 'revocation'] as const)(
  'uses replacement public-web consent after %s retires a retained URL receipt',
  async (change) => {
    vi.useFakeTimers();
    const f = fixture();
    const grant = f.grants.create('operator', {
      sessionIds: ['one'],
      capability: { kind: 'public-web' },
      durationMinutes: 1,
    });
    const retainedFetch = vi.fn(async () => 'retained page');
    const retained = createUrlAccessTool('one', f.registry, {
      now: Date.now,
      resolve: async () => publicTarget(),
      fetch: retainedFetch,
    });
    const signal = new AbortController().signal;
    await retained.request(
      { operation: 'request_access', url: 'https://example.com', reason: 'Read' },
      signal,
    );
    if (change === 'expiry') vi.setSystemTime(Date.now() + 60_001);
    else f.grants.revoke('operator', 'one', grant.id);
    f.grants.create('operator', {
      sessionIds: ['one'],
      capability: { kind: 'public-web' },
      durationMinutes: 60,
    });
    const tool = createWebAccessTool('one', f.registry, vi.fn());
    expect(
      await tool({ operation: 'fetch', url: 'https://example.com', reason: 'Read' }, signal),
    ).toMatchObject({ isError: false });
    expect(fetchPublicPage).toHaveBeenCalledOnce();
    expect(retainedFetch).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
  },
);
it('keeps capability-backed URL access for the reusable grant duration rather than fifteen minutes', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.grants.create('operator', {
    sessionIds: ['one'],
    capability: { kind: 'public-web' },
    durationMinutes: 60,
  });
  const fetch = vi.fn(async () => 'page');
  const tool = createUrlAccessTool('one', f.registry, {
    now: Date.now,
    resolve: async () => publicTarget(),
    fetch,
  });
  const signal = new AbortController().signal;
  const approval = await tool.request(
    { operation: 'request_access', url: 'https://example.com', reason: 'Read' },
    signal,
  );
  vi.setSystemTime(Date.now() + 16 * 60_000);
  expect(await tool.fetch('https://example.com', signal)).toMatchObject({ isError: false });
  expect(approval.content).toContain('reusable');
  expect(fetch).toHaveBeenCalledOnce();
  expect(f.sent).toEqual([]);
});
it('rejects an in-flight retained read even when a replacement grant lets a new read succeed', async () => {
  const f = fixture();
  const grant = f.grants.create('operator', {
    sessionIds: ['one'],
    capability: { kind: 'public-web' },
    durationMinutes: 60,
  });
  let finish!: (page: string) => void;
  const fetch = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
  const retained = createUrlAccessTool('one', f.registry, {
    now: Date.now,
    resolve: async () => publicTarget(),
    fetch,
  });
  const signal = new AbortController().signal;
  await retained.request(
    { operation: 'request_access', url: 'https://example.com', reason: 'Read' },
    signal,
  );
  const pending = retained.fetch('https://example.com', signal);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  f.grants.revoke('operator', 'one', grant.id);
  f.grants.create('operator', {
    sessionIds: ['one'],
    capability: { kind: 'public-web' },
    durationMinutes: 60,
  });
  const tool = createWebAccessTool('one', f.registry, vi.fn());
  const next = await tool(
    { operation: 'fetch', url: 'https://example.com', reason: 'Read' },
    signal,
  );
  finish('stale page');
  expect(await pending).toMatchObject({ isError: true });
  expect(next.isError).toBe(false);
  expect(next.content).not.toContain('stale page');
  expect(f.sent).toEqual([]);
});
it('checks public-web consent after DNS and immediately before the socket send', async () => {
  const f = fixture();
  const grant = f.grants.create('operator', {
    sessionIds: ['one'],
    capability: { kind: 'public-web' },
    durationMinutes: 60,
  });
  const send = vi.fn(async () => ({
    status: 200,
    headers: { 'content-type': 'text/plain' },
    body: 'page',
  }));
  vi.mocked(fetchPublicPage).mockImplementationOnce(async (url, signal, _deps, current, view) => {
    const actual =
      await vi.importActual<typeof import('../public-web-fetch.js')>('../public-web-fetch.js');
    return actual.fetchPublicPage(
      url,
      signal,
      {
        resolve: async () => {
          await f.grants.revoke('operator', 'one', grant.id);
          return [{ address: '93.184.216.34', family: 4 }];
        },
        send,
      },
      current,
      view,
    );
  });
  const result = await createWebAccessTool(
    'one',
    f.registry,
    vi.fn(),
  )(
    { operation: 'fetch', url: 'https://example.com', reason: 'Read' },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(send).not.toHaveBeenCalled();
});
it('checks retained URL consent after DNS and immediately before the socket read', async () => {
  const f = fixture();
  const grant = f.grants.create('operator', {
    sessionIds: ['one'],
    capability: { kind: 'public-web' },
    durationMinutes: 60,
  });
  const target = publicTarget();
  const read = vi.fn(async () => ({
    status: 200,
    type: 'text/plain',
    body: 'page',
    location: undefined,
    link: undefined,
  }));
  const tool = createUrlAccessTool('one', f.registry, {
    now: Date.now,
    resolve: async () => target,
    fetch: (url, approved, signal, current, view) =>
      fetchApprovedUrl(
        url,
        approved,
        signal,
        {
          resolve: async () => {
            await f.grants.revoke('operator', 'one', grant.id);
            return target;
          },
          read,
        },
        current,
        view,
      ),
  });
  const signal = new AbortController().signal;
  await tool.request(
    { operation: 'request_access', url: 'https://example.com', reason: 'Read' },
    signal,
  );
  const result = await tool.fetch('https://example.com', signal);
  expect(result?.isError).toBe(true);
  expect(read).not.toHaveBeenCalled();
});
it('keeps public-web consent fenced until native RPC delivery, including retained URL reads', async () => {
  for (const retained of [false, true]) {
    const f = fixture();
    const grant = f.grants.create('operator', {
      sessionIds: ['one'],
      capability: { kind: 'public-web' },
      durationMinutes: 60,
    });
    const fences: Array<() => void> = [];
    const signal = new AbortController().signal;
    if (retained) {
      const tool = createUrlAccessTool(
        'one',
        f.registry,
        {
          now: Date.now,
          resolve: async () => publicTarget(),
          fetch: async () => 'page',
        },
        undefined,
        (fence) => fences.push(fence),
      );
      await tool.request(
        { operation: 'request_access', url: 'https://example.com', reason: 'Read' },
        signal,
      );
      expect((await tool.fetch('https://example.com', signal))?.isError).toBe(false);
    } else {
      const tool = createWebAccessTool('one', f.registry, vi.fn(), undefined, (fence) =>
        fences.push(fence),
      );
      expect(
        (await tool({ operation: 'fetch', url: 'https://example.com', reason: 'Read' }, signal))
          .isError,
      ).toBe(false);
    }
    expect(fences.length).toBeGreaterThan(0);
    fences.forEach((fence) => expect(fence).not.toThrow());
    await f.grants.revoke('operator', 'one', grant.id);
    fences.forEach((fence) => expect(fence).toThrow());
  }
});
it('reads public sites through the preset and withholds a result after revocation', async () => {
  const f = fixture();
  const grant = f.grants.create('operator', {
    sessionIds: ['one'],
    capability: { kind: 'public-web' },
    durationMinutes: 60,
  });
  const execute = createWebAccessTool('one', f.registry, vi.fn());
  vi.mocked(fetchPublicPage).mockImplementationOnce(async () => {
    f.grants.revoke('operator', 'one', grant.id);
    return 'stale content';
  });
  const result = await execute(
    { operation: 'fetch', url: 'https://example.com/page', reason: 'Research' },
    new AbortController().signal,
  );
  expect(f.sent).toEqual([]);
  expect(result.isError).toBe(true);
  expect(result.content).not.toContain('stale content');
});

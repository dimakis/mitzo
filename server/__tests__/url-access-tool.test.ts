import { beforeEach, expect, it, vi } from 'vitest';
import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
const approve = vi.hoisted(() => vi.fn());
vi.mock('@mitzo/harness', async (original) => ({
  ...(await original<typeof import('@mitzo/harness')>()),
  buildPermissionHandler: () => approve,
}));
import { WebAccessError } from '../request-web-access.js';
import { ApprovedUrlRedirect } from '../approved-url-fetch.js';
import { createUrlAccessTool, clearUrlAccessGrants } from '../url-access-tool.js';
beforeEach(() => {
  approve.mockReset();
});
function fixture(assertRuntimeCurrent?: () => Promise<void>) {
  const session = {
    sessionId: 'conversation',
    mode: 'auto',
    activeSkillPolicy: null,
    accountBinding: {
      accountId: 'a',
      provider: 'google-vertex',
      model: 'test',
      profileRevision: '1',
    },
  } as unknown as ManagedSession;
  const registry = {
    get: () => session,
    findBySessionId: () => ({ clientId: 'owner', session }),
  } as unknown as SessionRegistry;
  const resolve = vi.fn(async (url: string) => ({
    url: new URL(url).href,
    origin: new URL(url).origin,
    addresses: [{ address: '127.0.0.1', family: 4 }],
  }));
  const fetch = vi.fn().mockResolvedValue('page');
  let now = 1000;
  const tool = createUrlAccessTool(
    'conversation',
    registry,
    { resolve, fetch, now: () => now },
    assertRuntimeCurrent,
  );
  return {
    session,
    resolve,
    fetch,
    tool,
    expire: () => {
      now += 16 * 60 * 1000;
    },
  };
}
it('shows the exact private origin and resolved addresses before granting session reads', async () => {
  const f = fixture();
  approve.mockImplementation(async (_name, input) => ({ behavior: 'allow', updatedInput: input }));
  expect(
    await f.tool.request(
      {
        operation: 'request_access',
        url: 'http://localhost:8123/page',
        reason: 'Read my HA instance',
      },
      new AbortController().signal,
    ),
  ).toMatchObject({ isError: false });
  expect(approve.mock.calls[0][1]).toMatchObject({
    origin: 'http://localhost:8123',
    resolvedAddresses: ['127.0.0.1'],
  });
  expect(approve.mock.calls[0][2]).toMatchObject({ forcePrompt: true, allowSessionGrant: false });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(
    await f.tool.fetch('http://localhost:8123/other', new AbortController().signal),
  ).toMatchObject({ isError: false });
  expect(approve).toHaveBeenCalledOnce();
  expect(
    await f.tool.fetch('http://localhost:9999/', new AbortController().signal),
  ).toBeUndefined();
});
it('does not fetch after denial or an account change during approval', async () => {
  const f = fixture();
  approve.mockImplementation(async (_name, input) => {
    f.session.accountBinding!.accountId = 'other';
    return { behavior: 'allow', updatedInput: input };
  });
  expect(
    await f.tool.request(
      { operation: 'request_access', url: 'https://example.com/', reason: 'why' },
      new AbortController().signal,
    ),
  ).toMatchObject({ isError: true });
  expect(await f.tool.fetch('https://example.com/', new AbortController().signal)).toBeUndefined();
  expect(f.fetch).not.toHaveBeenCalled();
});
it('expires and revokes exact-origin grants', async () => {
  const f = fixture();
  approve.mockImplementation(async (_name, input) => ({ behavior: 'allow', updatedInput: input }));
  const input = { operation: 'request_access', url: 'https://example.com/', reason: 'why' };
  await f.tool.request(input, new AbortController().signal);
  f.expire();
  expect(await f.tool.fetch(input.url, new AbortController().signal)).toMatchObject({
    isError: true,
    content: expect.stringContaining('request_access'),
  });
  await f.tool.request(input, new AbortController().signal);
  expect(
    await f.tool.request({ ...input, operation: 'revoke_access' }, new AbortController().signal),
  ).toMatchObject({ isError: false });
  expect(await f.tool.fetch(input.url, new AbortController().signal)).toBeUndefined();
});
it('never accepts embedded URL credentials or non-HTTP schemes', async () => {
  const f = fixture();
  for (const url of ['file:///etc/passwd', 'https://user:secret@example.com/'])
    expect(
      await f.tool.request(
        { operation: 'request_access', url, reason: 'why' },
        new AbortController().signal,
      ),
    ).toMatchObject({ isError: true });
  expect(approve).not.toHaveBeenCalled();
  expect(f.resolve).not.toHaveBeenCalled();
});

it('discards an approval that arrives after access was revoked', async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  approve.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const input = { operation: 'request_access', url: 'https://example.com/', reason: 'why' };
  const pending = f.tool.request(input, new AbortController().signal);
  await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
  await f.tool.request({ ...input, operation: 'revoke_access' }, new AbortController().signal);
  finish({ behavior: 'allow', updatedInput: approve.mock.calls[0][1] });
  expect(await pending).toMatchObject({ isError: true });
  expect(await f.tool.fetch(input.url, new AbortController().signal)).toBeUndefined();
});
it('discards a page result when its grant is revoked while the read is pending', async () => {
  const f = fixture();
  approve.mockImplementation(async (_name, input) => ({ behavior: 'allow', updatedInput: input }));
  const input = { operation: 'request_access', url: 'https://example.com/', reason: 'why' };
  await f.tool.request(input, new AbortController().signal);
  let finish!: (value: string) => void;
  f.fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.tool.fetch(input.url, new AbortController().signal);
  await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
  await f.tool.request({ ...input, operation: 'revoke_access' }, new AbortController().signal);
  finish('page');
  expect(await pending).toMatchObject({ isError: true });
});

it('cancels a URL request while name resolution is pending', async () => {
  const f = fixture();
  f.resolve.mockImplementation(() => new Promise(() => {}));
  const abort = new AbortController();
  const pending = f.tool.request(
    { operation: 'request_access', url: 'https://example.com/', reason: 'why' },
    abort.signal,
  );
  abort.abort();
  expect(
    await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve('not cancelled'), 100)),
    ]),
  ).toMatchObject({ isError: true });
  expect(approve).not.toHaveBeenCalled();
});

it.each(['account'])(
  'never revives URL approval after an observed %s switch back',
  async (selection) => {
    const f = fixture();
    approve.mockImplementation(async (_name, input) => ({
      behavior: 'allow',
      updatedInput: input,
    }));
    const input = { operation: 'request_access', url: 'https://example.com/', reason: 'why' };
    await f.tool.request(input, new AbortController().signal);
    const originalModel = f.session.model;
    if (selection === 'account') f.session.accountBinding!.accountId = 'b';
    else f.session.model = 'other';
    expect(await f.tool.fetch(input.url, new AbortController().signal)).toMatchObject({
      isError: true,
    });
    if (selection === 'account') f.session.accountBinding!.accountId = 'a';
    else f.session.model = originalModel;
    expect(await f.tool.fetch(input.url, new AbortController().signal)).toBeUndefined();
    expect(f.fetch).not.toHaveBeenCalled();
  },
);

it('invalidates all URL approvals after explicit revocation without a fetch', async () => {
  const f = fixture();
  approve.mockImplementation(async (_name, input) => ({ behavior: 'allow', updatedInput: input }));
  const input = { operation: 'request_access', url: 'https://example.com/', reason: 'why' };
  await f.tool.request(input, new AbortController().signal);
  clearUrlAccessGrants(f.session);
  expect(await f.tool.fetch(input.url, new AbortController().signal)).toBeUndefined();
  expect(f.fetch).not.toHaveBeenCalled();
});

it.each(['allow', 'deny'] as const)(
  'continues a granted-origin redirect only after explicit destination %s',
  async (behavior) => {
    const f = fixture();
    const source = {
      operation: 'request_access',
      url: 'http://localhost:8123/start',
      reason: 'Read local page',
    };
    approve.mockImplementation(async (_name, input) => ({
      behavior: 'allow',
      updatedInput: input,
    }));
    await f.tool.request(source, new AbortController().signal);
    approve.mockImplementation(async (_name, input) => ({ behavior, updatedInput: input }));
    f.fetch
      .mockRejectedValueOnce(new ApprovedUrlRedirect('http://localhost:9999/destination?q=one'))
      .mockResolvedValue('destination page');
    const result = await f.tool.fetch(source.url, new AbortController().signal);
    expect(approve).toHaveBeenCalledTimes(2);
    expect(approve.mock.calls[1][1]).toMatchObject({
      url: 'http://localhost:9999/destination?q=one',
      origin: 'http://localhost:9999',
      resolvedAddresses: ['127.0.0.1'],
    });
    expect(approve.mock.calls[1][2].title).toBe('Approve redirected destination?');
    expect(f.fetch).toHaveBeenCalledTimes(behavior === 'allow' ? 2 : 1);
    expect(result?.isError).toBe(behavior === 'deny');
    if (behavior === 'allow') expect(f.fetch.mock.calls[1][1].origin).toBe('http://localhost:9999');
  },
);
it.each(['revoked', 'expired', 'account', 'cancelled'])(
  'stops a redirected read when the source is %s during approval',
  async (change) => {
    const f = fixture();
    const abort = new AbortController();
    const input = { operation: 'request_access', url: 'https://example.com/', reason: 'why' };
    approve.mockImplementation(async (_name, input) => ({
      behavior: 'allow',
      updatedInput: input,
    }));
    await f.tool.request(input, abort.signal);
    f.fetch.mockRejectedValueOnce(new ApprovedUrlRedirect('https://other.example/'));
    approve.mockImplementation(async (_name, payload) => {
      if (change === 'revoked')
        await f.tool.request({ ...input, operation: 'revoke_access' }, abort.signal);
      if (change === 'expired') f.expire();
      if (change === 'account') f.session.accountBinding!.accountId = 'other';
      if (change === 'cancelled') abort.abort();
      return { behavior: 'allow', updatedInput: payload };
    });
    expect(await f.tool.fetch(input.url, abort.signal)).toMatchObject({ isError: true });
    expect(f.fetch).toHaveBeenCalledOnce();
  },
);

it('retires a source grant when a changed account is observed after a pending read', async () => {
  const f = fixture();
  approve.mockImplementation(async (_name, input) => ({ behavior: 'allow', updatedInput: input }));
  const input = { operation: 'request_access', url: 'https://example.com/', reason: 'why' };
  await f.tool.request(input, new AbortController().signal);
  f.fetch.mockImplementation(async () => {
    f.session.accountBinding!.accountId = 'other';
    return 'page';
  });
  expect(await f.tool.fetch(input.url, new AbortController().signal)).toMatchObject({
    isError: true,
  });
  f.session.accountBinding!.accountId = 'a';
  expect(await f.tool.fetch(input.url, new AbortController().signal)).toBeUndefined();
});

it('continues an A to B to A redirect after explicit reapproval of A', async () => {
  const f = fixture();
  approve.mockImplementation(async (_name, input) => ({ behavior: 'allow', updatedInput: input }));
  const input = { operation: 'request_access', url: 'https://example.com/start', reason: 'why' };
  await f.tool.request(input, new AbortController().signal);
  f.fetch
    .mockRejectedValueOnce(new ApprovedUrlRedirect('https://other.example/'))
    .mockRejectedValueOnce(new ApprovedUrlRedirect('https://example.com/final'))
    .mockResolvedValue('final page');
  expect(await f.tool.fetch(input.url, new AbortController().signal)).toEqual({
    isError: false,
    content: 'final page',
  });
  expect(approve).toHaveBeenCalledTimes(3);
  expect(f.fetch).toHaveBeenCalledTimes(3);
});

it('returns only fixed granted read errors to the UI and agent', async () => {
  const f = fixture();
  approve.mockImplementation(async (_name, input) => ({ behavior: 'allow', updatedInput: input }));
  const input = { operation: 'request_access', url: 'https://example.com/', reason: 'why' };
  await f.tool.request(input, new AbortController().signal);
  f.fetch.mockRejectedValueOnce(
    new WebAccessError('The website refused the approved read (HTTP 403).'),
  );
  expect(await f.tool.fetch(input.url, new AbortController().signal)).toEqual({
    content: 'The website refused the approved read (HTTP 403).',
    isError: true,
  });
  f.fetch.mockRejectedValueOnce(new Error('secret credential'));
  const result = await f.tool.fetch(input.url, new AbortController().signal);
  expect(result?.content).not.toContain('secret');
});

it('keeps a selected session origin grant past fifteen minutes and revokes it explicitly', async () => {
  const f = fixture();
  approve.mockImplementation(async (_name, input) => ({
    behavior: 'allow',
    updatedInput: input,
    decisionClassification: 'user_permanent',
  }));
  const input = {
    operation: 'request_access',
    url: 'https://example.com/page',
    reason: 'Read evidence',
  };
  const signal = new AbortController().signal;
  expect(await f.tool.request(input, signal)).toMatchObject({ isError: false });
  f.expire();
  expect(await f.tool.fetch('https://example.com/other', signal)).toMatchObject({ isError: false });
  expect(
    await f.tool.request({ ...input, url: 'https://example.com/third' }, signal),
  ).toMatchObject({ isError: false });
  expect(approve).toHaveBeenCalledOnce();
  expect(approve.mock.calls[0][2]).toMatchObject({
    approvalScope: 'session',
    rememberSessionGrant: false,
    sessionGrantDescription: expect.stringContaining('https://example.com'),
  });
  await f.tool.request({ ...input, operation: 'revoke_access' }, signal);
  expect(await f.tool.fetch(input.url, signal)).toBeUndefined();
  await f.tool.request(input, signal);
  expect(approve).toHaveBeenCalledTimes(2);
});

it('keeps nonbillable origin consent across model selection and transport recreation', async () => {
  const f = fixture();
  approve.mockImplementation(async (_name, input) => ({
    behavior: 'allow',
    updatedInput: input,
    decisionClassification: 'user_permanent',
  }));
  const signal = new AbortController().signal;
  const input = { operation: 'request_access', url: 'https://example.com/page', reason: 'Read' };
  await f.tool.request(input, signal);
  f.session.model = 'another-model';
  f.session.accountBinding!.model = 'another-model';
  expect(await f.tool.fetch(input.url, signal)).toMatchObject({ isError: false });
  await f.tool.request(input, signal);
  expect(approve).toHaveBeenCalledOnce();
});

it('shares matching simultaneous destination approvals while keeping waiter cancellation independent', async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  approve.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const input = { operation: 'request_access', url: 'https://example.com/a', reason: 'why' };
  const firstSignal = new AbortController();
  const first = f.tool.request(input, firstSignal.signal);
  const second = f.tool.request(
    { ...input, url: 'https://example.com/b' },
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
  firstSignal.abort();
  expect(await first).toMatchObject({ isError: true });
  expect(approve.mock.calls[0][2].signal.aborted).toBe(false);
  finish({
    behavior: 'allow',
    updatedInput: approve.mock.calls[0][1],
    decisionClassification: 'user_permanent',
  });
  expect(await second).toMatchObject({ isError: false });
  expect(approve).toHaveBeenCalledOnce();
});

it('does not share changed resolved address scopes', async () => {
  const f = fixture();
  f.resolve.mockResolvedValueOnce({
    url: 'https://example.com/a',
    origin: 'https://example.com',
    addresses: [{ address: '127.0.0.1', family: 4 }],
  });
  f.resolve.mockResolvedValueOnce({
    url: 'https://example.com/b',
    origin: 'https://example.com',
    addresses: [{ address: '127.0.0.2', family: 4 }],
  });
  approve.mockImplementation(async (_name, input) => ({ behavior: 'allow', updatedInput: input }));
  await Promise.all(
    ['/a', '/b'].map((path) =>
      f.tool.request(
        { operation: 'request_access', url: 'https://example.com' + path, reason: 'why' },
        new AbortController().signal,
      ),
    ),
  );
  expect(approve).toHaveBeenCalledTimes(2);
});

it('cannot resurrect a revoked shared approval and checks each waiter policy', async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  approve.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const input = { operation: 'request_access', url: 'https://example.com/a', reason: 'why' };
  const pending = [
    f.tool.request(input, new AbortController().signal),
    f.tool.request({ ...input, url: 'https://example.com/b' }, new AbortController().signal),
  ];
  await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
  await f.tool.request({ ...input, operation: 'revoke_access' }, new AbortController().signal);
  finish({
    behavior: 'allow',
    updatedInput: approve.mock.calls[0][1],
    decisionClassification: 'user_permanent',
  });
  for (const result of await Promise.all(pending)) expect(result).toMatchObject({ isError: true });
  expect(await f.tool.fetch(input.url, new AbortController().signal)).toBeUndefined();
});

it('rechecks current eligibility for all callers after shared consent', async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  approve.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const input = { operation: 'request_access', url: 'https://example.com/a', reason: 'why' };
  const pending = [
    f.tool.request(input, new AbortController().signal),
    f.tool.request(input, new AbortController().signal),
  ];
  await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
  f.session.mode = 'ask';
  finish({
    behavior: 'allow',
    updatedInput: approve.mock.calls[0][1],
    decisionClassification: 'user_permanent',
  });
  for (const result of await Promise.all(pending)) expect(result).toMatchObject({ isError: true });
  expect(await f.tool.fetch(input.url, new AbortController().signal)).toBeUndefined();
});

it('does not recreate a first pending origin after session access is cleared and account switches back', async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  approve.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const input = { operation: 'request_access', url: 'https://example.com/a', reason: 'why' };
  const result = f.tool.request(input, new AbortController().signal);
  await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
  clearUrlAccessGrants(f.session);
  f.session.accountBinding!.accountId = 'other';
  f.session.accountBinding!.accountId = 'a';
  finish({
    behavior: 'allow',
    updatedInput: approve.mock.calls[0][1],
    decisionClassification: 'user_permanent',
  });
  expect(await result).toMatchObject({ isError: true });
  expect(await f.tool.fetch(input.url, new AbortController().signal)).toBeUndefined();
});

it('withholds a granted page when owned runtime authority changes during its read', async () => {
  let current = true;
  const f = fixture(async () => {
    if (!current) throw Error('Original owned authority withdrawn');
  });
  approve.mockImplementation(async (_name, input) => ({ behavior: 'allow', updatedInput: input }));
  const signal = new AbortController().signal;
  expect(
    await f.tool.request(
      { operation: 'request_access', url: 'https://example.com', reason: 'Read' },
      signal,
    ),
  ).toMatchObject({ isError: false });
  f.fetch.mockImplementationOnce(async () => {
    current = false;
    return 'stale owned-query page';
  });
  const result = await f.tool.fetch('https://example.com', signal);
  expect(result).toMatchObject({ isError: true });
  expect(result?.content).not.toContain('stale owned-query page');
});

it('keeps the full-content view inside an existing exact-origin grant', async () => {
  const f = fixture();
  approve.mockImplementation(async (_name, input) => ({ behavior: 'allow', updatedInput: input }));
  const signal = new AbortController().signal;
  const url = 'https://api.github.com/repos/example/project/issues';
  await f.tool.request({ operation: 'request_access', url, reason: 'Read evidence' }, signal);
  await expect(f.tool.fetch(url, signal, 'full')).resolves.toMatchObject({ isError: false });
  expect(f.fetch.mock.calls.at(-1)?.[4]).toBe('full');
  const count = f.fetch.mock.calls.length;
  await expect(f.tool.fetch('https://other.example/', signal, 'full')).resolves.toBeUndefined();
  expect(f.fetch).toHaveBeenCalledTimes(count);
});

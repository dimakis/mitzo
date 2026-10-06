import { beforeEach, expect, it, vi } from 'vitest';
import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
const approve = vi.hoisted(() => vi.fn());
vi.mock('@mitzo/harness', async (original) => ({
  ...(await original<typeof import('@mitzo/harness')>()),
  buildPermissionHandler: () => approve,
}));
import { createUrlAccessTool } from '../url-access-tool.js';
beforeEach(() => approve.mockReset());
function fixture() {
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
  const tool = createUrlAccessTool('conversation', registry, { resolve, fetch, now: () => now });
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
  expect(await f.tool.fetch(input.url, new AbortController().signal)).toBeUndefined();
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

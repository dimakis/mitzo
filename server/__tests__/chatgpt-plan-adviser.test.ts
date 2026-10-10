import { afterEach, expect, it, vi } from 'vitest';
import { ChatGptPlanAdviserAccounts, type PlanAdviserState } from '../chatgpt-plan-adviser.js';

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  let state: PlanAdviserState = { hostId: 'urn:uuid:test-host', accounts: [] };
  let now = Date.now();
  let owned = true;
  const save = vi.fn((next: PlanAdviserState) => {
    state = structuredClone(next);
  });
  const verify = vi.fn(async () => ({ sub: 'signed-user', email: 'user@example.test' }));
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/oauth/token'))
      return new Response(
        JSON.stringify({
          access_token: 'synthetic-plan-access',
          refresh_token: 'synthetic-refresh',
          id_token: 'synthetic-id',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        }),
      );
    if (String(url).endsWith('/models'))
      return new Response(
        JSON.stringify({
          models: [
            {
              slug: 'gpt-6-luna',
              display_name: 'Luna',
              visibility: 'list',
              supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
              default_reasoning_level: 'low',
            },
            { slug: 'hidden-test', display_name: 'Hidden', visibility: 'hide' },
          ],
        }),
      );
    throw Error('Unexpected network request ' + String(url) + String(init?.method));
  });
  const service = new ChatGptPlanAdviserAccounts({
    store: {
      load: () => structuredClone(state),
      save,
      assertCurrent: () => {
        if (!owned) throw Error('private ownership detail');
      },
    },
    fetch: fetcher,
    verifyIdToken: verify,
    now: () => now,
  });
  const begin = (id?: string) =>
    service.begin('operator', 'http://127.0.0.1:1455/auth/callback', 'Personal', id);
  const callback = (url: string) => {
    const auth = new URL(url);
    return new URL(
      'http://127.0.0.1:1455/auth/callback?code=synthetic-code&client_id=oaiapp_test&state=' +
        auth.searchParams.get('state'),
    );
  };
  return {
    service,
    fetcher,
    verify,
    save,
    begin,
    callback,
    state: () => state,
    loseOwner: () => {
      owned = false;
    },
    time: () => now,
    advance: () => {
      now += 3600000;
    },
  };
}
it('registers a separate account with PKCE, signed identity and explicit plan scopes', async () => {
  const f = fixture(),
    url = f.begin(),
    auth = new URL(url);
  expect(auth.origin + auth.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
  expect(auth.searchParams.get('client_id')).toBe('dynamic_agent_client');
  expect(auth.searchParams.get('agent_name_hint')).toBe('Mitzo');
  expect(auth.searchParams.get('resource')).toBe('https://api.openai.com/v1');
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
  const account = await f.service.complete(
    'operator',
    f.callback(url),
    new AbortController().signal,
  );
  expect(f.verify).toHaveBeenCalledWith(
    'synthetic-id',
    'oaiapp_test',
    auth.searchParams.get('nonce'),
    expect.any(AbortSignal),
  );
  expect(f.service.catalog()).toEqual([
    {
      id: account.id,
      label: 'Personal',
      provider: 'chatgpt-plan',
      models: [
        {
          id: 'gpt-6-luna',
          label: 'Luna',
          reasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'low',
        },
      ],
    },
  ]);
  expect(JSON.stringify(f.service.list())).not.toContain('synthetic');
  const form = new URLSearchParams(f.fetcher.mock.calls[0][1]!.body as string);
  expect(form.get('client_id')).toBe('oaiapp_test');
  expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(form.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
});
it('rejects changed state, another operator, missing permission and replay before exposing an account', async () => {
  const f = fixture(),
    url = f.begin(),
    callback = f.callback(url);
  await expect(
    f.service.complete('other', callback, new AbortController().signal),
  ).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
  callback.searchParams.set('state', 'wrong');
  await expect(
    f.service.complete('operator', callback, new AbortController().signal),
  ).rejects.toThrow();
  const valid = f.callback(url);
  f.fetcher.mockImplementationOnce(
    async () =>
      new Response(
        JSON.stringify({
          access_token: 'secret',
          refresh_token: 'secret',
          id_token: 'secret',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid',
        }),
      ),
  );
  await expect(
    f.service.complete('operator', valid, new AbortController().signal),
  ).rejects.toThrow();
  expect(f.service.catalog()).toEqual([]);
  await expect(
    f.service.complete('operator', valid, new AbortController().signal),
  ).rejects.toThrow();
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it('keeps reauthorization bound to the issued client and verified subject', async () => {
  const f = fixture();
  const account = await f.service.complete(
    'operator',
    f.callback(f.begin()),
    new AbortController().signal,
  );
  const url = f.begin(account.id),
    auth = new URL(url);
  expect(auth.searchParams.get('client_id')).toBe('oaiapp_test');
  expect(auth.searchParams.has('agent_name_hint')).toBe(false);
  expect(auth.searchParams.has('id_token_hint')).toBe(false);
  f.verify.mockResolvedValueOnce({ sub: 'different-user', email: 'user@example.test' });
  await expect(
    f.service.complete('operator', f.callback(url), new AbortController().signal),
  ).rejects.toThrow();
  expect(f.state().accounts[0].subject).toBe('signed-user');
});
it('serializes rotating refreshes and fences sessions immediately on disconnect', async () => {
  const f = fixture();
  const account = await f.service.complete(
    'operator',
    f.callback(f.begin()),
    new AbortController().signal,
  );
  f.fetcher.mockClear();
  f.advance();
  const signal = new AbortController().signal;
  await Promise.all([
    f.service.ready(account.id, 'gpt-6-luna', 'low', signal),
    f.service.ready(account.id, 'gpt-6-luna', 'high', signal),
  ]);
  expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/oauth/token'))).toHaveLength(
    1,
  );
  const grant = await f.service.ready(account.id, 'gpt-6-luna', 'low', signal);
  f.fetcher.mockImplementation(async (url) =>
    String(url).includes('openid-configuration')
      ? new Response(
          JSON.stringify({
            issuer: 'https://auth.openai.com',
            revocation_endpoint: 'https://auth.openai.com/revoke',
          }),
        )
      : new Response(null),
  );
  await f.service.disconnect(account.id, signal);
  expect(() => grant.assertCurrent()).toThrow();
  expect(f.service.catalog()).toEqual([]);
});
it('rejects unavailable models/thinking and preserves signed identity when refresh changes it', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  const account = await f.service.complete('operator', f.callback(f.begin()), signal);
  f.fetcher.mockClear();
  await expect(f.service.ready(account.id, 'hidden-test', 'low', signal)).rejects.toThrow();
  await expect(f.service.ready(account.id, 'gpt-6-luna', 'max', signal)).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
  f.advance();
  f.verify.mockResolvedValueOnce({ sub: 'other', email: 'user@example.test' });
  await expect(f.service.ready(account.id, 'gpt-6-luna', 'low', signal)).rejects.toThrow();
  expect(f.service.catalog()).toEqual([]);
});

it('retains registration identity after sign-out and does not persist tokens', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  const account = await f.service.complete('operator', f.callback(f.begin()), signal);
  f.fetcher.mockImplementation(async (url) =>
    String(url).includes('openid-configuration')
      ? new Response(
          JSON.stringify({
            issuer: 'https://auth.openai.com',
            revocation_endpoint: 'https://auth.openai.com/revoke',
          }),
        )
      : new Response(null),
  );
  await f.service.disconnect(account.id, signal);
  expect(JSON.stringify(f.state())).not.toContain('synthetic');
  const auth = new URL(f.begin(account.id));
  expect(auth.searchParams.get('client_id')).toBe('oaiapp_test');
  expect(f.service.list()[0].state).toBe('disconnected');
});
it('cancels an in-flight code exchange on operator logout', async () => {
  const f = fixture(),
    url = f.begin();
  let release!: (response: Response) => void;
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const completion = f.service.complete('operator', f.callback(url), new AbortController().signal);
  f.service.cancel('operator');
  release(
    new Response(
      JSON.stringify({
        access_token: 'synthetic',
        refresh_token: 'synthetic',
        id_token: 'synthetic',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid resource.invoke chatgpt.tokens.use.direct',
      }),
    ),
  );
  await expect(completion).rejects.toThrow();
  expect(f.service.catalog()).toEqual([]);
});

it('does not let a superseded refresh invalidate a newly verified sign-in', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  const account = await f.service.complete('operator', f.callback(f.begin()), signal);
  f.advance();
  let release!: (response: Response) => void;
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const old = f.service.ready(account.id, 'gpt-6-luna', 'low', signal);
  const rejected = expect(old).rejects.toThrow();
  await f.service.complete('operator', f.callback(f.begin(account.id)), signal);
  release(
    new Response(
      JSON.stringify({
        access_token: 'old',
        refresh_token: 'old',
        id_token: 'old',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid resource.invoke chatgpt.tokens.use.direct',
      }),
    ),
  );
  await rejected;
  expect(f.service.list()[0].state).toBe('connected');
  const current = await f.service.ready(account.id, 'gpt-6-luna', 'low', signal);
  expect(current.accessToken()).toBe('synthetic-plan-access');
});

it('invalidates an already acquired grant if credential storage ownership is lost', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  const account = await f.service.complete('operator', f.callback(f.begin()), signal);
  const grant = await f.service.ready(account.id, 'gpt-6-luna', 'low', signal);
  f.loseOwner();
  expect(() => grant.accessToken()).toThrow();
  expect(grant.signal.aborted).toBe(true);
  await expect(f.service.ready(account.id, 'gpt-6-luna', 'low', signal)).rejects.toThrow();
});

it('does not extend access-token expiry while identity or model discovery is delayed', async () => {
  const f = fixture(),
    receivedAt = f.time();
  f.verify.mockImplementationOnce(async () => {
    f.advance();
    return { sub: 'signed-user', email: 'user@example.test' };
  });
  await f.service.complete('operator', f.callback(f.begin()), new AbortController().signal);
  expect(f.state().accounts[0].expiresAt).toBe(receivedAt + 3600000);
});

it('does not invalidate one account refresh when another account sign-in is cancelled', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  const first = await f.service.complete('operator', f.callback(f.begin()), signal);
  const secondCallback = f.callback(f.begin());
  secondCallback.searchParams.set('client_id', 'oaiapp_second');
  const second = await f.service.complete('operator', secondCallback, signal);
  f.advance();
  let release!: (response: Response) => void;
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const refreshing = f.service.ready(first.id, 'gpt-6-luna', 'low', signal);
  void refreshing.catch(() => {});
  f.begin(second.id);
  f.service.cancel('operator');
  release(
    new Response(
      JSON.stringify({
        access_token: 'synthetic-renewed',
        refresh_token: 'synthetic-renewed-refresh',
        id_token: 'synthetic-id',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid resource.invoke chatgpt.tokens.use.direct',
      }),
    ),
  );
  const renewed = await refreshing;
  expect(renewed.accessToken()).toBe('synthetic-renewed');
  expect(f.service.list().find((account) => account.id === first.id)!.state).toBe('connected');
});

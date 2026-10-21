// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RepositoryChatPicker } from '../RepositoryChatPicker';
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: api.fetch }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  api.fetch.mockReset();
  sessionStorage.clear();
});
const preview = {
  id: '8ca30b0d-3e65-4eeb-8244-f6277350818f' as const,
  repository: 'example/repo',
  baseBranch: 'main',
  baseOid: 'a'.repeat(40),
  featureBranch: 'mitzo/task',
  state: 'preview',
};
it('uses a repository already on the Mac without a GitHub preview or preparation step', async () => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(preview.id);
  const runtime = {
    runOn: 'local' as const,
    runtime: {
      account: { accountId: 'account', provider: 'openai' as const, profileRevision: 'rev' },
      harness: 'responses' as const,
      targetId: 'mac',
    },
  };
  const bound = {
    version: 2,
    account: runtime.runtime.account,
    harness: { implementation: 'responses' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'host-1' },
  };
  const onChange = vi.fn();
  api.fetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes('/catalog')
            ? {
                available: true,
                location: 'local',
                repositories: [
                  {
                    connectionId: 'local',
                    repositoryId: 'primary',
                    repository: 'local/primary',
                    label: 'Mitzo',
                  },
                ],
              }
            : { ...preview, repository: 'local/primary', state: 'ready', ordinaryRuntime: bound },
        ),
      ),
  );
  render(
    <RepositoryChatPicker
      accountId="account"
      model="model"
      draftScoped
      ordinaryRuntime={runtime}
      onChange={onChange}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Add repository' }));
  await user.selectOptions(screen.getByLabelText('Local repository'), 'local:local/primary');
  await user.click(screen.getByRole('button', { name: 'Use repository' }));
  await screen.findByText(/worktree starts from latest upstream main/i);
  expect(screen.getByText('Mitzo', { exact: true })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Refresh repository status' })).toBeTruthy();
  expect(api.fetch.mock.calls[0][0]).toContain('runOn=local');
  const posts = api.fetch.mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0][0]).toBe('/api/repository-workspaces/local');
  expect(JSON.parse(posts[0][1].body)).toMatchObject({
    repositoryId: 'primary',
    ordinaryRuntime: runtime,
    requestId: expect.any(String),
  });
  expect(onChange).toHaveBeenLastCalledWith({
    repositoryWorkspaceId: preview.id,
    blocked: false,
    ordinaryRuntime: bound,
  });
  expect(screen.queryByText('Prepare repository')).toBeNull();
  expect(screen.queryByText('Paste a GitHub URL')).toBeNull();
});
it('allows retry after an upstream failure instead of trapping a local selection behind a missing receipt', async () => {
  const ordinaryRuntime = {
    runOn: 'local' as const,
    runtime: {
      account: { accountId: 'account', provider: 'openai' as const, profileRevision: 'rev' },
      harness: 'responses' as const,
      targetId: 'mac',
    },
  };
  api.fetch.mockImplementation(
    async (_url: string, options?: RequestInit) =>
      new Response(
        JSON.stringify(
          options?.method === 'POST'
            ? { error: 'Upstream main is unavailable' }
            : {
                available: true,
                location: 'local',
                repositories: [
                  {
                    connectionId: 'local',
                    repositoryId: 'primary',
                    repository: 'local/primary',
                    label: 'Mitzo',
                  },
                ],
              },
        ),
        { status: options?.method === 'POST' ? 409 : 200 },
      ),
  );
  render(
    <RepositoryChatPicker
      accountId="account"
      model="model"
      ordinaryRuntime={ordinaryRuntime}
      onChange={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Add repository' }));
  await user.selectOptions(screen.getByLabelText('Local repository'), 'local:local/primary');
  await user.click(screen.getByRole('button', { name: 'Use repository' }));
  await screen.findByText('Upstream main is unavailable');
  expect(
    (screen.getByRole('button', { name: 'Use repository' }) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(sessionStorage.getItem('mitzo-repository-draft:account:model')).toBeNull();
});
it('can leave a lost local selection whose metadata was never created', async () => {
  const ordinaryRuntime = {
    runOn: 'local' as const,
    runtime: {
      account: { accountId: 'account', provider: 'openai' as const, profileRevision: 'rev' },
      harness: 'responses' as const,
      targetId: 'mac',
    },
  };
  api.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') throw Error('Disconnected');
    if (options?.method === 'DELETE') return new Response(null, { status: 404 });
    return new Response(
      JSON.stringify({
        available: true,
        location: 'local',
        repositories: [
          {
            connectionId: 'local',
            repositoryId: 'primary',
            repository: 'local/primary',
            label: 'Mitzo',
          },
        ],
      }),
    );
  });
  const onChange = vi.fn();
  render(
    <RepositoryChatPicker
      accountId="account"
      model="model"
      ordinaryRuntime={ordinaryRuntime}
      onChange={onChange}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Add repository' }));
  await user.selectOptions(screen.getByLabelText('Local repository'), 'local:local/primary');
  await user.click(screen.getByRole('button', { name: 'Use repository' }));
  await screen.findByText(/Refresh its status to continue/);
  await user.click(screen.getByRole('button', { name: 'Use default repository' }));
  expect(onChange).toHaveBeenLastCalledWith(null);
});
it('does not consume another saved receipt when leaving an explicit claimed handoff', async () => {
  const otherId = 'aaaaaaaa-bbbb-4ccc-8ddd-121212121212';
  sessionStorage.setItem('mitzo-repository-draft:account:model', otherId);
  api.fetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes('/catalog')
            ? { available: true, repositories: [] }
            : {
                ...preview,
                state: 'claimed',
                conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-121212121212',
              },
        ),
      ),
  );
  render(
    <RepositoryChatPicker
      accountId="account"
      model="model"
      initialPreparationId={preview.id}
      onChange={vi.fn()}
    />,
  );
  await screen.findByRole('link', { name: 'Open repository conversation' });
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Continue without repository' }));
  expect(sessionStorage.getItem('mitzo-repository-draft:account:model')).toBe(otherId);
});
it('ignores a late discard response after leaving the preparation', async () => {
  let complete!: (response: Response) => void;
  api.fetch.mockImplementation(async (url: string, options?: RequestInit) =>
    options?.method === 'DELETE'
      ? new Promise<Response>((resolve) => {
          complete = resolve;
        })
      : new Response(
          JSON.stringify(
            url.includes('/catalog')
              ? { available: true, repositories: [] }
              : { ...preview, state: 'ready' },
          ),
        ),
  );
  const onChange = vi.fn();
  const { unmount } = render(
    <RepositoryChatPicker
      accountId="account"
      model="model"
      initialPreparationId={preview.id}
      onChange={onChange}
    />,
  );
  await screen.findByText(/Ready for your first prompt/);
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Continue without repository' }));
  unmount();
  complete(new Response(null, { status: 204 }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(onChange).not.toHaveBeenCalledWith(null);
});
it('restores an explicit preparation without browser storage or creating another source', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('no storage');
  });
  const onChange = vi.fn();
  api.fetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes('/catalog')
            ? { available: true, repositories: [] }
            : { ...preview, state: 'ready' },
        ),
      ),
  );
  render(
    <RepositoryChatPicker
      accountId="account"
      model="model"
      initialPreparationId={preview.id}
      onChange={onChange}
    />,
  );
  await screen.findByText(/Ready for your first prompt/);
  expect(onChange).toHaveBeenLastCalledWith({ repositoryWorkspaceId: preview.id, blocked: false });
  expect(api.fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
});
it('keeps an explicit claimed preparation blocked and never deletes its original claim', async () => {
  const onChange = vi.fn();
  api.fetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes('/catalog')
            ? { available: true, repositories: [] }
            : {
                ...preview,
                state: 'claimed',
                conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-121212121212',
              },
        ),
      ),
  );
  render(
    <RepositoryChatPicker
      accountId="account"
      model="model"
      initialPreparationId={preview.id}
      onChange={onChange}
    />,
  );
  await screen.findByRole('link', { name: 'Open repository conversation' });
  expect(onChange).toHaveBeenLastCalledWith({ blocked: true });
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Continue without repository' }));
  expect(api.fetch.mock.calls.some(([, options]) => options.method === 'DELETE')).toBe(false);
});
it('does not prepare or discard an explicit receipt when its restoration response is lost', async () => {
  api.fetch.mockRejectedValue(new Error('offline'));
  const onChange = vi.fn();
  render(
    <RepositoryChatPicker
      accountId="account"
      model="model"
      initialPreparationId={preview.id}
      onChange={onChange}
    />,
  );
  await screen.findByRole('alert');
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Continue without repository' }));
  expect(
    api.fetch.mock.calls.some(
      ([, options]) => options.method === 'DELETE' || options.method === 'POST',
    ),
  ).toBe(false);
  expect(onChange.mock.calls.every(([selection]) => selection?.blocked)).toBe(true);
});
it('previews and prepares the selected account’s repository before enabling chat launch', async () => {
  const onChange = vi.fn();
  api.fetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes('/catalog')
            ? {
                available: true,
                repositories: [
                  { connectionId: 'github', label: 'GitHub', repository: 'example/repo' },
                ],
              }
            : url.endsWith('/preview')
              ? preview
              : { ...preview, state: 'ready' },
        ),
      ),
  );
  render(<RepositoryChatPicker accountId="account" model="model" onChange={onChange} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Add repository' }));
  expect(onChange).toHaveBeenLastCalledWith({ blocked: true });
  await user.selectOptions(screen.getByLabelText('GitHub repository'), 'github:example/repo');
  await user.click(screen.getByRole('button', { name: 'Preview repository' }));
  expect(await screen.findByText('aaaaaaaaaaaa')).toBeTruthy();
  expect(screen.getByText(/Repository contents will be shared/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Prepare repository' }));
  await screen.findByText(/Ready for your first prompt/);
  expect(onChange).toHaveBeenLastCalledWith({ repositoryWorkspaceId: preview.id, blocked: false });
  const request = api.fetch.mock.calls.find(([url]) => url.endsWith('/preview'));
  expect(JSON.parse(request![1].body)).toEqual({
    accountId: 'account',
    model: 'model',
    connectionId: 'github',
    repository: 'example/repo',
  });
});
it('keeps launch blocked after a failed preparation and allows explicit cancellation', async () => {
  api.fetch.mockImplementation(async (url: string) =>
    url.endsWith('/preview')
      ? new Response(JSON.stringify({ error: 'Access changed' }), { status: 409 })
      : new Response(
          JSON.stringify({
            available: true,
            repositories: [{ connectionId: 'github', label: 'GitHub', repository: 'example/repo' }],
          }),
        ),
  );
  const onChange = vi.fn();
  render(<RepositoryChatPicker accountId="account" model="model" onChange={onChange} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Add repository' }));
  await user.selectOptions(screen.getByLabelText('GitHub repository'), 'github:example/repo');
  await user.click(screen.getByRole('button', { name: 'Preview repository' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Access changed');
  expect(onChange).toHaveBeenLastCalledWith({ blocked: true });
  await user.click(screen.getByRole('button', { name: 'Continue without repository' }));
  expect(onChange).toHaveBeenLastCalledWith(null);
});
it('hides unenrolled onboarding and explains missing repository access', async () => {
  api.fetch.mockResolvedValue(new Response(JSON.stringify({ available: false, repositories: [] })));
  const { unmount } = render(
    <RepositoryChatPicker accountId="account" model="model" onChange={vi.fn()} />,
  );
  await vi.waitFor(() => expect(api.fetch).toHaveBeenCalled());
  expect(screen.queryByRole('button', { name: 'Add repository' })).toBeNull();
  unmount();
  api.fetch.mockResolvedValue(new Response(JSON.stringify({ available: true, repositories: [] })));
  render(<RepositoryChatPicker accountId="account" model="model" onChange={vi.fn()} />);
  expect(await screen.findByText(/Assign a GitHub connection/)).toBeTruthy();
});

it('keeps a lost saved repository preparation blocked rather than silently launching the default workspace', async () => {
  sessionStorage.setItem('mitzo-repository-draft:account:model', preview.id);
  api.fetch.mockImplementation(async (url: string) =>
    url.includes('/catalog')
      ? new Response(
          JSON.stringify({
            available: true,
            repositories: [{ connectionId: 'github', label: 'GitHub', repository: 'example/repo' }],
          }),
        )
      : new Response(JSON.stringify({ error: 'unavailable' }), { status: 404 }),
  );
  const onChange = vi.fn();
  render(<RepositoryChatPicker accountId="account" model="model" onChange={onChange} />);
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Saved repository preparation is unavailable. Discard it below before choosing another repository.',
  );
  expect(onChange).toHaveBeenLastCalledWith({ blocked: true });
});

it('blocks saved repository launch while the catalog is pending and keeps cancellation available on failure', async () => {
  sessionStorage.setItem('mitzo-repository-draft:account:model', preview.id);
  let reject!: (error: Error) => void;
  api.fetch.mockReturnValue(
    new Promise((_resolve, r) => {
      reject = r;
    }),
  );
  const onChange = vi.fn();
  render(<RepositoryChatPicker accountId="account" model="model" onChange={onChange} />);
  expect(onChange).toHaveBeenLastCalledWith({ blocked: true });
  reject(new Error('catalog offline'));
  await screen.findByRole('alert');
  expect(onChange.mock.calls.every(([selection]) => selection?.blocked)).toBe(true);
  api.fetch.mockResolvedValue(new Response(null, { status: 204 }));
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Continue without repository' }));
  expect(onChange).toHaveBeenLastCalledWith(null);
  expect(sessionStorage.getItem('mitzo-repository-draft:account:model')).toBeNull();
  expect(api.fetch).toHaveBeenLastCalledWith(
    `/api/repository-workspaces/${preview.id}?accountId=account&model=model`,
    expect.objectContaining({ method: 'DELETE' }),
  );
});

it('preserves a saved selection when onboarding becomes unavailable', async () => {
  sessionStorage.setItem('mitzo-repository-draft:account:model', preview.id);
  api.fetch.mockResolvedValue(new Response(JSON.stringify({ available: false, repositories: [] })));
  const onChange = vi.fn();
  render(<RepositoryChatPicker accountId="account" model="model" onChange={onChange} />);
  await screen.findByRole('alert');
  expect(onChange).toHaveBeenLastCalledWith({ blocked: true });
  expect(screen.getByRole('button', { name: 'Continue without repository' })).toBeTruthy();
});

it('preserves a saved preparation after failed discard and reclaims it on retry', async () => {
  sessionStorage.setItem('mitzo-repository-draft:account:model', preview.id);
  api.fetch.mockImplementation(async (url: string) =>
    url.includes('/catalog')
      ? new Response(JSON.stringify({ available: true, repositories: [] }))
      : new Response(JSON.stringify({ error: 'status unavailable' }), { status: 503 }),
  );
  const onChange = vi.fn();
  render(<RepositoryChatPicker accountId="account" model="model" onChange={onChange} />);
  await screen.findByRole('alert');
  api.fetch.mockRejectedValueOnce(new Error('delete offline'));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Continue without repository' }));
  await vi.waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Could not discard'),
  );
  expect(sessionStorage.getItem('mitzo-repository-draft:account:model')).toBe(preview.id);
  expect(onChange).toHaveBeenLastCalledWith({ blocked: true });
  api.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ discarded: true })));
  await user.click(screen.getByRole('button', { name: 'Continue without repository' }));
  await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null));
  expect(api.fetch).toHaveBeenLastCalledWith(
    `/api/repository-workspaces/${preview.id}?accountId=account&model=model`,
    expect.objectContaining({ method: 'DELETE' }),
  );
  expect(sessionStorage.getItem('mitzo-repository-draft:account:model')).toBeNull();
});

it('requires reclaiming the saved source before preparing a replacement after failed restoration', async () => {
  sessionStorage.setItem('mitzo-repository-draft:account:model', preview.id);
  api.fetch.mockImplementation(async (url: string) =>
    url.includes('/catalog')
      ? new Response(
          JSON.stringify({
            available: true,
            repositories: [{ connectionId: 'github', label: 'GitHub', repository: 'example/repo' }],
          }),
        )
      : new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }),
  );
  render(<RepositoryChatPicker accountId="account" model="model" onChange={vi.fn()} />);
  await screen.findByRole('alert');
  await userEvent
    .setup()
    .selectOptions(screen.getByLabelText('GitHub repository'), 'github:example/repo');
  expect(
    (screen.getByRole('button', { name: 'Preview repository' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(api.fetch.mock.calls.some(([url]) => url.endsWith('/preview'))).toBe(false);
  expect(sessionStorage.getItem('mitzo-repository-draft:account:model')).toBe(preview.id);
});

it('restores a settled claim after startup fails before assignment, and offers its original conversation', async () => {
  sessionStorage.setItem('mitzo-repository-draft:account:model', preview.id);
  const onChange = vi.fn();
  api.fetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes('/catalog?')
            ? { available: true, repositories: [] }
            : {
                ...preview,
                state: 'claimed',
                conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-121212121212',
              },
        ),
      ),
  );
  render(<RepositoryChatPicker accountId="account" model="model" onChange={onChange} />);
  expect(await screen.findByRole('link', { name: 'Open repository conversation' })).toHaveProperty(
    'href',
    'http://localhost:3000/chat/aaaaaaaa-bbbb-4ccc-8ddd-121212121212',
  );
  expect(onChange).toHaveBeenLastCalledWith({ blocked: true });
  expect(screen.queryByText(/Ready for your first prompt/)).toBeNull();
  expect(screen.getByText(/already belongs to a conversation/)).toBeTruthy();
});

it.each([false, true])(
  'preserves the original source after a lost prepare response (storage unavailable: %s)',
  async (storageUnavailable) => {
    const requests: Array<{ url: string; method?: string }> = [];
    api.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
      requests.push({ url, method: options?.method });
      if (url.includes('/catalog'))
        return new Response(
          JSON.stringify({
            available: true,
            repositories: [{ connectionId: 'github', label: 'GitHub', repository: 'example/repo' }],
          }),
        );
      if (url.endsWith('/preview')) return new Response(JSON.stringify(preview));
      if (url.endsWith('/prepare')) throw new Error('response lost after server prepared source');
      if (options?.method === 'DELETE') return new Response(JSON.stringify({ discarded: true }));
      throw new Error('unexpected request');
    });
    if (storageUnavailable)
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('storage unavailable');
      });
    const onChange = vi.fn();
    render(<RepositoryChatPicker accountId="account" model="model" onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add repository' }));
    await user.selectOptions(screen.getByLabelText('GitHub repository'), 'github:example/repo');
    await user.click(screen.getByRole('button', { name: 'Preview repository' }));
    await user.click(await screen.findByRole('button', { name: 'Prepare repository' }));
    await screen.findByRole('alert');
    expect(
      (screen.getByRole('button', { name: 'Preview repository' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Preview repository' }));
    expect(requests.filter((request) => request.url.endsWith('/preview'))).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Continue without repository' }));
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null));
    expect(requests.at(-1)).toEqual({
      url: `/api/repository-workspaces/${preview.id}?accountId=account&model=model`,
      method: 'DELETE',
    });
    expect(sessionStorage.getItem('mitzo-repository-draft:account:model')).toBeNull();
  },
);

it('clears a restored claimed draft locally and retains the original conversation link', async () => {
  sessionStorage.setItem('mitzo-repository-draft:account:model', preview.id);
  const requests: Array<{ url: string; method?: string }> = [];
  const onChange = vi.fn();
  api.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
    requests.push({ url, method: options?.method });
    return new Response(
      JSON.stringify(
        url.includes('/catalog')
          ? {
              available: true,
              repositories: [
                { connectionId: 'github', label: 'GitHub', repository: 'example/repo' },
              ],
            }
          : {
              ...preview,
              state: 'claimed',
              conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-121212121212',
            },
      ),
    );
  });
  render(<RepositoryChatPicker accountId="account" model="model" onChange={onChange} />);
  await screen.findByRole('link', { name: 'Open repository conversation' });
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Continue without repository' }));
  await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null));
  expect(sessionStorage.getItem('mitzo-repository-draft:account:model')).toBeNull();
  expect(requests.some((request) => request.method === 'DELETE')).toBe(false);
  expect(screen.getByRole('link', { name: 'Open repository conversation' })).toHaveProperty(
    'href',
    'http://localhost:3000/chat/aaaaaaaa-bbbb-4ccc-8ddd-121212121212',
  );
  expect(screen.getByRole('button', { name: 'Add repository' })).toBeTruthy();
});
it('keeps a scoped draft independent of another per-account preparation', async () => {
  sessionStorage.setItem('mitzo-repository-draft:account:model', preview.id);
  api.fetch.mockResolvedValue(new Response(JSON.stringify({ available: true, repositories: [] })));
  const onChange = vi.fn();
  render(
    <RepositoryChatPicker accountId="account" model="model" draftScoped onChange={onChange} />,
  );
  await screen.findByText(/Assign a GitHub connection/);
  expect(onChange).toHaveBeenLastCalledWith(null);
  expect(api.fetch.mock.calls.some(([url]) => url.includes(preview.id))).toBe(false);
});
it.each(['preparing', 'failed', 'claimed'])(
  'retains the exact scoped preparation ID when restoration is blocked: %s',
  async (state) => {
    api.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/catalog')
              ? { available: true, repositories: [] }
              : { ...preview, state },
          ),
        ),
    );
    const onChange = vi.fn();
    render(
      <RepositoryChatPicker
        accountId="account"
        model="model"
        draftScoped
        initialPreparationId={preview.id}
        onChange={onChange}
      />,
    );
    await vi.waitFor(() => expect(api.fetch.mock.calls).toHaveLength(2));
    expect(onChange).toHaveBeenLastCalledWith({ blocked: true, repositoryWorkspaceId: preview.id });
  },
);
it('retains a scoped prepare receipt when its response is lost without contaminating account storage', async () => {
  api.fetch.mockImplementation(async (url: string) => {
    if (url.includes('/catalog'))
      return new Response(
        JSON.stringify({
          available: true,
          repositories: [{ connectionId: 'github', label: 'GitHub', repository: 'example/repo' }],
        }),
      );
    if (url.endsWith('/preview')) return new Response(JSON.stringify(preview));
    throw new Error('prepare response lost');
  });
  const onChange = vi.fn();
  render(
    <RepositoryChatPicker accountId="account" model="model" draftScoped onChange={onChange} />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Add repository' }));
  await user.selectOptions(screen.getByLabelText('GitHub repository'), 'github:example/repo');
  await user.click(screen.getByRole('button', { name: 'Preview repository' }));
  await user.click(await screen.findByRole('button', { name: 'Prepare repository' }));
  await screen.findByRole('alert');
  expect(onChange).toHaveBeenLastCalledWith({ blocked: true, repositoryWorkspaceId: preview.id });
  expect(sessionStorage.getItem('mitzo-repository-draft:account:model')).toBeNull();
});

it('retains the same ready preparation across a supported model edit and exposes only server-qualified runtime metadata', async () => {
  const ordinaryRuntime = {
    version: 2 as const,
    account: { accountId: 'account', provider: 'openai' as const, profileRevision: 'profile-r1' },
    harness: { implementation: 'responses' as const },
    execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'target-r1' },
  };
  const onChange = vi.fn();
  api.fetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes('/catalog')
            ? { available: true, repositories: [] }
            : { ...preview, state: 'ready', ordinaryRuntime },
        ),
      ),
  );
  const { rerender } = render(
    <RepositoryChatPicker
      accountId="account"
      model="model-A"
      initialPreparationId={preview.id}
      onChange={onChange}
    />,
  );
  await screen.findByText(/Ready for your first prompt/);
  expect(onChange).toHaveBeenLastCalledWith({
    repositoryWorkspaceId: preview.id,
    blocked: false,
    ordinaryRuntime,
  });
  rerender(
    <RepositoryChatPicker
      accountId="account"
      model="model-B"
      initialPreparationId={preview.id}
      onChange={onChange}
    />,
  );
  await screen.findByText(/Ready for your first prompt/);
  expect(onChange).toHaveBeenLastCalledWith({
    repositoryWorkspaceId: preview.id,
    blocked: false,
    ordinaryRuntime,
  });
  expect(api.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  expect(api.fetch.mock.calls.some(([url]) => String(url).includes(`/${preview.id}?`))).toBe(true);
});

const runtimeChoice = (location: 'local' | 'openshell') => ({
  runOn: location,
  runtime: {
    account: { accountId: 'account', provider: 'openai' as const, profileRevision: 'r1' },
    harness: location === 'local' ? ('responses' as const) : ('codex' as const),
    targetId: location === 'local' ? 'mac' : 'shell',
  },
});
function mockRepositoryFlow(losePrepare = false) {
  api.fetch.mockImplementation(async (url: string) => {
    if (url.includes('/catalog'))
      return new Response(
        JSON.stringify({
          available: true,
          repositories: [{ connectionId: 'github', label: 'GitHub', repository: 'example/repo' }],
        }),
      );
    if (url.endsWith('/preview')) return new Response(JSON.stringify(preview));
    if (url.endsWith('/prepare') && losePrepare) throw Error('response lost');
    return new Response(JSON.stringify({ ...preview, state: 'ready' }));
  });
}
it('invalidates an unprepared preview when the selected execution runtime changes', async () => {
  mockRepositoryFlow();
  const onChange = vi.fn();
  const { rerender } = render(
    <RepositoryChatPicker
      accountId="account"
      model="model"
      ordinaryRuntime={runtimeChoice('openshell')}
      onChange={onChange}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Add repository' }));
  await user.selectOptions(screen.getByLabelText('GitHub repository'), 'github:example/repo');
  await user.click(screen.getByRole('button', { name: 'Preview repository' }));
  await screen.findByRole('button', { name: 'Prepare repository' });
  rerender(
    <RepositoryChatPicker
      accountId="account"
      model="model"
      ordinaryRuntime={runtimeChoice('local')}
      onChange={onChange}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Prepare repository' })).toBeNull(),
  );
  await user.click(screen.getByRole('button', { name: 'Preview repository' }));
  const requests = api.fetch.mock.calls.filter(([url]) => url.endsWith('/preview'));
  expect(requests).toHaveLength(2);
  expect(JSON.parse(requests[1][1].body).ordinaryRuntime).toEqual(runtimeChoice('local'));
});
it.each(['preparing', 'error'])(
  'a newer refresh wins over a late initial restoration: %s',
  async (lateState) => {
    let completeRestoration!: (response: Response) => void;
    let reads = 0;
    api.fetch.mockImplementation(async (url: string) => {
      if (url.includes('/catalog')) return Response.json({ available: true, repositories: [] });
      if (++reads === 1)
        return new Promise<Response>((resolve) => {
          completeRestoration = resolve;
        });
      return Response.json({ ...preview, state: 'ready' });
    });
    const onChange = vi.fn();
    render(
      <RepositoryChatPicker
        accountId="account"
        model="model"
        draftScoped
        initialPreparationId={preview.id}
        onChange={onChange}
      />,
    );
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Refresh preparation status' }));
    await screen.findByText(/Ready for your first prompt/);
    await act(async () => {
      completeRestoration(
        lateState === 'error'
          ? new Response(null, { status: 500 })
          : Response.json({ ...preview, state: 'preparing' }),
      );
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Ready for your first prompt/)).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith({
      repositoryWorkspaceId: preview.id,
      blocked: false,
    });
    expect(reads).toBe(2);
  },
);

it('recovers the same preparation after its response was lost without preparing twice', async () => {
  mockRepositoryFlow(true);
  const onChange = vi.fn();
  render(
    <RepositoryChatPicker accountId="account" model="model" draftScoped onChange={onChange} />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Add repository' }));
  await user.selectOptions(screen.getByLabelText('GitHub repository'), 'github:example/repo');
  await user.click(screen.getByRole('button', { name: 'Preview repository' }));
  await user.click(await screen.findByRole('button', { name: 'Prepare repository' }));
  await screen.findByRole('alert');
  await user.click(screen.getByRole('button', { name: 'Refresh preparation status' }));
  await screen.findByText(/Ready for your first prompt/);
  expect(onChange).toHaveBeenLastCalledWith({ repositoryWorkspaceId: preview.id, blocked: false });
  expect(api.fetch.mock.calls.filter(([url]) => url.endsWith('/prepare'))).toHaveLength(1);
  expect(
    api.fetch.mock.calls.some(
      ([url, options]) =>
        url === `/api/repository-workspaces/${preview.id}?accountId=account&model=model` &&
        !options.method,
    ),
  ).toBe(true);
});

it('does not unblock a recovered source prepared for another execution runtime', async () => {
  mockRepositoryFlow(true);
  const onChange = vi.fn();
  const { rerender } = render(
    <RepositoryChatPicker
      accountId="account"
      model="model"
      draftScoped
      ordinaryRuntime={runtimeChoice('openshell')}
      onChange={onChange}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Add repository' }));
  await user.selectOptions(screen.getByLabelText('GitHub repository'), 'github:example/repo');
  await user.click(screen.getByRole('button', { name: 'Preview repository' }));
  await user.click(await screen.findByRole('button', { name: 'Prepare repository' }));
  await screen.findByRole('alert');
  rerender(
    <RepositoryChatPicker
      accountId="account"
      model="model"
      draftScoped
      ordinaryRuntime={runtimeChoice('local')}
      onChange={onChange}
    />,
  );
  api.fetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ...preview,
        state: 'ready',
        ordinaryRuntime: {
          version: 2,
          account: runtimeChoice('openshell').runtime.account,
          harness: { implementation: 'codex' },
          execution: { location: 'openshell', targetId: 'shell', targetRevision: 'r1' },
        },
      }),
    ),
  );
  await user.click(screen.getByRole('button', { name: 'Refresh preparation status' }));
  await screen.findByText(/original execution choices/);
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ blocked: true }));
  expect(screen.queryByText(/Ready for your first prompt/)).toBeNull();
});

it('retains a ready checkout when its matching runtime inventory arrives after restoration', async () => {
  const choice = runtimeChoice('local');
  const ordinaryRuntime = {
    version: 2 as const,
    account: choice.runtime.account,
    harness: { implementation: choice.runtime.harness },
    execution: { location: choice.runOn, targetId: choice.runtime.targetId, targetRevision: 'r1' },
  };
  api.fetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes('/catalog')
            ? { available: true, repositories: [] }
            : { ...preview, state: 'ready', ordinaryRuntime },
        ),
      ),
  );
  const onChange = vi.fn();
  const props = {
    accountId: 'account',
    model: 'model',
    draftScoped: true,
    initialPreparationId: preview.id,
    onChange,
  };
  const { rerender } = render(<RepositoryChatPicker {...props} />);
  await screen.findByText(/Ready for your first prompt/);
  rerender(<RepositoryChatPicker {...props} ordinaryRuntime={choice} />);
  expect(onChange).toHaveBeenLastCalledWith({
    repositoryWorkspaceId: preview.id,
    blocked: false,
    ordinaryRuntime,
  });
  expect(screen.queryByRole('alert')).toBeNull();
  rerender(<RepositoryChatPicker {...props} ordinaryRuntime={runtimeChoice('openshell')} />);
  expect(onChange).toHaveBeenLastCalledWith({ repositoryWorkspaceId: preview.id, blocked: true });
  await screen.findByText(/original execution choices/);
  rerender(<RepositoryChatPicker {...props} ordinaryRuntime={choice} />);
  expect(onChange).toHaveBeenLastCalledWith({
    repositoryWorkspaceId: preview.id,
    blocked: false,
    ordinaryRuntime,
  });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(api.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
});

it('does not release a restored checkout belonging to another selected runtime', async () => {
  const original = runtimeChoice('openshell');
  api.fetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes('/catalog')
            ? { available: true, repositories: [] }
            : {
                ...preview,
                state: 'ready',
                ordinaryRuntime: {
                  version: 2,
                  account: original.runtime.account,
                  harness: { implementation: original.runtime.harness },
                  execution: {
                    location: original.runOn,
                    targetId: original.runtime.targetId,
                    targetRevision: 'r1',
                  },
                },
              },
        ),
      ),
  );
  const onChange = vi.fn();
  render(
    <RepositoryChatPicker
      accountId="account"
      model="model"
      draftScoped
      initialPreparationId={preview.id}
      ordinaryRuntime={runtimeChoice('local')}
      onChange={onChange}
    />,
  );
  await vi.waitFor(() => expect(api.fetch.mock.calls).toHaveLength(2));
  await vi.waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith({ blocked: true, repositoryWorkspaceId: preview.id }),
  );
  await screen.findByText(/original execution choices/);
});

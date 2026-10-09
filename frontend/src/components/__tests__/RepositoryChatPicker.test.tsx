// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
  id: '8ca30b0d-3e65-4eeb-8244-f6277350818f',
  repository: 'example/repo',
  baseBranch: 'main',
  baseOid: 'a'.repeat(40),
  featureBranch: 'mitzo/task',
  state: 'preview',
};
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
  expect(onChange).toHaveBeenLastCalledWith({ repositoryWorkspaceId: preview.id, blocked: false });
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

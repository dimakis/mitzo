// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RepositoryChatPicker } from '../RepositoryChatPicker';
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: api.fetch }));
afterEach(() => {
  cleanup();
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

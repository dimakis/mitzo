// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InboxView } from '../InboxView';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), pending: vi.fn(), load: vi.fn() }));
const items = [
  {
    filename: 'one.md',
    agent: 'dream_detector',
    title: 'First proposal',
    tags: ['memory'],
    timestamp: '',
    preview: 'Preview one',
  },
  {
    filename: 'two.md',
    agent: 'planner',
    title: 'Second proposal',
    tags: ['calendar'],
    timestamp: '',
    preview: 'Preview two',
  },
];
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (selector: (s: object) => unknown) =>
    selector({ inbox: { items }, loadInbox: mocks.load, setPendingSession: mocks.pending }),
}));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: mocks.fetch }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ content: 'Full proposal context' }),
  });
});
afterEach(cleanup);
function show(path = '/inbox') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <InboxView />
    </MemoryRouter>,
  );
}
it('opens a keyboard-accessible review with full context and returns to the list', async () => {
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'First proposal' }));
  const detail = screen.getByRole('region', { name: 'Proposal details' });
  expect(await within(detail).findByText('Full proposal context')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Back to proposals' })).toHaveFocus();
  expect(screen.queryByRole('button', { name: 'Second proposal' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Back to proposals' }));
  expect(await screen.findByRole('button', { name: 'Second proposal' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'First proposal' })).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'First proposal' }));
  await screen.findByText('Full proposal context');
  fireEvent.click(screen.getByRole('button', { name: 'Review in session' }));
  expect(mocks.pending).toHaveBeenCalledWith(
    expect.objectContaining({ prompt: expect.stringContaining('Full proposal context') }),
  );
});
it('searches titles, tags and context, with a useful empty result', async () => {
  show();
  await screen.findByRole('button', { name: 'First proposal' });
  const search = screen.getByRole('searchbox', { name: 'Search proposals' });
  fireEvent.change(search, { target: { value: 'calendar' } });
  expect(screen.queryByRole('button', { name: 'First proposal' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Second proposal' })).toBeVisible();
  fireEvent.change(search, { target: { value: 'missing' } });
  expect(screen.getByText('No matching proposals')).toBeVisible();
});
it('keeps a failed read retryable and never reviews a truncated preview', async () => {
  mocks.fetch.mockRejectedValueOnce(new Error('offline'));
  show('/inbox?item=one.md');
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load');
  expect(screen.queryByRole('button', { name: 'Review in session' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Full proposal context')).toBeVisible();
});

it('permits only one removal while keeping the full detail visible, then allows retry after failure', async () => {
  show('/inbox?item=one.md');
  await screen.findByText('Full proposal context');
  let finish!: (value: { ok: boolean }) => void;
  mocks.fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const calls = mocks.fetch.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
  expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Review in session' })).toBeDisabled();
  expect(screen.getByText('Full proposal context')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect(mocks.fetch).toHaveBeenCalledTimes(calls + 1);
  await act(async () => finish({ ok: false }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Archive failed');
  expect(screen.getByRole('button', { name: 'Archive' })).toBeEnabled();
});

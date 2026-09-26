// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { AddReviewerSheet } from '../AddReviewerSheet';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: ({ onChange }: { onChange: (v: unknown) => void }) => (
    <button onClick={() => onChange({ accountId: 'a', model: 'luna' })}>Choose account</button>
  ),
}));
vi.mock('../SymposiumProfilePicker', () => ({
  SymposiumProfilePicker: ({ onChange }: { onChange: (v: unknown) => void }) => (
    <button onClick={() => onChange({ profileId: 'review', revision: 1 })}>Choose profile</button>
  ),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('starts independent and keeps controls out of the composer until opened', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ config: null, seats: [], runtimeAvailable: false })),
  );
  render(<AddReviewerSheet sessionId="chat" />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(screen.getByLabelText('Context package')).toHaveValue('independent');
  expect(screen.getByRole('button', { name: 'Add reviewer and queue context' })).toBeDisabled();
});
it('does not read history for independent review or enable addition without explicit profile and boundary', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ config: null, seats: [], runtimeAvailable: true })),
  );
  render(<AddReviewerSheet sessionId="chat" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  expect(
    vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('context-turns')),
  ).toBe(false);
  fireEvent.click(screen.getByText('Choose account'));
  expect(screen.getByRole('button', { name: 'Add reviewer and queue context' })).toBeDisabled();
});

it('adds a read-only reviewer with empty history grants and queues only the explicit package', async () => {
  const config = {
    version: 2,
    revision: 1,
    state: 'active',
    anchorSeatId: 'anchor',
    seats: [{ id: 'anchor', accountBinding: { accountId: 'a' } }],
  };
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.endsWith('/symposium'))
      return new Response(
        JSON.stringify({
          config,
          runtimeAvailable: true,
          seats: [{ seatId: 'anchor', membership: { state: 'active', generation: 1 } }],
        }),
      );
    if (path.endsWith('/context-package')) return new Response(JSON.stringify({ content: '' }));
    if (path.endsWith('/seats/revise'))
      return new Response(JSON.stringify({ ...config, revision: 2 }));
    expect(init?.method).toBe('POST');
    return new Response(JSON.stringify({}));
  });
  render(<AddReviewerSheet sessionId="chat" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  fireEvent.click(await screen.findByText('Choose account'));
  fireEvent.click(screen.getByText('Choose profile'));
  fireEvent.change(screen.getByLabelText('Review package'), {
    target: { value: 'Review diff for acceptance criteria A; tests passed' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add reviewer and queue context' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer and queue context' }));
  await screen.findByText(/Reviewer added/);
  const revise = vi
    .mocked(apiFetch)
    .mock.calls.find(([url]) => String(url).endsWith('/seats/revise'))!;
  expect(JSON.parse(String(revise[1]?.body))).toMatchObject({
    role: 'reviewer',
    contextSourceRefs: [],
    accountId: 'a',
    model: 'luna',
    profileSelection: { profileId: 'review', revision: 1 },
  });
  const delivery = vi
    .mocked(apiFetch)
    .mock.calls.find(([url]) => String(url).endsWith('/deliveries'))!;
  expect(JSON.parse(String(delivery[1]?.body))).toMatchObject({
    originalContent:
      'Review request (read-only):\nReview diff for acceptance criteria A; tests passed',
  });
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('/dispatch'))).toBe(
    false,
  );
});

it('lets an ordinary conversation prepare its isolated roster before runtime admission', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).endsWith('/context-package')
            ? { content: '' }
            : { config: null, runtimeAvailable: false, seats: [] },
        ),
      ),
  );
  render(<AddReviewerSheet sessionId="ordinary" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  fireEvent.click(await screen.findByText('Choose account'));
  fireEvent.click(screen.getByText('Choose profile'));
  fireEvent.change(screen.getByLabelText('Review package'), {
    target: { value: 'Review supplied diff' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add reviewer and queue context' })).toBeEnabled(),
  );
});

it('moves focus into the dialog and restores it on Escape', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ config: null, seats: [], runtimeAvailable: false })),
  );
  render(<AddReviewerSheet sessionId="chat" />);
  const trigger = screen.getByRole('button', { name: 'Add reviewer' });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(trigger).toHaveFocus();
});

it('retains an admitted reviewer and frozen context across close/reopen after queue failure', async () => {
  const config = {
    version: 2,
    revision: 1,
    state: 'active',
    anchorSeatId: 'anchor',
    seats: [{ id: 'anchor', accountBinding: { accountId: 'a' } }],
  };
  let failed = false;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.endsWith('/symposium'))
      return new Response(
        JSON.stringify({
          config,
          runtimeAvailable: true,
          seats: config.seats.map((seat) => ({
            seatId: seat.id,
            membership: { state: 'active', generation: 1 },
          })),
        }),
      );
    if (path.endsWith('/context-package')) return new Response(JSON.stringify({ content: '' }));
    if (path.endsWith('/seats/revise')) {
      const body = JSON.parse(String(init?.body));
      config.seats.push({ id: body.seatId, accountBinding: { accountId: body.accountId } });
      return new Response(JSON.stringify(config));
    }
    if (path.endsWith('/deliveries') && !failed) {
      failed = true;
      return new Response(JSON.stringify({ error: 'Queue unavailable' }), { status: 503 });
    }
    return new Response(JSON.stringify({}));
  });
  render(<AddReviewerSheet sessionId="chat" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  fireEvent.click(await screen.findByText('Choose account'));
  fireEvent.click(screen.getByText('Choose profile'));
  fireEvent.change(screen.getByLabelText('Review package'), {
    target: { value: 'Frozen package' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add reviewer and queue context' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer and queue context' }));
  await screen.findByText(/Reviewer admitted. Context not queued/);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  expect(screen.getByLabelText('Review package')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer and queue context' }));
  await screen.findByText(/Reviewer added/);
  const writes = vi.mocked(apiFetch).mock.calls;
  expect(writes.filter(([url]) => String(url).endsWith('/seats/revise'))).toHaveLength(1);
  const queued = writes
    .filter(([url]) => String(url).endsWith('/deliveries'))
    .map(([, init]) => JSON.parse(String(init?.body)));
  expect(queued).toHaveLength(2);
  expect(queued[1]).toEqual(queued[0]);
});

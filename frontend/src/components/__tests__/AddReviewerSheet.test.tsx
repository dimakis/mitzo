// @vitest-environment jsdom
import { reviewerOperations } from '../../lib/symposium-reviewer-operations';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { AddReviewerSheet } from '../AddReviewerSheet';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
const accountPicker = vi.hoisted(() => ({
  onChange: undefined as undefined | ((v: unknown) => void),
}));
vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: ({ onChange }: { onChange: (v: unknown) => void }) => {
    accountPicker.onChange = onChange;
    return (
      <button onClick={() => onChange({ accountId: 'a', model: 'luna' })}>Choose account</button>
    );
  },
}));
const profilePicker = vi.hoisted(() => ({
  onChange: undefined as undefined | ((v: unknown) => void),
}));
vi.mock('../SymposiumProfilePicker', () => ({
  SymposiumProfilePicker: ({ onChange }: { onChange: (v: unknown) => void }) => {
    profilePicker.onChange = onChange;
    return (
      <button onClick={() => onChange({ profileId: 'review', revision: 1 })}>Choose profile</button>
    );
  },
}));
afterEach(() => {
  reviewerOperations.reset();
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
  expect(screen.getByLabelText('Conversation context to share')).toHaveValue('independent');
  expect(screen.getByRole('button', { name: 'Add reviewer & queue request' })).toBeDisabled();
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
  expect(screen.getByRole('button', { name: 'Add reviewer & queue request' })).toBeDisabled();
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
    if (path.startsWith('/api/symposium/profiles/'))
      return new Response(JSON.stringify({ definition: { role: 'reviewer' } }));
    if (path.endsWith('/status'))
      return new Response(
        JSON.stringify({
          config,
          runtimeAvailable: true,
          seats: [{ seatId: 'anchor', membership: { state: 'active', generation: 1 } }],
        }),
      );
    if (path.endsWith('/context-package')) return new Response(JSON.stringify({ content: '' }));
    if (path.endsWith('/seats/revise')) {
      const body = JSON.parse(String(init?.body));
      config.revision++;
      config.seats.push({
        ...body,
        id: body.seatId,
        ...(body.profileSelection
          ? {
              profileBinding: {
                profileId: body.profileSelection.profileId,
                profileRevision: String(body.profileSelection.revision),
              },
            }
          : {}),
        accountBinding: { accountId: body.accountId },
      });
      return new Response(JSON.stringify(config));
    }
    if (path.endsWith('/membership')) {
      const body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          ...body,
          sessionId: 'chat',
          generation: body.expectedGeneration + 1,
          state: 'active',
          reconciliation: 'confirmed',
        }),
      );
    }
    if (path.endsWith('/deliveries'))
      return new Response(
        JSON.stringify({ ...JSON.parse(String(init?.body)), sessionId: path.split('/')[3] }),
      );
    expect(init?.method).toBe('POST');
    return new Response(JSON.stringify({}));
  });
  render(<AddReviewerSheet sessionId="chat" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  fireEvent.click(await screen.findByText('Choose account'));
  fireEvent.click(screen.getByText('Choose profile'));
  fireEvent.change(screen.getByLabelText('What should the reviewer check?'), {
    target: { value: 'Review diff for acceptance criteria A; tests passed' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add reviewer & queue request' })).toBeEnabled(),
  );
  act(() => accountPicker.onChange?.(null));
  expect(screen.getByRole('button', { name: 'Add reviewer & queue request' })).toBeDisabled();
  fireEvent.click(screen.getByText('Choose account'));
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer & queue request' }));
  await screen.findByText(/Reviewer added/);
  const handoff = vi.fn();
  window.addEventListener('symposium-open-team', handoff, { once: true });
  fireEvent.click(screen.getByRole('button', { name: 'Go to review approvals' }));
  expect(handoff).toHaveBeenCalledWith(expect.objectContaining({ detail: { sessionId: 'chat' } }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
  const refreshIndex = vi
    .mocked(apiFetch)
    .mock.calls.findIndex(([url]) => String(url).endsWith('/admissions/refresh'));
  expect(refreshIndex).toBeGreaterThan(-1);
  expect(refreshIndex).toBeLessThan(
    vi.mocked(apiFetch).mock.calls.findIndex(([url]) => String(url).endsWith('/deliveries')),
  );
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
          String(url).startsWith('/api/symposium/profiles/')
            ? { definition: { role: 'reviewer' } }
            : String(url).endsWith('/context-package')
              ? { content: '' }
              : { config: null, ordinaryAccountId: 'a', runtimeAvailable: false, seats: [] },
        ),
      ),
  );
  render(<AddReviewerSheet sessionId="ordinary" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  fireEvent.click(await screen.findByText('Choose account'));
  fireEvent.click(screen.getByText('Choose profile'));
  fireEvent.change(screen.getByLabelText('What should the reviewer check?'), {
    target: { value: 'Review supplied diff' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add reviewer & queue request' })).toBeEnabled(),
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
    if (path.startsWith('/api/symposium/profiles/'))
      return new Response(JSON.stringify({ definition: { role: 'reviewer' } }));
    if (path.endsWith('/status'))
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
      config.revision++;
      config.seats.push({
        ...body,
        id: body.seatId,
        ...(body.profileSelection
          ? {
              profileBinding: {
                profileId: body.profileSelection.profileId,
                profileRevision: String(body.profileSelection.revision),
              },
            }
          : {}),
        accountBinding: { accountId: body.accountId },
      });
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
  fireEvent.change(screen.getByLabelText('What should the reviewer check?'), {
    target: { value: 'Frozen package' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add reviewer & queue request' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer & queue request' }));
  await screen.findByText(/Queue unavailable/);
  act(() => accountPicker.onChange?.(null));
  act(() => profilePicker.onChange?.({ profileId: 'review', revision: 2 }));
  expect(screen.getByRole('button', { name: 'Add reviewer & queue request' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  expect(screen.getByLabelText('What should the reviewer check?')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Add reviewer & queue request' })).toBeDisabled();
  const writes = vi.mocked(apiFetch).mock.calls;
  expect(writes.filter(([url]) => String(url).endsWith('/seats/revise'))).toHaveLength(1);
  expect(writes.filter(([url]) => String(url).endsWith('/deliveries'))).toHaveLength(1);
});

it('renders outside chat stacking contexts so mobile navigation cannot cover its actions', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ config: null, seats: [], runtimeAvailable: false })),
  );
  const { container } = render(<AddReviewerSheet sessionId="chat" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  const dialog = await screen.findByRole('dialog');
  expect(container.contains(dialog)).toBe(false);
  expect(dialog.parentElement?.parentElement).toBe(document.body);
});

it('refreshes unavailable runtime on reopen while preserving reviewer choices', async () => {
  let available = false;
  vi.mocked(apiFetch).mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          config: {
            version: 2,
            seats: [{ id: 'anchor', accountBinding: { accountId: 'a' } }],
            anchorSeatId: 'anchor',
          },
          seats: [],
          runtimeAvailable: available,
        }),
      ),
  );
  render(<AddReviewerSheet sessionId="chat" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  fireEvent.click(await screen.findByText('Choose account'));
  fireEvent.click(screen.getByText('Choose profile'));
  fireEvent.change(screen.getByLabelText('What should the reviewer check?'), {
    target: { value: 'Review current diff' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  await screen.findByText('This agent can’t connect yet. Your choices stay in this form.');
  expect(screen.getByRole('button', { name: 'Add reviewer & queue request' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  available = true;
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add reviewer & queue request' })).toBeEnabled(),
  );
  expect(screen.getByLabelText('What should the reviewer check?')).toHaveValue(
    'Review current diff',
  );
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('requires cross-account confirmation before converting an ordinary conversation', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).startsWith('/api/symposium/profiles/')
            ? { definition: { role: 'reviewer' } }
            : String(url).endsWith('/context-package')
              ? { content: '' }
              : { config: null, ordinaryAccountId: 'other', runtimeAvailable: false, seats: [] },
        ),
      ),
  );
  render(<AddReviewerSheet sessionId="ordinary" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  fireEvent.click(await screen.findByText('Choose account'));
  fireEvent.click(screen.getByText('Choose profile'));
  fireEvent.change(screen.getByLabelText('What should the reviewer check?'), {
    target: { value: 'Review diff' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  expect(screen.getByRole('button', { name: 'Add reviewer & queue request' })).toBeDisabled();
  expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining('/draft'), expect.anything());
  fireEvent.change(screen.getByLabelText(/Cross-account confirmation/), {
    target: { value: 'ADD CROSS-ACCOUNT SEAT' },
  });
  expect(screen.getByRole('button', { name: 'Add reviewer & queue request' })).toBeEnabled();
});

it('rechecks the ordinary account before creating a draft when its binding changes', async () => {
  let reads = 0;
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).startsWith('/api/symposium/profiles/')
            ? { definition: { role: 'reviewer' } }
            : String(url).endsWith('/context-package')
              ? { content: '' }
              : {
                  config: null,
                  ordinaryAccountId: ++reads === 1 ? 'a' : 'other',
                  runtimeAvailable: false,
                  seats: [],
                },
        ),
      ),
  );
  render(<AddReviewerSheet sessionId="ordinary" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  fireEvent.click(await screen.findByText('Choose account'));
  fireEvent.click(screen.getByText('Choose profile'));
  fireEvent.change(screen.getByLabelText('What should the reviewer check?'), {
    target: { value: 'Review diff' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer & queue request' }));
  await screen.findByText(/Confirm the cross-account transfer/);
  expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining('/draft'), expect.anything());
});

it('rejects a non-reviewer profile before converting an ordinary conversation', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).startsWith('/api/symposium/profiles/')
            ? { definition: { role: 'coder' } }
            : String(url).endsWith('/status')
              ? { config: null, ordinaryAccountId: 'a', seats: [], runtimeAvailable: true }
              : { content: '' },
        ),
      ),
  );
  render(<AddReviewerSheet sessionId="chat" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  fireEvent.click(await screen.findByText('Choose account'));
  fireEvent.click(screen.getByText('Choose profile'));
  fireEvent.change(screen.getByLabelText('What should the reviewer check?'), {
    target: { value: 'Review this diff' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add reviewer & queue request' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer & queue request' }));
  await screen.findByText(/Choose a profile with the reviewer role/);
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(screen.getByText('Choose profile').closest('fieldset')).not.toBeDisabled();
});

it.each(['active', 'draft', 'draft-config'])(
  'unlocks rejected %s reviewer selections only after confirming no seat was saved',
  async (state) => {
    const config = {
      version: 2,
      revision: 1,
      state: state === 'draft-config' ? 'draft' : state,
      anchorSeatId: 'anchor',
      seats: [{ id: 'anchor', accountBinding: { accountId: 'a' } }],
    };
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      const path = String(url);
      if (path.startsWith('/api/symposium/profiles/'))
        return new Response(JSON.stringify({ definition: { role: 'reviewer' } }));
      if (path.endsWith('/status'))
        return new Response(JSON.stringify({ config, runtimeAvailable: true, seats: [] }));
      if (path.endsWith('/context-package')) return new Response(JSON.stringify({ content: '' }));
      if (state === 'draft-config' && path.endsWith('/selection'))
        return new Response(JSON.stringify({ binding: { accountId: 'a', model: 'luna' } }));
      return new Response(
        JSON.stringify({ error: 'Selected model is unavailable', seatMutation: 'not-started' }),
        { status: 400 },
      );
    });
    render(<AddReviewerSheet sessionId="chat" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
    fireEvent.click(await screen.findByText('Choose account'));
    fireEvent.click(screen.getByText('Choose profile'));
    fireEvent.change(screen.getByLabelText('What should the reviewer check?'), {
      target: { value: 'Review diff' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add reviewer & queue request' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add reviewer & queue request' }));
    await screen.findByText(/Selected model is unavailable/);
    await waitFor(() =>
      expect(screen.getByText('Choose account').closest('fieldset')).not.toBeDisabled(),
    );
    expect(screen.getByLabelText('What should the reviewer check?')).toBeEnabled();
  },
);

it('keeps a lost mutation response frozen when a temporarily absent seat may commit later', async () => {
  const config = {
    version: 2,
    revision: 1,
    state: 'active',
    anchorSeatId: 'anchor',
    seats: [{ id: 'anchor', accountBinding: { accountId: 'a' } }],
  };
  let lateSeat = '';
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/symposium/profiles/'))
      return new Response(JSON.stringify({ definition: { role: 'reviewer' } }));
    if (path.endsWith('/status'))
      return new Response(JSON.stringify({ config, runtimeAvailable: true, seats: [] }));
    if (path.endsWith('/context-package')) return new Response(JSON.stringify({ content: '' }));
    lateSeat = JSON.parse(String(init?.body)).seatId;
    throw new Error('Response lost while mutation may still be running');
  });
  render(<AddReviewerSheet sessionId="chat" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  fireEvent.click(await screen.findByText('Choose account'));
  fireEvent.click(screen.getByText('Choose profile'));
  fireEvent.change(screen.getByLabelText('What should the reviewer check?'), {
    target: { value: 'Frozen diff' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add reviewer & queue request' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer & queue request' }));
  await screen.findByText(/Response lost/);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add reviewer & queue request' })).toBeDisabled(),
  );
  expect(config.seats).toHaveLength(1);
  expect(screen.getByLabelText('What should the reviewer check?')).toBeDisabled();
  config.revision++;
  config.seats.push({ id: lateSeat, accountBinding: { accountId: 'a' } });
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  expect(screen.getByLabelText('What should the reviewer check?')).toBeDisabled();
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/seats/revise')),
  ).toHaveLength(1);
});

it('explains read-only review and the separate approval and send steps before setup', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ config: null, seats: [], runtimeAvailable: false })),
  );
  render(<AddReviewerSheet sessionId="chat" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  expect(await screen.findByRole('heading', { name: 'Add an AI reviewer' })).toBeTruthy();
  expect(screen.getByText(/A reviewer checks your work and returns findings/)).toBeTruthy();
  expect(screen.getByText(/Approve the request, then send it/)).toBeTruthy();
  expect(screen.getByRole('heading', { name: '1. Choose your reviewer' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: '2. Set the review request' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: '3. Confirm sharing' })).toBeTruthy();
});

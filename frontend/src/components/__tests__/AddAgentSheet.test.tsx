// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { AddAgentSheet } from '../AddReviewerSheet';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: ({ onChange }: { onChange: (value: unknown) => void }) => (
    <button onClick={() => onChange({ accountId: 'a', model: 'luna', reasoningEffort: 'medium' })}>
      Choose account
    </button>
  ),
}));
vi.mock('../SymposiumProfilePicker', () => ({
  SymposiumProfilePicker: ({
    onChange,
    value,
  }: {
    onChange: (value: unknown) => void;
    value: { profileId: string; revision: number } | null;
  }) => (
    <>
      <output aria-label="Selected profile">
        {value ? `${value.profileId}:${value.revision}` : 'Custom guidance'}
      </output>
      <button onClick={() => onChange({ profileId: 'writer', revision: 2 })}>
        Load saved profile
      </button>
      <button onClick={() => onChange({ profileId: 'writer', revision: 3 })}>
        Load newer saved profile
      </button>
    </>
  ),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function mockRequests({ draft = false, failDelivery = false } = {}) {
  const config = {
    version: 2,
    revision: 1,
    state: draft ? 'draft' : 'active',
    anchorSeatId: 'anchor',
    seats: [{ id: 'anchor', accountBinding: { accountId: 'a' } }],
  };
  let failed = false;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/symposium/profiles/'))
      return new Response(
        JSON.stringify({
          definition: {
            name: 'Writer',
            role: 'research',
            instructions: 'Write a report',
            expectedOutput: 'A report',
            acceptanceCriteria: ['Cite evidence'],
            modelPolicyRole: 'writer',
          },
        }),
      );
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
    if (path.endsWith('/selection'))
      return new Response(JSON.stringify({ binding: { accountId: 'a', model: 'luna' } }));
    if (path.endsWith('/seats/revise')) {
      const body = JSON.parse(String(init?.body));
      config.seats.push({ id: body.seatId, accountBinding: { accountId: 'a' } });
      return new Response(JSON.stringify(config));
    }
    if (path.endsWith('/config'))
      return new Response(JSON.stringify(JSON.parse(String(init?.body)).config));
    if (path.endsWith('/activate'))
      return new Response(JSON.stringify({ ...config, state: 'active' }));
    if (path.endsWith('/deliveries') && failDelivery && !failed) {
      failed = true;
      return new Response(JSON.stringify({ error: 'Queue unavailable' }), { status: 503 });
    }
    return new Response(JSON.stringify({}));
  });
}
async function fill() {
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  fireEvent.click(await screen.findByText('Choose account'));
  for (const [label, value] of [
    ['Agent name', 'Analyst'],
    ['Agent instructions', 'Investigate the supplied data'],
    ['Agent expected output', 'An evidence summary'],
    ['Agent acceptance criteria', 'Cite sources\nShow assumptions'],
    ['Initial message', 'Start with this question'],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add agent and queue message' })).toBeEnabled(),
  );
}
it.each([false, true])(
  'creates a custom agent without catalog writes and preserves explicit authority (draft=%s)',
  async (draft) => {
    mockRequests({ draft });
    render(<AddAgentSheet sessionId="chat" />);
    await fill();
    expect(screen.getByLabelText('Context package')).toHaveValue('independent');
    fireEvent.change(screen.getByLabelText('Agent permissions'), { target: { value: 'write' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add agent and queue message' }));
    await screen.findByText(/Agent added/);
    const calls = vi.mocked(apiFetch).mock.calls;
    const mutation = calls.find(([url]) =>
      String(url).endsWith(draft ? '/config' : '/seats/revise'),
    )!;
    const payload = JSON.parse(String(mutation[1]?.body));
    const seat = draft ? payload.config.seats.at(-1) : payload;
    expect(seat).toMatchObject({
      name: 'Analyst',
      role: 'agent',
      systemPrompt: 'Investigate the supplied data',
      expectedOutput: 'An evidence summary',
      acceptanceCriteria: ['Cite sources', 'Show assumptions'],
      authorityRequest: { filesystem: 'write', tools: 'write', network: 'restricted' },
      reasoningEffort: 'medium',
    });
    expect(seat.profileSelection).toBeUndefined();
    expect(
      calls.some(
        ([url]) => String(url).includes('/profiles') || String(url).endsWith('/context-turns'),
      ),
    ).toBe(false);
    const queued = calls.find(([url]) => String(url).endsWith('/deliveries'))!;
    expect(JSON.parse(String(queued[1]?.body)).originalContent).toBe(
      'Agent request:\nStart with this question',
    );
  },
);
it('loads a versioned profile as editable guidance with independent session permissions', async () => {
  mockRequests();
  render(<AddAgentSheet sessionId="chat" />);
  await fill();
  fireEvent.click(screen.getByText('Load saved profile'));
  await waitFor(() => expect(screen.getByLabelText('Agent name')).toHaveValue('Writer'));
  expect(screen.getByLabelText('Agent permissions')).toHaveValue('read');
  expect(screen.getByLabelText('Agent role')).toHaveValue('research');
  fireEvent.change(screen.getByLabelText('Agent instructions'), {
    target: { value: 'Write a shorter report' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add agent and queue message' }));
  await screen.findByText(/Agent added/);
  const mutation = vi
    .mocked(apiFetch)
    .mock.calls.find(([url]) => String(url).endsWith('/seats/revise'))!;
  expect(JSON.parse(String(mutation[1]?.body))).toMatchObject({
    name: 'Writer',
    role: 'research',
    systemPrompt: 'Write a shorter report',
  });
  expect(JSON.parse(String(mutation[1]?.body)).profileSelection).toBeUndefined();
});
it('retries a failed queue using the same admitted custom seat and frozen message', async () => {
  mockRequests({ failDelivery: true });
  render(<AddAgentSheet sessionId="chat" />);
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Add agent and queue message' }));
  await screen.findByText(/Queue unavailable/);
  expect(screen.getByLabelText('Agent instructions')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add agent and queue message' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add agent and queue message' }));
  await screen.findByText(/Agent added/);
  const calls = vi.mocked(apiFetch).mock.calls;
  expect(calls.filter(([url]) => String(url).endsWith('/seats/revise'))).toHaveLength(1);
  const queued = calls
    .filter(([url]) => String(url).endsWith('/deliveries'))
    .map(([, init]) => JSON.parse(String(init?.body)));
  expect(queued[1]).toEqual(queued[0]);
});

it('locks copied guidance during a delayed profile response and permits edits after the copy finishes', async () => {
  mockRequests();
  const normalRequest = vi.mocked(apiFetch).getMockImplementation()!;
  let resolveProfile!: (response: Response) => void;
  const pendingProfile = new Promise<Response>((resolve) => {
    resolveProfile = resolve;
  });
  vi.mocked(apiFetch).mockImplementation((url, init) =>
    String(url).startsWith('/api/symposium/profiles/') ? pendingProfile : normalRequest(url, init),
  );
  render(<AddAgentSheet sessionId="chat" />);
  await fill();
  fireEvent.click(screen.getByText('Load saved profile'));
  await screen.findByText('Loading saved guidance…');
  for (const label of [
    'Agent name',
    'Agent role',
    'Agent instructions',
    'Agent expected output',
    'Agent acceptance criteria',
  ])
    expect(screen.getByLabelText(label)).toBeDisabled();
  expect(screen.getByLabelText('Agent instructions')).toHaveValue('Investigate the supplied data');
  expect(screen.getByLabelText('Initial message')).toBeEnabled();
  resolveProfile(
    new Response(
      JSON.stringify({
        definition: {
          name: 'Writer',
          role: 'research',
          instructions: 'Write a report',
          expectedOutput: 'A report',
          acceptanceCriteria: ['Cite evidence'],
          modelPolicyRole: 'writer',
        },
      }),
    ),
  );
  await waitFor(() => expect(screen.getByLabelText('Agent instructions')).toBeEnabled());
  expect(screen.getByLabelText('Agent instructions')).toHaveValue('Write a report');
  await userEvent.clear(screen.getByLabelText('Agent instructions'));
  await userEvent.type(screen.getByLabelText('Agent instructions'), 'Write a shorter report');
  fireEvent.click(screen.getByRole('button', { name: 'Add agent and queue message' }));
  await screen.findByText(/Agent added/);
  const revised = vi
    .mocked(apiFetch)
    .mock.calls.find(([url]) => String(url).endsWith('/seats/revise'))!;
  expect(JSON.parse(String(revised[1]?.body)).systemPrompt).toBe('Write a shorter report');
});

it('clears a failed profile selection visibly before permitting the preserved custom guidance', async () => {
  mockRequests();
  const normalRequest = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((url, init) =>
    String(url).startsWith('/api/symposium/profiles/')
      ? Promise.reject(new Error('Profile unavailable'))
      : normalRequest(url, init),
  );
  render(<AddAgentSheet sessionId="chat" />);
  await fill();
  fireEvent.click(screen.getByText('Load saved profile'));
  await waitFor(() =>
    expect(screen.getByLabelText('Selected profile')).toHaveTextContent('Custom guidance'),
  );
  expect(screen.getByRole('alert')).toHaveTextContent(
    /Profile unavailable.*custom guidance.*kept/i,
  );
  expect(screen.getByLabelText('Agent instructions')).toHaveValue('Investigate the supplied data');
  expect(screen.getByLabelText('Agent instructions')).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Add agent and queue message' }));
  await screen.findByText(/Agent added/);
  const revised = vi
    .mocked(apiFetch)
    .mock.calls.find(([url]) => String(url).endsWith('/seats/revise'))!;
  expect(JSON.parse(String(revised[1]?.body))).toMatchObject({
    name: 'Analyst',
    systemPrompt: 'Investigate the supplied data',
  });
});

it('does not clear a newer pending profile selection when an older request fails', async () => {
  mockRequests();
  const normalRequest = vi.mocked(apiFetch).getMockImplementation()!;
  let failOlder!: (error: Error) => void;
  let resolveNewer!: (response: Response) => void;
  const older = new Promise<Response>((_, reject) => {
    failOlder = reject;
  });
  const newer = new Promise<Response>((resolve) => {
    resolveNewer = resolve;
  });
  vi.mocked(apiFetch).mockImplementation((url, init) =>
    String(url).endsWith('/writer/2')
      ? older
      : String(url).endsWith('/writer/3')
        ? newer
        : normalRequest(url, init),
  );
  render(<AddAgentSheet sessionId="chat" />);
  await fill();
  fireEvent.click(screen.getByText('Load saved profile'));
  fireEvent.click(screen.getByText('Load newer saved profile'));
  await act(async () => {
    failOlder(new Error('Older profile unavailable'));
    await older.catch(() => {});
  });
  await waitFor(() =>
    expect(screen.getByLabelText('Selected profile')).toHaveTextContent('writer:3'),
  );
  expect(screen.getByLabelText('Agent instructions')).toBeDisabled();
  expect(screen.queryByRole('alert')).toBeNull();
  resolveNewer(
    new Response(
      JSON.stringify({
        definition: {
          name: 'New writer',
          role: 'writer',
          instructions: 'Write the newest report',
          expectedOutput: 'Report',
          acceptanceCriteria: ['Cite evidence'],
          modelPolicyRole: 'writer',
        },
      }),
    ),
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Agent instructions')).toHaveValue('Write the newest report'),
  );
  expect(screen.getByLabelText('Selected profile')).toHaveTextContent('writer:3');
});

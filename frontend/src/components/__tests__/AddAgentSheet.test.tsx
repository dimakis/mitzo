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
  fireEvent.click(screen.getByRole('button', { name: 'Output and advanced guidance (optional)' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Use a saved profile' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Use a saved profile' }));
  fireEvent.click(screen.getByText('Load saved profile'));
  await screen.findByText('Loading saved guidance…');
  // Expand before loading so all fields can be checked while disabled.
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
  fireEvent.click(screen.getByRole('button', { name: 'Use a saved profile' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Use a saved profile' }));
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

it('groups configuration clearly and hides confirmation for the conversation account', async () => {
  mockRequests();
  render(<AddAgentSheet sessionId="session" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  fireEvent.click(await screen.findByText('Choose account'));
  for (const name of ['Guidance', 'Account and model', 'Access', 'Message and context']) {
    expect(screen.getByRole('heading', { name })).toBeInTheDocument();
  }
  expect(
    screen.queryByRole('textbox', { name: /Cross-account confirmation/ }),
  ).not.toBeInTheDocument();
});

it('explains a pending connection while runtime verification is still in flight', async () => {
  mockRequests();
  const normal = vi.mocked(apiFetch).getMockImplementation()!;
  let finish!: (response: Response) => void;
  const admission = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.mocked(apiFetch).mockImplementation((url, init) =>
    String(url).endsWith('/admissions/refresh') ? admission : normal(url, init),
  );
  render(<AddAgentSheet sessionId="session" />);
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Add agent and queue message' }));
  expect(
    await screen.findByText(/Connecting agent — checking its account and workspace access/),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Connecting agent…' })).toBeDisabled();
  await act(async () => finish(new Response(JSON.stringify({}))));
  expect(await screen.findByText(/Agent added/)).toBeInTheDocument();
});

it('adds an agent with only name and instructions while optional guidance stays collapsed', async () => {
  mockRequests();
  render(<AddAgentSheet sessionId="session" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  fireEvent.click(await screen.findByText('Choose account'));
  expect(screen.queryByLabelText('Agent role')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Agent expected output')).not.toBeInTheDocument();
  expect(screen.queryByText('Load saved profile')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Data analyst' } });
  fireEvent.change(screen.getByLabelText('Agent instructions'), {
    target: { value: 'Explain the provided data' },
  });
  fireEvent.change(screen.getByLabelText('Initial message'), { target: { value: 'Summarize it' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent and queue message' }));
  await screen.findByText(/Agent added/);
  const [, init] = vi
    .mocked(apiFetch)
    .mock.calls.find(([url]) => String(url).endsWith('/seats/revise'))!;
  const payload = JSON.parse(String(init?.body));
  expect(payload).toMatchObject({
    name: 'Data analyst',
    role: 'agent',
    systemPrompt: 'Explain the provided data',
  });
  expect(payload).not.toHaveProperty('expectedOutput');
  expect(payload).not.toHaveProperty('acceptanceCriteria');
});

it('allows an explicit add request from durable status without treating skipped verification as offline', async () => {
  mockRequests();
  const normal = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const response = await normal(url, init);
    if (String(url).endsWith('/status'))
      return new Response(
        JSON.stringify({
          ...(await response.json()),
          statusMode: 'durable',
          runtimeVerification: 'not_checked',
          runtimeAvailable: false,
        }),
      );
    return response;
  });
  render(<AddAgentSheet sessionId="session" />);
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Add agent and queue message' }));
  await screen.findByText(/Agent added/);
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.some(([url]) => String(url) === '/api/sessions/session/symposium'),
  ).toBe(false);
  expect(
    vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/seats/revise')),
  ).toBe(true);
});

it.each([true, false])(
  'distinguishes a proven pre-mutation refusal from an uncertain add outcome (proof=%s)',
  async (proof) => {
    mockRequests();
    const normal = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, init) =>
      String(url).endsWith('/seats/revise')
        ? new Response(
            JSON.stringify({
              error: 'Host unavailable',
              ...(proof ? { seatMutation: 'not-started' } : {}),
            }),
            { status: 503 },
          )
        : normal(url, init),
    );
    render(<AddAgentSheet sessionId="session" />);
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Add agent and queue message' }));
    const alert = await screen.findByRole('alert');
    if (proof)
      expect(alert).toHaveTextContent(
        'Couldn’t connect this agent. Your choices are still in this form; no message was sent.',
      );
    else expect(alert).not.toHaveTextContent('no message was sent');
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/seats/revise')),
    ).toHaveLength(1);
  },
);

it('reports unsupported saved status without falling back to physical checks', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
  );
  render(<AddAgentSheet sessionId="session" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This server does not support saved agent status',
  );
  expect(vi.mocked(apiFetch).mock.calls.map(([url]) => url)).toEqual([
    '/api/sessions/session/symposium/status',
  ]);
});

it('does not claim no message was sent after delivery creation was attempted', async () => {
  mockRequests();
  const normal = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (url, init) =>
    String(url).endsWith('/deliveries')
      ? new Response(
          JSON.stringify({ error: 'Queue outcome unknown', seatMutation: 'not-started' }),
          { status: 503 },
        )
      : normal(url, init),
  );
  render(<AddAgentSheet sessionId="session" />);
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Add agent and queue message' }));
  expect(await screen.findByRole('alert')).not.toHaveTextContent('no message was sent');
  expect(screen.queryByText(/Context not queued/)).not.toBeInTheDocument();
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/deliveries')),
  ).toHaveLength(1);
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentTaskProposalReview } from '../AgentTaskProposal';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../AgentTaskSettings', () => ({
  AgentTaskSettings: () => <p>Existing independent task execution settings</p>,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  sessionStorage.clear();
});
const identity = {
  proposalId: 'proposal-one',
  sessionId: 'chat',
  taskId: 'daily',
  expectedRevision: 4,
};
const definition = {
  name: 'Daily review',
  objective: '',
  profile: { profileId: 'reviewer', revision: 3, contentHash: 'a'.repeat(64) },
  execution: null,
  workspace: null,
  schedule: null,
  notificationPolicy: 'results',
  outputPolicy: 'session',
};
const proposal = {
  kind: 'task',
  ...identity,
  definition,
  state: 'pending',
  createdAt: 1,
  savedTask: null,
};
const saved = {
  taskId: 'daily',
  revision: 5,
  definition,
  configuration: { state: 'draft' },
  deleted: false,
  createdAt: '2026-10-17T00:00:00Z',
  updatedAt: '2026-10-17T00:00:00Z',
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function mock(rows: unknown[] = [proposal]) {
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    response(path.includes('profile-proposals') ? rows : { versions: [], drafts: [] }),
  );
}
it('loads the canonical owner proposal before opening the existing detailed task editor and never auto-saves', async () => {
  mock();
  render(<AgentTaskProposalReview identity={identity} versions={[]} />);
  await screen.findByLabelText('Task name');
  expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe(
    '/api/symposium/profile-proposals?sessionId=chat',
  );
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(document.querySelector('.symposium-profile-picker')).toBeNull();
  expect(screen.queryByText('Review exact task definition')).toBeNull();
});
it.each(['wrong session', 'wrong task', 'wrong revision', 'duplicate', 'missing', 'extra fields'])(
  'refuses %s canonical proposal data without opening an editor',
  async (change) => {
    const changed = {
      ...proposal,
      ...(change === 'wrong session'
        ? { sessionId: 'other' }
        : change === 'wrong task'
          ? { taskId: 'other' }
          : change === 'wrong revision'
            ? { expectedRevision: 5 }
            : change === 'extra fields'
              ? { grant: 'forged' }
              : {}),
    };
    mock(change === 'missing' ? [] : change === 'duplicate' ? [proposal, proposal] : [changed]);
    render(<AgentTaskProposalReview identity={identity} versions={[]} />);
    await screen.findByRole('alert');
    expect(screen.queryByLabelText('Task name')).toBeNull();
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  },
);
it('retains the frozen original request through unmount, revoked loading, reload and authorized retry', async () => {
  let original: string | undefined;
  let blocked = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'POST') {
      original ??= init.body as string;
      expect(init.body).toBe(original);
      return blocked ? response(saved) : response({ error: 'Operator revoked' }, 403);
    }
    return blocked ? response({ error: 'Operator revoked' }, 403) : response([proposal]);
  });
  const first = render(<AgentTaskProposalReview identity={identity} versions={[]} />);
  fireEvent.change(await screen.findByLabelText('Objective'), {
    target: { value: 'Reviewed intent' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
  await screen.findByText('Operator revoked');
  first.unmount();
  blocked = true;
  const second = render(<AgentTaskProposalReview identity={identity} versions={[]} />);
  await screen.findByRole('alert');
  expect(screen.queryByLabelText('Task name')).toBeNull();
  second.unmount();
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    init?.method === 'POST'
      ? response({ ...saved, definition: JSON.parse(original!).definition })
      : response([proposal]),
  );
  render(<AgentTaskProposalReview identity={identity} versions={[]} />);
  await screen.findByLabelText('Task name');
  fireEvent.click(screen.getByRole('button', { name: 'Retry task save' }));
  await screen.findByText(/Saved Daily review/);
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes.at(-1)![1]!.body).toBe(original);
  expect(JSON.parse(original!)).toMatchObject({
    sessionId: 'chat',
    taskId: 'daily',
    expectedRevision: 4,
    kind: 'task',
  });
});
it('aborts a stale loader on navigation and does not display its late result', async () => {
  let resolve!: (value: Response) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(apiFetch).mockImplementation((_, init) => {
    signal = init?.signal as AbortSignal;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const view = render(<AgentTaskProposalReview identity={identity} versions={[]} />);
  await waitFor(() => expect(signal).toBeDefined());
  view.unmount();
  expect(signal!.aborted).toBe(true);
  resolve(response([proposal]));
  await Promise.resolve();
  expect(screen.queryByLabelText('Task name')).toBeNull();
});
it('shows the exact original saved receipt on reload without resaving or reading the current task head', async () => {
  mock([{ ...proposal, state: 'saved', savedTask: saved }]);
  render(<AgentTaskProposalReview identity={identity} versions={[]} />);
  await screen.findByText(/Saved Daily review · task daily · revision 5/);
  expect(screen.queryByLabelText('Task name')).toBeNull();
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.every(([path, init]) => path.includes('profile-proposals') && !init?.method),
  ).toBe(true);
});

it('aborts an unmounted discard request and retains review input until its owner response is confirmed', async () => {
  let discardSignal: AbortSignal | undefined;
  let resolve!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation((path, init) => {
    if (init?.method === 'POST') {
      discardSignal = init.signal as AbortSignal | undefined;
      return new Promise((done) => {
        resolve = done;
      });
    }
    return Promise.resolve(response([proposal]));
  });
  const view = render(<AgentTaskProposalReview identity={identity} versions={[]} />);
  fireEvent.change(await screen.findByLabelText('Objective'), {
    target: { value: 'Retained review' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Discard task proposal' }));
  view.unmount();
  expect(discardSignal?.aborted).toBe(true);
  resolve(response({ ...proposal, state: 'discarded' }));
  await Promise.resolve();
  expect(sessionStorage.getItem('mitzo-task-proposal-review:chat:proposal-one')).toContain(
    'Retained review',
  );
});

it('announces one validated saved receipt to the Library owner and preserves that receipt across catalog refreshes', async () => {
  mock([{ ...proposal, state: 'saved', savedTask: saved }]);
  const onSaved = vi.fn();
  const view = render(
    <AgentTaskProposalReview identity={identity} versions={[]} onSaved={onSaved} />,
  );
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(onSaved).toHaveBeenCalledWith(saved);
  view.rerender(<AgentTaskProposalReview identity={identity} versions={[]} onSaved={onSaved} />);
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
});

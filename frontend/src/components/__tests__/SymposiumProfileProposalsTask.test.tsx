// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentTaskDefinition, AgentTaskRecord } from '@mitzo/protocol';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumProfileProposals } from '../SymposiumProfileProposals';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../AgentTaskSettings', () => ({
  AgentTaskSettings: () => <p>Independent task execution settings</p>,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  sessionStorage.clear();
});
const definition: AgentTaskDefinition = {
  name: 'Morning review',
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
  proposalId: 'task-proposal',
  taskId: 'morning',
  expectedRevision: 0,
  definition,
  state: 'pending',
};
const record = (value = definition, revision = 1): AgentTaskRecord => ({
  taskId: 'morning',
  revision,
  definition: value,
  configuration: { state: 'draft' },
  deleted: false,
  createdAt: '2026-10-17T10:00:00Z',
  updatedAt: '2026-10-17T10:00:00Z',
});
function mock(
  save: (input: Record<string, unknown>) => unknown = () => record(),
  rows = [proposal],
) {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'POST')
      return new Response(JSON.stringify(save(JSON.parse(init.body as string))));
    return new Response(
      JSON.stringify(
        path.includes('profile-proposals')
          ? rows
          : path === '/api/agent-library'
            ? { versions: [], drafts: [] }
            : [],
      ),
    );
  });
}
it('reviews task draft and exact profile pin before explicit save, then reports exact receipt', async () => {
  mock();
  render(<SymposiumProfileProposals sessionId="chat" pendingOnly />);
  await screen.findByLabelText('Task name');
  expect(screen.getByText(/Profile r3/)).toBeTruthy();
  expect(screen.getByText(/Nothing is saved as a task yet/)).toBeTruthy();
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Save task', exact: true }));
  const status = await screen.findByRole('status');
  expect(status.textContent).toContain('Saved Morning review · task morning · revision 1');
  expect(within(status).getByRole('link', { name: 'Open Library task' }).getAttribute('href')).toBe(
    '/agent-library?task=morning',
  );
  const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(call[0]).toBe('/api/symposium/profile-proposals/task-proposal/save');
  expect(JSON.parse(call[1]!.body as string)).toEqual({
    sessionId: 'chat',
    kind: 'task',
    taskId: 'morning',
    expectedRevision: 0,
    definition,
  });
});
it('retains invalid schedule input and shows validation without a save', async () => {
  mock();
  render(<SymposiumProfileProposals sessionId="chat" pendingOnly />);
  fireEvent.change(await screen.findByLabelText('Schedule'), { target: { value: 'cron' } });
  fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: 'tomorrow' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save task', exact: true }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/five-field cron/);
  expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('tomorrow');
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it('retains reviewed edits and identical retry input after a failed save', async () => {
  let attempts = 0;
  mock((input) => {
    if (++attempts === 1) throw Error('Owner unavailable');
    return record(input.definition as AgentTaskDefinition);
  });
  render(<SymposiumProfileProposals sessionId="chat" pendingOnly />);
  fireEvent.change(await screen.findByLabelText('Objective'), {
    target: { value: 'Review the accepted report.' },
  });
  const save = screen.getByRole('button', { name: 'Save task', exact: true });
  fireEvent.click(save);
  await screen.findByText('Owner unavailable');
  expect(screen.queryByText(/Saved Morning review/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry task save' }));
  await screen.findByText(/Saved Morning review/);
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes[1][1]!.body).toBe(writes[0][1]!.body);
});
it.each(['wrong task', 'wrong revision', 'wrong definition'])(
  'rejects %s save receipts',
  async (mismatch) => {
    mock(() => ({
      ...record(),
      ...(mismatch === 'wrong task'
        ? { taskId: 'other' }
        : mismatch === 'wrong revision'
          ? { revision: 2 }
          : { definition: { ...definition, objective: 'Unreviewed change' } }),
    }));
    render(<SymposiumProfileProposals sessionId="chat" pendingOnly />);
    await screen.findByLabelText('Task name');
    fireEvent.click(screen.getByRole('button', { name: 'Save task', exact: true }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/receipt/);
    expect(screen.queryByText(/Saved Morning review/)).toBeNull();
  },
);
it('keeps task review disabled while ordinary conversation authority is uncertain', async () => {
  mock();
  render(<SymposiumProfileProposals sessionId="chat" pendingOnly disabled />);
  await screen.findByLabelText('Task name');
  expect(
    screen.getByRole('button', { name: 'Save task', exact: true }).closest('fieldset')!.disabled,
  ).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Discard task proposal' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await waitFor(() =>
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false),
  );
});
it('recovers the exact saved task receipt after reloading its conversation', async () => {
  mock(undefined, [{ ...proposal, state: 'saved', savedTask: record() } as typeof proposal]);
  render(<SymposiumProfileProposals sessionId="chat" pendingOnly />);
  expect((await screen.findByRole('status')).textContent).toContain('task morning · revision 1');
  expect(screen.queryByRole('button', { name: 'Save task', exact: true })).toBeNull();
});
it('recovers the original reviewed save input after reload following an uncertain failure', async () => {
  mock(() => {
    throw Error('Receipt unavailable');
  });
  const first = render(<SymposiumProfileProposals sessionId="chat" pendingOnly />);
  fireEvent.change(await screen.findByLabelText('Objective'), {
    target: { value: 'Retain this reviewed edit' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save task', exact: true }));
  await screen.findByText('Receipt unavailable');
  const original = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')![1]!
    .body;
  first.unmount();
  mock((input) => record(input.definition as AgentTaskDefinition));
  render(<SymposiumProfileProposals sessionId="chat" pendingOnly />);
  expect(((await screen.findByLabelText('Objective')) as HTMLTextAreaElement).value).toBe(
    'Retain this reviewed edit',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry task save' }));
  await screen.findByText(/Saved Morning review/);
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes.at(-1)![1]!.body).toBe(original);
});
it('cancels waiting for a save and retains its exact retry identity without accepting a late receipt', async () => {
  let resolve!: (response: Response) => void;
  mock();
  const base = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((path, init) =>
    init?.method === 'POST'
      ? new Promise((done) => {
          resolve = done;
        })
      : base(path, init),
  );
  render(<SymposiumProfileProposals sessionId="chat" pendingOnly />);
  await screen.findByLabelText('Task name');
  fireEvent.click(screen.getByRole('button', { name: 'Save task', exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel save wait' }));
  resolve(new Response(JSON.stringify(record())));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry task save' })).toBeTruthy());
  expect(screen.queryByText(/Saved Morning review/)).toBeNull();
  expect(screen.getByLabelText('Objective').closest('fieldset')!.disabled).toBe(true);
});
it.each([400, 404, 409])(
  'unlocks retained review after definitive owner rejection %s',
  async (status) => {
    mock();
    const read = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation((path, init) =>
      init?.method === 'POST'
        ? Promise.resolve(
            new Response(JSON.stringify({ error: 'Owner rejected this save' }), { status }),
          )
        : read(path, init),
    );
    render(<SymposiumProfileProposals sessionId="chat" pendingOnly />);
    await screen.findByLabelText('Task name');
    fireEvent.click(screen.getByRole('button', { name: 'Save task', exact: true }));
    await screen.findByText(/Owner rejected this save/);
    expect(screen.getByLabelText('Objective').closest('fieldset')!.disabled).toBe(false);
    expect(
      (screen.getByRole('button', { name: 'Discard task proposal' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByRole('button', { name: 'Retry task save' })).toBeNull();
  },
);
it('retains partial task fields without throwing while the exact definition disclosure is mounted', async () => {
  mock();
  render(<SymposiumProfileProposals sessionId="chat" pendingOnly />);
  fireEvent.change(await screen.findByLabelText('Task name'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'cron' } });
  fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '0 7 *' } });
  expect((screen.getByLabelText('Task name') as HTMLInputElement).value).toBe('');
  expect(screen.getByText('Review exact task definition')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save task', exact: true }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/five-field cron/);
});

it('retains the original reviewed save after403 because owner effects may already have committed', async () => {
  mock();
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((path, init) =>
    init?.method === 'POST'
      ? Promise.resolve(
          new Response(JSON.stringify({ error: 'Authority expired after owner response' }), {
            status: 403,
          }),
        )
      : read(path, init),
  );
  render(<SymposiumProfileProposals sessionId="chat" pendingOnly />);
  await screen.findByLabelText('Task name');
  fireEvent.click(screen.getByRole('button', { name: 'Save task', exact: true }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Authority expired after owner response',
  );
  expect(screen.getByLabelText('Objective').closest('fieldset')!.disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Retry task save' })).toBeTruthy();
});

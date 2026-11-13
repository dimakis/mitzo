// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as renderView, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { SessionLaunchCards, SessionLaunchOrigin } from '../SessionLaunchCards';
import { apiFetch } from '../../lib/api-fetch';
import type { SessionLaunchConfig, SessionLaunchRecord } from '@mitzo/protocol';
import { downloadFile } from '../../lib/share-file';
import { telosSessionLaunchFixture } from '../../test-utils/telos-session-launch-fixture';
vi.mock('../../lib/share-file', () => ({ downloadFile: vi.fn(), shareFile: vi.fn() }));

const render = (children: ReactNode) => renderView(children, { wrapper: MemoryRouter });

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn(), AUTH_LOST_EVENT: 'mitzo:auth-lost' }));
vi.mock('../SessionLaunchConfigEditor', () => ({
  SessionLaunchConfigEditor: ({
    configuration,
    onChange,
  }: {
    configuration: SessionLaunchConfig;
    onChange(configuration: SessionLaunchConfig): void;
  }) => (
    <label>
      Model
      <input
        value={configuration.runtime.account!.model}
        onChange={(e) =>
          onChange({
            ...configuration,
            runtime: {
              ...configuration.runtime,
              account: { ...configuration.runtime.account!, model: e.target.value },
            },
          })
        }
      />
    </label>
  ),
}));
const configuration: SessionLaunchConfig = {
  version: 1,
  runtime: {
    version: 1,
    account: { accountId: 'account', model: 'gpt-6.1-sol', reasoningEffort: 'high' },
    agentProfile: null,
    execution: { location: 'local', targetId: 'mac' },
  },
  mode: 'agent',
  isolation: true,
  repositoryWorkspaceId: null,
  contextBlocks: [],
  extraTools: [],
};
const proposal: SessionLaunchRecord = {
  proposalId: 'proposal',
  requestId: 'request',
  sourceSessionId: 'origin',
  title: 'Approval notifications',
  prompt: 'Fix approval routing',
  configuration,
  revision: 1,
  state: 'pending',
  childSessionId: null,
  createdAt: 1793959200000,
  updatedAt: 1793959200000,
};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('reviews without starting, then submits explicit edited approval and default choice', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ ...proposal, state: 'running', childSessionId: 'child' })),
  );
  const onUpdate = vi.fn();
  render(
    <>
      <textarea aria-label="Draft" defaultValue="Keep my draft" />
      <SessionLaunchCards requests={[proposal]} onUpdate={onUpdate} />
    </>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review new session' }));
  expect(apiFetch).not.toHaveBeenCalled();
  expect(screen.getByText('Session settings').closest('details')?.open).toBe(false);
  expect(screen.getByRole('button', { name: 'Approve & start' }).closest('fieldset')).toBeNull();
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Notifications' } });
  fireEvent.change(screen.getByLabelText('Handoff prompt'), {
    target: { value: 'Reviewed handoff' },
  });
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'edited-model' } });
  fireEvent.click(screen.getByLabelText('Save configuration as default'));
  fireEvent.click(screen.getByRole('button', { name: 'Approve & start' }));
  await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  const [path, init] = vi.mocked(apiFetch).mock.calls[0];
  expect(path).toBe('/api/session-launch/requests/proposal/approve');
  expect(JSON.parse(init!.body as string)).toEqual({
    expectedRevision: 1,
    title: 'Notifications',
    prompt: 'Reviewed handoff',
    configuration: {
      ...configuration,
      runtime: {
        ...configuration.runtime,
        account: { ...configuration.runtime.account, model: 'edited-model' },
      },
    },
    saveAsDefault: true,
  });
  expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('Keep my draft');
});
it('shows compact linked receipt with shared svg icon and accurate startup state', () => {
  const { container } = render(
    <SessionLaunchCards
      requests={[{ ...proposal, state: 'created', childSessionId: 'child' }]}
      onUpdate={vi.fn()}
    />,
  );
  expect(screen.getByRole('link', { name: 'Open chat' }).getAttribute('href')).toBe('/chat/child');
  expect(screen.getByRole('status').textContent).toBe('Created · start not yet confirmed');
  expect(container.querySelector('[data-icon="arrowUpRight"]')).toBeTruthy();
});
it('saves retained Markdown through the shared authenticated file actions', async () => {
  vi.mocked(downloadFile).mockResolvedValue(true);
  render(<SessionLaunchCards requests={[proposal]} onUpdate={vi.fn()} />);
  expect(screen.getByRole('group', { name: 'Handover' }).textContent).toContain('Handover.md');
  fireEvent.click(screen.getByRole('button', { name: 'File options' }));
  fireEvent.click(screen.getByRole('button', { name: 'Download file' }));
  await waitFor(() =>
    expect(downloadFile).toHaveBeenCalledWith('/api/session-launch/requests/proposal/handover.md'),
  );
  expect(apiFetch).not.toHaveBeenCalled();
});
it('keeps definite preflight refusals editable without another request check', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        error: 'Choose a compatible profile.',
        code: 'session_launch_preflight_refused',
        effectStatus: 'not_started',
      }),
      { status: 409 },
    ),
  );
  render(<SessionLaunchCards requests={[proposal]} onUpdate={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review new session' }));
  fireEvent.change(screen.getByLabelText('Handoff prompt'), {
    target: { value: 'Keep exact handover' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Approve & start' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Approve & start' }).hasAttribute('disabled')).toBe(
    false,
  );
  expect(screen.queryByRole('button', { name: 'Check request' })).toBeNull();
  expect((screen.getByLabelText('Handoff prompt') as HTMLTextAreaElement).value).toBe(
    'Keep exact handover',
  );
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'corrected-model' } });
  expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('corrected-model');
  expect(apiFetch).toHaveBeenCalledTimes(1);
});
it('explains unsupported context before approval while preserving the handover', () => {
  render(
    <SessionLaunchCards
      requests={[
        {
          ...proposal,
          configuration: { ...configuration, contextBlocks: ['named-context'] },
        },
      ]}
      onUpdate={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review new session' }));
  expect(screen.getByText(/Put the handover text in Handoff prompt/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Approve & start' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect((screen.getByLabelText('Handoff prompt') as HTMLTextAreaElement).value).toBe(
    proposal.prompt,
  );
  expect(apiFetch).not.toHaveBeenCalled();
});
it('resumes an interrupted startup only after an explicit action using its retained revision', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ ...proposal, state: 'created' })),
  );
  const onUpdate = vi.fn();
  render(
    <SessionLaunchCards
      requests={[{ ...proposal, state: 'uncertain', revision: 4 }]}
      onUpdate={onUpdate}
    />,
  );
  expect(apiFetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Resume startup' }));
  await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe('/api/session-launch/requests/proposal/resume');
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string)).toEqual({
    expectedRevision: 4,
  });
});
it('links the originating conversation by name', () => {
  render(<SessionLaunchOrigin origin={{ sessionId: 'origin', title: 'Session implementation' }} />);
  expect(screen.getByRole('link', { name: 'Session implementation' }).getAttribute('href')).toBe(
    '/chat/origin',
  );
});
it('cancels the proposal explicitly and retains review on a failed request', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ error: 'Request changed. Refresh and review again.' }), {
      status: 409,
    }),
  );
  render(<SessionLaunchCards requests={[proposal]} onUpdate={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review new session' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe('/api/session-launch/requests/proposal/cancel');
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string)).toEqual({
    expectedRevision: 1,
  });
});

it('releases a refused approval only after a fresh pending observation and retains edits', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Configuration unavailable' }), { status: 409 }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ...proposal, state: 'running', childSessionId: 'child' })),
    );
  const refresh = vi.fn();
  const view = render(<SessionLaunchCards requests={[proposal]} onUpdate={refresh} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review new session' }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My edited title' } });
  fireEvent.change(screen.getByLabelText('Handoff prompt'), {
    target: { value: 'Keep this handoff' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Approve & start' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Approve & start' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check request' }));
  expect(apiFetch).toHaveBeenCalledTimes(1);
  view.rerender(<SessionLaunchCards requests={[{ ...proposal }]} onUpdate={refresh} />);
  await screen.findByRole('button', { name: 'Approve & start' });
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('My edited title');
  expect((screen.getByLabelText('Handoff prompt') as HTMLTextAreaElement).value).toBe(
    'Keep this handoff',
  );
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'available-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Approve & start' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls[1][1]!.body as string)).toMatchObject({
    title: 'My edited title',
    prompt: 'Keep this handoff',
    configuration: { runtime: { account: { model: 'available-model' } } },
  });
});

it('uses router navigation and retains the mounted original draft when opening the child', () => {
  function Location() {
    return <output aria-label="Route">{useLocation().pathname}</output>;
  }
  render(
    <>
      <textarea aria-label="Draft" defaultValue="Keep this draft" />
      <SessionLaunchCards
        requests={[{ ...proposal, state: 'running', childSessionId: 'child' }]}
        onUpdate={vi.fn()}
      />
      <Location />
    </>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Open chat' }));
  expect(screen.getByLabelText('Route').textContent).toBe('/chat/child');
  expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('Keep this draft');
});

it('reviews the exact work and context in the originating dialog and creates without starting', async () => {
  const work = { ...proposal, ...telosSessionLaunchFixture() };
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ ...work, state: 'assigned', childSessionId: 'lead' })),
  );
  const onUpdate = vi.fn();
  render(<SessionLaunchCards requests={[work]} onUpdate={onUpdate} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review new session' }));
  expect(screen.getByRole('link', { name: 'Capability baseline' }).getAttribute('href')).toBe(
    '/todos/feature',
  );
  expect(screen.getByText('Feature lead')).toBeTruthy();
  expect(screen.getByText('Review work context')).toBeTruthy();
  expect(screen.getByText(work.telosReview.selection.brief.text)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve & start' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Approve & create' }));
  await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  const [path, init] = vi.mocked(apiFetch).mock.calls[0];
  expect(path).toBe('/api/session-launch/requests/proposal/approve');
  expect(JSON.parse(init!.body as string)).toEqual({
    expectedRevision: 1,
    title: proposal.title,
    prompt: proposal.prompt,
    configuration,
    saveAsDefault: false,
  });
});

it('reviews the named existing chat with locked settings and an explicit adoption action', async () => {
  const work = { ...proposal, ...telosSessionLaunchFixture() };
  work.telos.adoption = {
    conversationId: 'existing',
    title: 'Retained design discussion',
    workspaceId: 'a3eb433a-acf5-45a8-a629-3c6c6c3fb439',
    expectedEpoch: 0,
    custodyHash: 'd'.repeat(64),
  };
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ ...work, state: 'assigned', childSessionId: 'existing' })),
  );
  const onUpdate = vi.fn();
  render(<SessionLaunchCards requests={[work]} onUpdate={onUpdate} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review existing chat' }));
  expect(
    screen.getByRole('link', { name: 'Retained design discussion' }).getAttribute('href'),
  ).toBe('/chat/existing');
  expect(screen.queryByLabelText('Save configuration as default')).toBeNull();
  expect(screen.getByRole('button', { name: 'Approve & adopt' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve & create' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Approve & adopt' }));
  await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  const body = JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string);
  expect(body.configuration).toEqual(configuration);
  expect(body.saveAsDefault).toBe(false);
});

it('reviews safe release and keeps a refusal visible without claiming cancellation', async () => {
  const work = { ...proposal, ...telosSessionLaunchFixture(), state: 'uncertain' as const };
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ error: 'Original allocation exists; recover it.' }), {
      status: 409,
    }),
  );
  render(<SessionLaunchCards requests={[work]} onUpdate={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review release' }));
  expect(screen.getByRole('dialog', { name: 'Release unfinished reservation' })).toBeTruthy();
  expect(apiFetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Approve release' }));
  await waitFor(() =>
    expect(
      screen
        .getAllByRole('alert')
        .some((alert) => alert.textContent?.includes('Original allocation exists')),
    ).toBe(true),
  );
  expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe(
    '/api/session-launch/requests/proposal/release',
  );
  expect(screen.getByRole('status').textContent).toContain('unconfirmed');
});

it('keeps assigned readiness distinct from execution and offers recovery for uncertain work', () => {
  const work = { ...proposal, ...telosSessionLaunchFixture() };
  const view = render(
    <SessionLaunchCards
      requests={[{ ...work, state: 'assigned', childSessionId: 'lead' }]}
      onUpdate={vi.fn()}
    />,
  );
  expect(screen.getByRole('status').textContent).toBe('Created & assigned');
  expect(screen.getByText('Created a work chat')).toBeTruthy();
  expect(screen.queryByText('Started')).toBeNull();
  view.rerender(
    <SessionLaunchCards requests={[{ ...work, state: 'uncertain' }]} onUpdate={vi.fn()} />,
  );
  expect(screen.getByRole('status').textContent).toBe(
    'Assignment unconfirmed · check this request',
  );
  expect(screen.getByRole('button', { name: 'Recover creation' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Resume startup' })).toBeNull();
});

it('blocks work approval when retained context is missing or no longer matches the selected item', () => {
  const work = { ...proposal, ...telosSessionLaunchFixture() };
  work.telos.itemId = 'unreviewed-item';
  render(<SessionLaunchCards requests={[work]} onUpdate={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review new session' }));
  expect(screen.getByRole('button', { name: 'Approve & create' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByText(/Reviewed work context is unavailable/)).toBeTruthy();
  expect(apiFetch).not.toHaveBeenCalled();
});

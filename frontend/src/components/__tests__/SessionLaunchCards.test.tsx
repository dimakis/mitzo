// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as renderView, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { SessionLaunchCards, SessionLaunchOrigin } from '../SessionLaunchCards';
import { apiFetch } from '../../lib/api-fetch';
import type { SessionLaunchConfig, SessionLaunchRecord } from '@mitzo/protocol';

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
it('offers retained Markdown directly from the request without a temporary local path', () => {
  render(<SessionLaunchCards requests={[proposal]} onUpdate={vi.fn()} />);
  const link = screen.getByRole('link', { name: 'Download handover' });
  expect(link.getAttribute('href')).toBe('/api/session-launch/requests/proposal/handover.md');
  expect(link.hasAttribute('download')).toBe(true);
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

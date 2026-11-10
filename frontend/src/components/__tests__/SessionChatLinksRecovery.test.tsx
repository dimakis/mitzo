// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionChatLinks } from '../SessionChatLinks';
import { useSessionLaunch } from '../../hooks/useSessionLaunch';
import { apiFetch } from '../../lib/api-fetch';
import type { SessionLaunchRecord } from '@mitzo/protocol';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn(), AUTH_LOST_EVENT: 'mitzo:auth-lost' }));
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: { on: () => () => {}, onConnectionChange: () => () => {} },
}));
vi.mock('../../hooks/useSessionSearch', () => ({
  useSessionSearch: () => ({
    query: '',
    results: [],
    searching: false,
    active: false,
    error: null,
    setQuery: vi.fn(),
    clear: vi.fn(),
  }),
}));
vi.mock('../SessionLaunchConfigEditor', () => ({
  SessionLaunchConfigEditor: () => <p>Configuration editor</p>,
}));
const configuration = {
  version: 1,
  runtime: {
    version: 1,
    account: { accountId: 'account', model: 'luna-fixture' },
    agentProfile: null,
    execution: { location: 'local', targetId: 'mac' },
  },
  mode: 'ask',
  isolation: true,
  repositoryWorkspaceId: null,
  contextBlocks: [],
  extraTools: [],
};
function Harness() {
  const data = useSessionLaunch('source');
  return <SessionChatLinks sessionId="source" data={data} disabled={Boolean(data.error)} />;
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

it('keeps an unconfirmed start locked when the inspection read fails, then retries the same input only after a successful check', async () => {
  let inspectionFails = false;
  const writes: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'POST') {
      writes.push(String(init.body));
      if (writes.length === 1) {
        inspectionFails = true;
        throw new Error('Start unconfirmed');
      }
      return Response.json({ state: 'running' });
    }
    if (String(path).includes('/defaults')) return Response.json({ revision: 1, configuration });
    if (inspectionFails) throw new Error('Inspection unavailable');
    return Response.json({ requests: [], links: [] });
  });
  render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  await screen.findByRole('dialog');
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Retain identity' } });
  fireEvent.change(screen.getByLabelText('Handoff prompt'), {
    target: { value: 'Continue exactly once.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Approve & start' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Check request' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: /Check.*request/ }) as HTMLButtonElement).disabled,
    ).toBe(true),
  );
  expect(screen.queryByRole('button', { name: 'Retry start' })).toBeNull();
  expect(writes).toHaveLength(1);
  inspectionFails = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh links' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry start' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toBe(writes[0]);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it.each(['before persistence', 'lost response'])(
  'recovers an explicit new-chat start after %s without changing its identity or frozen input',
  async (failure) => {
    let records: SessionLaunchRecord[] = [];
    const writes: string[] = [];
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (init?.method === 'POST') {
        const body = String(init.body);
        writes.push(body);
        if (writes.length === 1) {
          if (failure === 'lost response')
            records = [
              {
                ...JSON.parse(body),
                proposalId: 'retained-proposal',
                state: 'running',
                revision: 2,
                childSessionId: 'child',
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ];
          throw new Error('The start response was not confirmed.');
        }
        return Response.json({ state: 'running' });
      }
      if (String(path).includes('/defaults')) return Response.json({ revision: 1, configuration });
      return Response.json({ requests: records, links: [] });
    });
    render(
      <MemoryRouter>
        <Harness />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Review recovery' } });
    fireEvent.change(screen.getByLabelText('Handoff prompt'), {
      target: { value: 'Continue exactly once.' },
    });
    fireEvent.click(screen.getByLabelText('Save configuration as default'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve & start' }));
    await screen.findByRole('alert');
    expect(writes).toHaveLength(1);
    expect(
      (screen.getByLabelText('Title').closest('fieldset') as HTMLFieldSetElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check request' }));
    if (failure === 'lost response') {
      await screen.findByRole('link', { name: 'Open chat' });
      expect(screen.queryByRole('button', { name: /Approve & start|Retry start/ })).toBeNull();
      expect(writes).toHaveLength(1);
    } else {
      const retry = await screen.findByRole('button', { name: 'Retry start' });
      expect(
        (screen.getByLabelText('Title').closest('fieldset') as HTMLFieldSetElement).disabled,
      ).toBe(true);
      fireEvent.click(retry);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(writes).toHaveLength(2);
      expect(writes[1]).toBe(writes[0]);
      expect(JSON.parse(writes[1])).toMatchObject({
        title: 'Review recovery',
        prompt: 'Continue exactly once.',
        saveAsDefault: true,
      });
    }
  },
);

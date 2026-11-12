// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionChatLinks } from '../SessionChatLinks';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn(), AUTH_LOST_EVENT: 'mitzo:auth-lost' }));
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
it('loads defaults without starting, then starts only with explicit reviewed input while retaining the original composer', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    init?.method === 'POST'
      ? Response.json({ state: 'running' })
      : Response.json({ revision: 1, configuration }),
  );
  const refresh = vi.fn();
  render(
    <MemoryRouter>
      <textarea aria-label="Original draft" defaultValue="Keep this unsent message" />
      <SessionChatLinks sessionId="source" data={{ requests: [], refresh }} disabled={false} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  await screen.findByRole('dialog');
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Review recovery' } });
  fireEvent.change(screen.getByLabelText('Handoff prompt'), {
    target: { value: 'Check the retained work.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Approve & start' }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  const [path, init] = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(path).toBe('/api/session-launch/requests/start');
  expect(JSON.parse(String(init?.body))).toMatchObject({
    sourceSessionId: 'source',
    title: 'Review recovery',
    prompt: 'Check the retained work.',
    configuration,
    saveAsDefault: false,
  });
  expect((screen.getByLabelText('Original draft') as HTMLTextAreaElement).value).toBe(
    'Keep this unsent message',
  );
});
it('confirms unlinking with no permission or conversation mutation', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ linked: false }));
  const refresh = vi.fn();
  render(
    <MemoryRouter>
      <SessionChatLinks
        sessionId="source"
        data={{
          requests: [],
          links: [{ sessionId: 'other', title: 'Recovery', available: true }],
          refresh,
        }}
        disabled={false}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Unlink Recovery' }));
  expect(apiFetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Unlink chat' }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/session-launch/links/source/other',
    expect.objectContaining({ method: 'DELETE' }),
  );
});

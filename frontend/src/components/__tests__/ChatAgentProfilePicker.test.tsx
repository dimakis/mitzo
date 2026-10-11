// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ChatAgentProfilePicker } from '../ChatAgentProfilePicker';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const version = {
  profileId: 'bob',
  revision: 3,
  contentHash: 'a'.repeat(64),
  definition: {
    name: 'Bob',
    descriptor: 'The architect',
    role: 'agent',
    instructions: 'Review assumptions.',
    expectedOutput: 'Decision brief',
    acceptanceCriteria: ['Evidence'],
    modelPolicyRole: 'agent',
  },
};
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
it('limits optional contributor guidance to roles supported by its execution route', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    response({
      drafts: [],
      versions: [
        { ...version, definition: { ...version.definition, role: 'reviewer' } },
        {
          ...version,
          profileId: 'writer',
          definition: { ...version.definition, name: 'Writer', role: 'coder' },
        },
      ],
    }),
  );
  render(
    <MemoryRouter>
      <ChatAgentProfilePicker
        sessionId={null}
        search=""
        updateSearchParams={false}
        allowedRoles={['coder']}
        onChange={vi.fn()}
      />
    </MemoryRouter>,
  );
  await screen.findByRole('option', { name: 'Writer · The architect · r3' });
  expect(screen.queryByRole('option', { name: 'Bob · The architect · r3' })).toBeNull();
});
it('keeps contributor guidance selection local to the dialog without changing the source chat', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ drafts: [], versions: [version] }));
  const change = vi.fn();
  function Screen() {
    return (
      <>
        <output aria-label="Source chat route">{useLocation().search}</output>
        <ChatAgentProfilePicker
          sessionId={null}
          search=""
          updateSearchParams={false}
          onChange={change}
        />
      </>
    );
  }
  render(
    <MemoryRouter initialEntries={['/chat/source?prompt=Keep+this']}>
      <Screen />
    </MemoryRouter>,
  );
  fireEvent.change(await screen.findByLabelText('Agent profile'), { target: { value: 'bob:3' } });
  expect(change).toHaveBeenLastCalledWith({ profileId: 'bob', revision: 3 }, undefined);
  expect(screen.getByLabelText('Source chat route').textContent).toBe('?prompt=Keep+this');
});
it.each(['bob', 'my agent'])(
  'selects the exact Library revision for catalog ID %s',
  async (profileId) => {
    vi.mocked(apiFetch).mockResolvedValue(
      response({ drafts: [], versions: [{ ...version, profileId }] }),
    );
    const change = vi.fn();
    render(
      <MemoryRouter>
        <ChatAgentProfilePicker
          sessionId={null}
          search={new URLSearchParams({ agentProfile: profileId, profileRevision: '3' }).toString()}
          onChange={change}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('option', { name: 'Bob · The architect · r3' });
    await waitFor(() => expect(change).toHaveBeenCalledWith({ profileId, revision: 3 }, undefined));
  },
);
it('blocks a missing explicit revision instead of using default behavior', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ drafts: [], versions: [version] }));
  const change = vi.fn();
  render(
    <MemoryRouter>
      <ChatAgentProfilePicker
        sessionId={null}
        search="agentProfile=bob&profileRevision=4"
        onChange={change}
      />
    </MemoryRouter>,
  );
  await screen.findByRole('alert');
  expect(change).toHaveBeenLastCalledWith(null, expect.stringMatching(/unavailable/i));
});
it('shows a running chat’s saved identity without permitting profile edits', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ agentProfile: version }));
  render(
    <MemoryRouter>
      <ChatAgentProfilePicker sessionId="chat-bob" search="" onChange={vi.fn()} />
    </MemoryRouter>,
  );
  await screen.findByText('Bob · The architect · r3');
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(apiFetch).toHaveBeenCalledWith('/api/sessions/chat-bob/meta');
});
it('allows an explicit return to ordinary Mitzo behavior for a new chat', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ drafts: [], versions: [version] }));
  const change = vi.fn();
  render(
    <MemoryRouter>
      <ChatAgentProfilePicker sessionId={null} search="" onChange={change} />
    </MemoryRouter>,
  );
  fireEvent.change(await screen.findByLabelText('Agent profile'), { target: { value: 'bob:3' } });
  expect(change).toHaveBeenLastCalledWith({ profileId: 'bob', revision: 3 }, undefined);
  fireEvent.change(screen.getByLabelText('Agent profile'), { target: { value: '' } });
  expect(change).toHaveBeenLastCalledWith(null, undefined);
});

it.each([
  ['', 'bob:3', { profileId: 'bob', revision: 3 }],
  ['agentProfile=bob&profileRevision=3', '', null],
] as const)(
  'retains a manual choice across responsive screen replacement (%s)',
  async (initial, choice, expected) => {
    vi.mocked(apiFetch).mockResolvedValue(response({ drafts: [], versions: [version] }));
    const change = vi.fn();
    function Screen({ layout }: { layout: string }) {
      const location = useLocation();
      return (
        <>
          <output aria-label="Chat route">{location.search}</output>
          <ChatAgentProfilePicker
            key={layout}
            sessionId={null}
            search={location.search}
            onChange={change}
          />
        </>
      );
    }
    const mounted = render(
      <MemoryRouter initialEntries={[`/chat?prompt=Keep+this&${initial}`]}>
        <Screen layout="desktop" />
      </MemoryRouter>,
    );
    await screen.findByRole('option', { name: 'Bob · The architect · r3' });
    fireEvent.change(screen.getByLabelText('Agent profile'), { target: { value: choice } });
    await waitFor(() => expect(change).toHaveBeenLastCalledWith(expected, undefined));
    mounted.rerender(
      <MemoryRouter initialEntries={[`/chat?prompt=Keep+this&${initial}`]}>
        <Screen layout="mobile" />
      </MemoryRouter>,
    );
    await screen.findByRole('option', { name: 'Bob · The architect · r3' });
    await waitFor(() =>
      expect(screen.getByLabelText('Agent profile')).toHaveProperty('value', choice),
    );
    expect(change).toHaveBeenLastCalledWith(expected, undefined);
    expect(screen.getByLabelText('Chat route').textContent).toContain('prompt=Keep+this');
  },
);

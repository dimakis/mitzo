// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

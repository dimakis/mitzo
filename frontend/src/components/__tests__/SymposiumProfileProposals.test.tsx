// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumProfileProposals } from '../SymposiumProfileProposals';
import { symposiumProfileTemplates } from '../../lib/symposium-profile-templates';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('exposes proposed recipe fields for editing before explicit save', async () => {
  const definition = symposiumProfileTemplates[1].definition;
  vi.mocked(apiFetch).mockImplementation(
    async (path, init) =>
      ({
        ok: true,
        json: async () =>
          init?.method
            ? {}
            : path.includes('profile-proposals')
              ? [{ proposalId: 'draft', suggestedProfileId: 'security', definition }]
              : [],
      }) as Response,
  );
  render(<SymposiumProfileProposals sessionId="chat" />);
  const template = await screen.findByLabelText('Reviewer template');
  expect((template as HTMLSelectElement).value).toBe('security');
  fireEvent.change(screen.getByLabelText('Skill references (one per line)'), {
    target: { value: 'risk-scan' },
  });
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  const save = screen.getByRole('button', { name: 'Save reusable profile' });
  // The proposal can render before its separate revision catalog is loaded.
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(save);
  await waitFor(() =>
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true),
  );
  const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(call[1]!.body as string).definition.recipe.skillRefs).toEqual(['risk-scan']);
});

it('shows loading feedback before an empty response, then explains how to create a draft', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(apiFetch).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<SymposiumProfileProposals sessionId="chat" />);
  expect(screen.getByRole('status').textContent).toBe('Loading profile drafts…');
  expect(screen.queryByText('No profile drafts in this chat yet.')).toBeNull();
  finish(new Response(JSON.stringify([])));
  await screen.findByText('No profile drafts in this chat yet.');
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByText(/Ask Mitzo to draft a reusable agent profile/)).toBeTruthy();
});

it('shows fetch errors instead of claiming there are no drafts', async () => {
  vi.mocked(apiFetch).mockRejectedValue(new Error('Connection unavailable'));
  render(<SymposiumProfileProposals sessionId="chat" />);
  expect((await screen.findByRole('alert')).textContent).toBe('Connection unavailable');
  expect(screen.queryByText('No profile drafts in this chat yet.')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});

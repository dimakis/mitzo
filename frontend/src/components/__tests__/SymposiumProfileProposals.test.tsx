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
  fireEvent.click(screen.getByRole('button', { name: 'Save reusable profile' }));
  await waitFor(() =>
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true),
  );
  const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(call[1]!.body as string).definition.recipe.skillRefs).toEqual(['risk-scan']);
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumProfileProposals } from '../SymposiumProfileProposals';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it.each(['seat', 'proposal'])(
  'preserves and edits a custom role in a %s reusable profile draft',
  async (source) => {
    const definition = {
      name: 'Domain expert',
      role: 'domain-specialist',
      instructions: 'Explain tradeoffs',
      expectedOutput: 'Recommendation',
      acceptanceCriteria: ['Cite evidence'],
      modelPolicyRole: 'domain-specialist',
    };
    vi.mocked(apiFetch).mockImplementation(
      async (url, init) =>
        new Response(
          JSON.stringify(
            init?.method
              ? {}
              : String(url).includes('profile-proposals')
                ? source === 'proposal'
                  ? [
                      {
                        proposalId: 'draft',
                        suggestedProfileId: 'specialist',
                        definition,
                        state: 'pending',
                      },
                    ]
                  : []
                : [],
          ),
        ),
    );
    render(
      <SymposiumProfileProposals
        sessionId="chat"
        seatSeed={
          source === 'seat'
            ? { seatId: 'custom', name: definition.name, role: definition.role }
            : null
        }
      />,
    );
    const role = await screen.findByLabelText('Role');
    expect(role).toHaveValue('domain-specialist');
    if (source === 'seat') {
      expect(screen.getByLabelText('Model policy role')).toHaveValue('domain-specialist');
      for (const [label, value] of [
        ['Profile ID', 'specialist'],
        ['Instructions', definition.instructions],
        ['Expected output', definition.expectedOutput],
        ['Acceptance criteria', 'Cite evidence'],
      ])
        fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    const save = screen.getByRole('button', { name: 'Save reusable profile' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.change(role, { target: { value: 'invalid role' } });
    expect(save).toBeDisabled();
    fireEvent.change(role, { target: { value: 'domain-editor' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true),
    );
    const saved = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(saved[1]?.body)).definition.role).toBe('domain-editor');
  },
);

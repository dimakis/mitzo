// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ReviewerSheetHost } from '../AddReviewerSheet';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../AccountModelPicker', () => ({ AccountModelPicker: () => <span>Choose account</span> }));
vi.mock('../SymposiumProfilePicker', () => ({
  SymposiumProfilePicker: () => <span>Saved profile</span>,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('opens add-agent setup with the exact Library profile but makes no activation request', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify(
          path.includes('/profiles/')
            ? {
                definition: {
                  name: 'Bob',
                  descriptor: 'The architect',
                  role: 'reviewer',
                  instructions: 'Challenge assumptions.',
                  expectedOutput: 'Decision brief',
                  acceptanceCriteria: ['Use evidence'],
                  modelPolicyRole: 'reviewer',
                },
              }
            : { config: null, runtimeAvailable: false, seats: [], ordinaryAccountId: 'work' },
        ),
      ),
  );
  render(
    <ReviewerSheetHost sessionId="existing-chat" initialProfile={{ profileId: 'bob', revision: 3 }}>
      <span>Existing primary chat</span>
    </ReviewerSheetHost>,
  );
  await screen.findByDisplayValue('Bob · The architect');
  expect(screen.getByDisplayValue('Challenge assumptions.')).toBeTruthy();
  expect(apiFetch).toHaveBeenCalledWith('/api/symposium/profiles/bob/3', undefined);
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

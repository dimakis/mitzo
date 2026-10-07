// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumPublicationSuggestions } from '../SymposiumPublicationSuggestions';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('surfaces durable handed-off publication suggestions through the generic artifact review entry', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => [
      {
        id: 'one',
        hash: 'a'.repeat(64),
        kind: 'publication',
        status: 'review_handed_off',
        seatName: 'Builder',
        accountId: 'api',
        model: 'test',
        input: {
          repositoryPath: '/sandbox/workspaces/mgmt',
          baseBranch: 'main',
          title: 'Publish fix',
          body: 'Exact suggested body',
          draft: true,
        },
      },
    ],
  } as Response);
  render(<SymposiumPublicationSuggestions sessionId="session" />);
  expect(await screen.findByText('Publish fix')).toBeTruthy();
  expect(screen.getByText('/sandbox/workspaces/mgmt')).toBeTruthy();
  expect(screen.getByText('Base branch: main')).toBeTruthy();
  expect(screen.getByText('Exact suggested body')).toBeTruthy();
  expect(screen.getByText('Draft pull request')).toBeTruthy();
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

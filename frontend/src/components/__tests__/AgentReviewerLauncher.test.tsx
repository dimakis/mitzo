// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentReviewerLauncher } from '../AgentReviewerLauncher';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('carries the chosen profile revision into an existing conversation without creating a seat', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({ sessions: [{ id: 'existing-chat', summary: 'Architecture decision' }] }),
    ),
  );
  render(
    <MemoryRouter>
      <AgentReviewerLauncher selection={{ profileId: 'bob', revision: 3 }} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Use as reviewer' }));
  await screen.findByRole('option', { name: 'Architecture decision' });
  fireEvent.change(screen.getByLabelText('Conversation'), { target: { value: 'existing-chat' } });
  const url = new URL(
    screen.getByRole('link', { name: 'Set up reviewer' }).getAttribute('href')!,
    'https://mitzo.example',
  );
  expect(url.pathname).toBe('/chat/existing-chat');
  expect(url.searchParams.get('reviewerProfile')).toBe('bob');
  expect(url.searchParams.get('reviewerRevision')).toBe('3');
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

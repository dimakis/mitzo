// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentLibrary } from '../AgentLibrary';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', async (original) => ({
  ...(await original<typeof import('../../lib/api-fetch')>()),
  apiFetch: vi.fn(),
}));
vi.mock('../../components/AgentTaskSettings', () => ({
  AgentTaskSettings: () => <p>Task execution settings</p>,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  sessionStorage.clear();
});
it('opens the exact Library task from its proposal receipt link', async () => {
  const definition = {
    name: 'Pinned morning task',
    objective: '',
    profile: { profileId: 'bob', revision: 3, contentHash: 'a'.repeat(64) },
    execution: null,
    workspace: null,
    schedule: null,
    notificationPolicy: 'results',
    outputPolicy: 'session',
  };
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify(
          path === '/api/agent-tasks'
            ? [
                {
                  taskId: 'morning',
                  revision: 2,
                  definition,
                  configuration: { state: 'draft' },
                  deleted: false,
                  createdAt: '2026-10-17T10:00:00Z',
                  updatedAt: '2026-10-17T10:00:00Z',
                },
              ]
            : path === '/api/agent-library'
              ? { drafts: [], versions: [] }
              : { tools: [] },
        ),
      ),
  );
  render(
    <MemoryRouter initialEntries={['/agent-library?task=morning']}>
      <AgentLibrary />
    </MemoryRouter>,
  );
  expect(((await screen.findByLabelText('Task name')) as HTMLInputElement).value).toBe(
    'Pinned morning task',
  );
  expect(screen.getByText('Saved task · revision 2')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Tasks & schedules' }).getAttribute('aria-selected')).toBe(
    'true',
  );
});

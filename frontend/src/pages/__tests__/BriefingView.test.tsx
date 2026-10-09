// @vitest-environment jsdom
import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { BriefingView } from '../BriefingView';
const fixtures = vi.hoisted(() => ({
  pending: vi.fn(),
  report: {
    date: '2026-10-09',
    revision: 'a'.repeat(64),
    generatedAt: '2026-10-09T07:00:00Z',
    filename: 'morning.md',
    path: '/morning.md',
    content:
      '# Briefing\n## Calendar updates\nChanged meeting\n' +
      Array.from(
        { length: 10 },
        (_, i) => `## ${i + 9}:30 Meeting ${i}\nAgenda ${i}\n### Participant Jira\nIssue ${i}\n`,
      ).join(''),
  },
}));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (selector: (store: unknown) => unknown) =>
    selector({ setPendingSession: fixtures.pending }),
}));
vi.mock('../../hooks/useHomePreferences', () => ({
  useHomePreferences: () => ({ preferences: { names: { briefing: 'Jeeves' } } }),
}));
vi.mock('../../lib/api-fetch', () => ({
  getApiBaseUrl: () => '',
  apiFetch: vi.fn(
    async (url: string) =>
      new Response(JSON.stringify(url.includes('briefing-chats') ? [] : fixtures.report)),
  ),
}));
vi.mock('../../components/AccountModelPicker', () => ({
  AccountModelPicker: ({ onChange }: { onChange: (s: unknown) => void }) => (
    <button onClick={() => onChange({ accountId: 'work', model: 'luna' })}>
      Choose Work OpenAI · Luna
    </button>
  ),
}));
function Location() {
  return <p data-testid="location">{useLocation().pathname}</p>;
}
function show() {
  render(
    <MemoryRouter initialEntries={['/briefings/2026-10-09']}>
      <Routes>
        <Route path="/briefings/:date" element={<BriefingView />} />
        <Route path="/chat" element={<Location />} />
      </Routes>
    </MemoryRouter>,
  );
}
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('shows all ten meetings and calendar first, folds supporting Jira without deleting it', async () => {
  show();
  await screen.findByText('18:30 Meeting 9');
  expect(screen.getAllByText(/^\d+:30 Meeting/)).toHaveLength(10);
  expect(screen.getByText('Issue 9')).toBeTruthy();
  const jira = screen.getAllByText('Participant Jira')[0].closest('details');
  expect(jira?.open).toBe(false);
  expect(fixtures.pending).not.toHaveBeenCalled();
});
it('cancel leaves chat untouched; Use selection stages the exact report without sending', async () => {
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Ask Jeeves' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose Work OpenAI · Luna' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(fixtures.pending).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Ask Jeeves' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose Work OpenAI · Luna' }));
  fireEvent.click(screen.getByRole('button', { name: 'Use selection' }));
  await waitFor(() => expect(fixtures.pending).toHaveBeenCalled());
  const launch = fixtures.pending.mock.calls[0][0];
  expect(launch.contextBlocks[0]).toContain(fixtures.report.content);
  expect(launch.briefing).toEqual({
    date: fixtures.report.date,
    revision: fixtures.report.revision,
  });
  expect(launch.accountSelection).toEqual({ accountId: 'work', model: 'luna' });
  expect(screen.getByTestId('location').textContent).toBe('/chat');
});

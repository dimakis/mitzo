// @vitest-environment jsdom
import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { BriefingView } from '../BriefingView';
import { apiFetch } from '../../lib/api-fetch';
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
it('names the Today destination without exposing its decorative navigation icon', async () => {
  show();
  await screen.findByText('18:30 Meeting 9');
  const back = screen.getByRole('link', { name: 'Today' });
  expect(back.getAttribute('href')).toBe('/');
  expect(back.querySelector('svg[data-icon="back"][aria-hidden="true"]')).toBeTruthy();
});
it('uses decorative shared SVGs for meeting disclosures without adding to their titles', async () => {
  show();
  const summary = (await screen.findByText('9:30 Meeting 0')).closest('summary')!;
  expect(summary.textContent).toBe('9:30 Meeting 0');
  const icon = summary.querySelector('svg[data-icon="forward"]');
  expect(icon).toBeTruthy();
  expect(icon?.getAttribute('aria-hidden')).toBe('true');
  expect(icon?.getAttribute('focusable')).toBe('false');
});
it('shows all ten meetings and calendar first, folds supporting Jira without deleting it', async () => {
  show();
  await screen.findByText('18:30 Meeting 9');
  expect(screen.getAllByText(/^\d+:30 Meeting/)).toHaveLength(10);
  expect(screen.getByText('Issue 9')).toBeTruthy();
  const jira = screen.getAllByText('Participant Jira')[0].closest('details');
  expect(jira?.open).toBe(false);
  expect(fixtures.pending).not.toHaveBeenCalled();
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(screen.getByText('Briefing').tagName).toBe('P');
});
it('reapplies each bulk expansion action after a native meeting toggle', async () => {
  show();
  await screen.findByText('9:30 Meeting 0');
  const firstMeeting = () => screen.getByText('9:30 Meeting 0').closest('details')!;
  fireEvent.click(screen.getByRole('button', { name: 'Expand all meetings' }));
  expect(firstMeeting().open).toBe(true);
  // Native details state can change without a React prop change.
  firstMeeting().open = false;
  fireEvent.click(screen.getByRole('button', { name: 'Expand all meetings' }));
  expect(firstMeeting().open).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
  expect(firstMeeting().open).toBe(false);
  firstMeeting().open = true;
  fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
  expect(firstMeeting().open).toBe(false);
});
it('keeps all meeting rows visible inside section containers and preserves linked notes', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ...fixtures.report,
        content:
          '# Briefing\n## Today’s meetings\n' +
          Array.from(
            { length: 10 },
            (_, index) =>
              `### ${index + 9}:30 Meeting ${index}\n[Linked notes](meetings/team.md)\n#### Participant Jira\nIssue ${index}\n`,
          ).join(''),
      }),
    ),
  );
  show();
  await screen.findByText('18:30 Meeting 9');
  const parent = screen.getByText('Today’s meetings').closest('details');
  expect(parent?.open).toBe(true);
  expect(screen.getAllByText(/^\d+:30 Meeting/)).toHaveLength(10);
  expect(
    screen.getAllByRole('link', { name: 'Linked notes', hidden: true })[0].getAttribute('href'),
  ).toContain('/files?path=%2Fmeetings%2Fteam.md');
});
it('labels a regenerated report when an older conversation links to its date', async () => {
  render(
    <MemoryRouter initialEntries={['/briefings/2026-10-09?revision=older']}>
      <Routes>
        <Route path="/briefings/:date" element={<BriefingView />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('newer'));
});
it('cancel leaves chat untouched; Use selection stages the exact report without sending', async () => {
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Ask Jeeves' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose Work OpenAI · Luna' }));
  expect(
    screen.getByRole('button', { name: 'Use selection' }).classList.contains('btn-primary'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(fixtures.pending).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Ask Jeeves' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose Work OpenAI · Luna' }));
  fireEvent.click(screen.getByRole('button', { name: 'Use selection' }));
  await waitFor(() => expect(fixtures.pending).toHaveBeenCalled());
  const launch = fixtures.pending.mock.calls[0][0];
  expect(launch.sourceSnapshots).toEqual([
    {
      kind: 'briefing',
      date: fixtures.report.date,
      revision: fixtures.report.revision,
      content: fixtures.report.content,
    },
  ]);
  expect(launch.contextBlocks).toBeUndefined();
  expect(launch.briefing).toEqual({
    date: fixtures.report.date,
    revision: fixtures.report.revision,
  });
  expect(launch.accountSelection).toEqual({ accountId: 'work', model: 'luna' });
  expect(screen.getByTestId('location').textContent).toBe('/chat');
});

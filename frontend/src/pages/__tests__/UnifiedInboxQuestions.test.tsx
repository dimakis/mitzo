// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { UnifiedInboxView } from '../UnifiedInboxView';
const mutate = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../components/NotificationProvider', () => ({
  useNotifications: () => ({ mutate, refresh: vi.fn(), feed: { needsYou: 1 } }),
}));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (s: object) => unknown) =>
    select({ newSession: vi.fn(), setPendingSession: vi.fn() }),
}));
vi.mock('../../lib/event-bus-singleton', () => ({ eventBus: { on: () => () => {} } }));
vi.mock('../../lib/api-fetch', () => ({
  AUTH_LOST_EVENT: 'auth-lost',
  AUTH_RESTORED_EVENT: 'auth-restored',
  apiFetch: async (path: string) =>
    new Response(
      JSON.stringify(
        path.includes('/records/')
          ? question
          : { items: [question], total: 1, needsYou: 1, sources: [] },
      ),
    ),
}));
const question = {
  id: 'permission:p',
  kind: 'question',
  permId: 'p',
  sessionId: 's',
  title: 'Choose a target',
  body: 'Retain each draft',
  createdAt: Date.now(),
  resolvedAt: null,
  readAt: null,
  resolution: null,
  request: {
    toolName: 'AskUserQuestion',
    toolInput: '{}',
    questions: [
      {
        id: 'q',
        header: 'Target',
        question: 'Where?',
        multiSelect: false,
        options: [
          { label: 'North', description: 'First target' },
          { label: 'South', description: 'Second target' },
        ],
      },
    ],
  },
};
afterEach(() => {
  cleanup();
  mutate.mockClear();
});
function ReturnToEntries() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/inbox')}>Return to entries</button>;
}
it.each([true, false])('preserves the hidden question draft (desktop=%s)', async (desktop) => {
  render(
    <MemoryRouter initialEntries={['/inbox']}>
      <ReturnToEntries />
      <UnifiedInboxView desktop={desktop} />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('radio', { name: /North/ }));
  await waitFor(() => expect(screen.getByRole('radio', { name: /North/ })).toBeChecked());
  fireEvent.click(screen.getByRole('button', { name: question.title }));
  await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(2));
  const north = screen.getAllByRole('radio', { name: /North/, hidden: true });
  expect(north).toHaveLength(2);
  expect(north[0]).toBeChecked();
  fireEvent.click(screen.getByRole('radio', { name: /South/ }));
  expect(north[0]).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  await waitFor(() =>
    expect(mutate).toHaveBeenCalledWith('/permission%3Ap/respond', {
      sessionId: 's',
      decision: 'once',
      answers: { q: ['South'] },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Return to entries' }));
  await waitFor(() => expect(screen.getAllByRole('radio', { hidden: true })).toHaveLength(2));
  expect(screen.getByRole('radio', { name: /North/ })).toBeChecked();
});

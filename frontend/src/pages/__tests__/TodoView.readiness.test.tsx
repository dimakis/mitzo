// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TelosWorkApiClient, TelosWorkApiError } from '@mitzo/client';
import { TodoView } from '../TodoView';
import { useTodoData } from '../../hooks/useTodoData';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import type { TodoItem } from '../../types/todo';
vi.mock('../../hooks/useTodoData', () => ({ useTodoData: vi.fn() }));
vi.mock('../../hooks/useStageChatLaunch', () => ({ useStageChatLaunch: () => vi.fn() }));
vi.mock('@mitzo/client/hooks', () => ({ useMitzoStore: () => vi.fn() }));
vi.mock('../../components/TelosTreeConversationEntry', () => ({
  TelosTreeConversationEntry: () => null,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
const records = createTelosWorkFixtures().homeStudio.items;
function legacy(index: number): TodoItem {
  const r = records[index];
  return {
    id: r.itemId,
    summary: r.summary,
    profile: 'work',
    urgency: 0.5,
    starred: false,
    status: 'active',
    ageDays: 0,
    parentId: null,
    children: [],
    childCount: 0,
    completedChildCount: 0,
    sources: [],
    contextHints: r.contextHints,
    goalId: null,
  };
}
function mount() {
  vi.mocked(useTodoData).mockReturnValue({
    items: [legacy(0), legacy(1)],
    loading: false,
    refreshing: false,
    error: null,
    ack: vi.fn(async () => {}),
    snooze: vi.fn(async () => {}),
    done: vi.fn(async () => {}),
    star: vi.fn(async () => {}),
    setPriority: vi.fn(async () => {}),
    create: vi.fn(async () => {}),
    createOutcome: vi.fn(async () => undefined),
    profiles: ['work'],
    refresh: vi.fn(),
  });
  return render(
    <MemoryRouter>
      <TodoView />
    </MemoryRouter>,
  );
}
it('keeps the outcomes shell while cached collection rows await their canonical read', async () => {
  let release!: (r: (typeof records)[number]) => void;
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation((id) =>
    id === records[0].itemId
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve(records[1]),
  );
  const view = mount();
  expect(screen.getByRole('heading', { name: 'Telos outcomes' })).toBeTruthy();
  expect(view.container.querySelector('.telos-legacy-page')).toBeNull();
  await screen.findByRole('button', { name: records[1].summary });
  expect(screen.getByRole('status').textContent).toBe('Loading outcomes…');
  await act(async () => release(records[0]));
  await screen.findByRole('button', { name: records[0].summary });
});
it('retains failed item identity and original fields beside ready records with concrete retry diagnostics', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(async (id) => {
    if (id === records[1].itemId)
      throw new TelosWorkApiError(503, 'fixture_unavailable', 'Offline fixture failure');
    return records[0];
  });
  mount();
  await screen.findByRole('button', { name: records[0].summary });
  await screen.findByRole('button', { name: records[1].summary });
  expect(screen.getByRole('alert').textContent).toContain('503');
  expect(screen.getByRole('alert').textContent).toContain('fixture_unavailable');
  expect(screen.getByRole('alert').textContent).toContain(records[1].itemId);
  expect(screen.getByRole('button', { name: 'Retry unavailable outcomes' })).toBeTruthy();
});

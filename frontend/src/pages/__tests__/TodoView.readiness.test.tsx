// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
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
function mount(items: TodoItem[] = [legacy(0), legacy(1)], discoveryError?: string) {
  const base = {
    items,
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
  };
  vi.mocked(useTodoData).mockImplementation((profile) =>
    discoveryError && profile === undefined ? { ...base, items: [], error: discoveryError } : base,
  );
  return render(
    <MemoryRouter
      initialEntries={
        discoveryError ? [{ pathname: '/todos', state: { activeProfile: 'work' } }] : undefined
      }
    >
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

it('keeps twelve failed original records available while technical diagnostics start collapsed with a visible count and real retry', async () => {
  const items = Array.from({ length: 12 }, (_, index) => ({
    ...legacy(0),
    id: `item-${index}`,
    summary: `Original outcome ${index}`,
  }));
  const read = vi
    .spyOn(TelosWorkApiClient.prototype, 'readRecord')
    .mockRejectedValue(new TelosWorkApiError(404, 'unavailable', 'Canonical records unavailable'));
  const view = mount(items);
  await screen.findByRole('heading', { name: 'Work' });
  const alert = screen.getByRole('alert');
  const details = alert.querySelector('details');
  expect(details).not.toBeNull();
  expect(details!.open).toBe(false);
  expect(alert.querySelector('summary')?.textContent).toBe('12 records unavailable');
  expect(view.container.querySelectorAll('.todo-card')).toHaveLength(12);
  const retry = screen.getByRole('button', { name: 'Retry unavailable outcomes' });
  expect(retry.classList.contains('home-secondary')).toBe(true);
  expect(retry.classList.contains('todo-refresh')).toBe(false);
  fireEvent.click(alert.querySelector('summary')!);
  expect(details!.open).toBe(true);
  expect(details!.querySelectorAll('li')).toHaveLength(12);
  expect(details!.textContent).toContain('item-11 · HTTP 404 · unavailable');
  fireEvent.click(retry);
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThanOrEqual(24));
});

it('uses the shared labelled action for a partial failure and retains its original title and HTTP diagnostics upfront', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(async (id) => {
    if (id === records[1].itemId)
      throw new TelosWorkApiError(503, 'fixture_unavailable', 'Offline fixture failure');
    return records[0];
  });
  mount();
  await screen.findByRole('button', { name: records[0].summary });
  await screen.findByRole('button', { name: records[1].summary });
  const retry = screen.getByRole('button', { name: 'Retry unavailable outcomes' });
  expect(retry.classList.contains('home-secondary')).toBe(true);
  expect(retry.classList.contains('todo-refresh')).toBe(false);
  expect(screen.getByRole('alert').querySelector('details')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('HTTP 503');
});

it('uses an unavailable summary without inventing a zero count when discovery fails before individual record failures are known', async () => {
  const view = mount([legacy(0)], 'Unable to load Telos items');
  await screen.findByRole('heading', { name: 'Work' });
  const alert = screen.getByRole('alert');
  expect(alert.querySelector('summary')?.textContent).toBe('Outcome records unavailable');
  expect(alert.textContent).not.toContain('0 records unavailable');
  expect(alert.textContent).toContain('Unable to load Telos items');
  expect(view.container.querySelectorAll('.todo-card')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Retry unavailable outcomes' })).toBeTruthy();
});

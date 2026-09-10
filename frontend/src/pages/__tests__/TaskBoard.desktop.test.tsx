// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TaskBoard } from '../TaskBoard';
Element.prototype.scrollIntoView = vi.fn();
const mocks = vi.hoisted(() => ({ approve: vi.fn(), pause: vi.fn(), stop: vi.fn() }));
vi.mock('../../hooks/useTaskBoard', () => ({
  useTaskBoard: () => ({
    loading: false,
    tasks: [task],
    sortedTasks: [task],
    displayMeta: new Map(),
    totalTokenUsage: 100,
    showAll: true,
    setShowAll: vi.fn(),
    loopStatus: {
      state: 'running',
      goalId: 'review',
      activeTaskId: 'review',
      progress: null,
      specMode: false,
      awaitingApproval: false,
      spawnEnabled: false,
    },
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    startLoop: vi.fn(),
    pauseLoop: mocks.pause,
    resumeLoop: vi.fn(),
    stopLoop: mocks.stop,
    setSpawnEnabled: vi.fn(),
    approveTask: mocks.approve,
    rejectTask: vi.fn(),
    approveSpec: vi.fn(),
    rejectSpec: vi.fn(),
    refresh: vi.fn(),
  }),
}));
const task = {
  id: 'review',
  title: 'Review output',
  parentId: null,
  status: 'pending_review',
  description: 'Validate outputs',
  tokenUsage: 100,
  children: [],
  annotations: [],
  sessionId: null,
  sessionPolicy: 'reuse',
  requiresApproval: true,
  retryCount: 0,
  maxRetries: 0,
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('opens an existing task hash link in the inspector and retains approval and workflow controls', () => {
  render(
    <MemoryRouter initialEntries={['/tasks#task-review']}>
      <TaskBoard desktop />
    </MemoryRouter>,
  );
  const detail = screen.getByRole('region', { name: 'Execution details' });
  expect(within(detail).getByText('Validate outputs')).toBeTruthy();
  fireEvent.click(within(detail).getByTitle('Approve'));
  expect(mocks.approve).toHaveBeenCalledWith('review');
  fireEvent.click(screen.getByTitle('Pause'));
  expect(mocks.pause).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Tree and attention' }));
  expect(screen.queryByRole('region', { name: 'Execution details' })).toBeNull();
  expect(screen.getByTitle('Approve')).toBeTruthy();
});

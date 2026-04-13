// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TaskBoard } from '../TaskBoard';
import type { Task } from '../../types/task';

afterEach(() => {
  cleanup();
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    parentId: null,
    title: 'Test task',
    description: null,
    status: 'pending',
    sessionId: null,
    sessionPolicy: 'auto',
    priority: 0,
    depth: 0,
    annotations: [],
    summary: null,
    requiresApproval: false,
    tokenUsage: 0,
    claimedBy: null,
    claimedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    children: [],
    ...overrides,
  };
}

// Mock useTaskBoard
const mockRefresh = vi.fn();
const mockCreateTask = vi.fn();
const mockUpdateTask = vi.fn();
const mockDeleteTask = vi.fn();
const mockStartLoop = vi.fn();
const mockPauseLoop = vi.fn();
const mockResumeLoop = vi.fn();
const mockStopLoop = vi.fn();
const mockApproveTask = vi.fn();
const mockRejectTask = vi.fn();
const mockApproveSpec = vi.fn();
const mockRejectSpec = vi.fn();
let mockLoading = false;
let mockTasks: Task[] = [];

vi.mock('../../hooks/useTaskBoard', () => ({
  useTaskBoard: () => ({
    loading: mockLoading,
    tasks: mockTasks,
    loopStatus: {
      state: 'idle',
      goalId: null,
      activeTaskId: null,
      progress: null,
      specMode: false,
      awaitingApproval: false,
    },
    createTask: mockCreateTask,
    updateTask: mockUpdateTask,
    deleteTask: mockDeleteTask,
    startLoop: mockStartLoop,
    pauseLoop: mockPauseLoop,
    resumeLoop: mockResumeLoop,
    stopLoop: mockStopLoop,
    approveTask: mockApproveTask,
    rejectTask: mockRejectTask,
    approveSpec: mockApproveSpec,
    rejectSpec: mockRejectSpec,
    refresh: mockRefresh,
  }),
}));

function renderBoard() {
  return render(
    <MemoryRouter>
      <TaskBoard />
    </MemoryRouter>,
  );
}

describe('TaskBoard', () => {
  it('shows loading state', () => {
    mockLoading = true;
    mockTasks = [];
    renderBoard();
    expect(screen.getByText('Loading...')).toBeTruthy();
    mockLoading = false;
  });

  it('shows empty state when no tasks', () => {
    mockLoading = false;
    mockTasks = [];
    renderBoard();
    expect(screen.getByText('No tasks yet')).toBeTruthy();
  });

  it('renders task list', () => {
    mockLoading = false;
    mockTasks = [makeTask({ title: 'Task A' }), makeTask({ id: 'task-2', title: 'Task B' })];
    renderBoard();
    expect(screen.getAllByText('Task A').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Task B').length).toBeGreaterThan(0);
  });

  it('add button toggles create form', () => {
    mockLoading = false;
    mockTasks = [];
    renderBoard();

    // Click add button
    const addBtn = screen.getByTitle('Add task');
    fireEvent.click(addBtn);

    // Form should appear
    expect(screen.getByPlaceholderText('Add task...')).toBeTruthy();

    // Click cancel to hide
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByPlaceholderText('Add task...')).toBeNull();
  });

  it('refresh button calls refresh', () => {
    mockLoading = false;
    mockTasks = [];
    renderBoard();

    const refreshBtn = screen.getByTitle('Refresh');
    fireEvent.click(refreshBtn);
    expect(mockRefresh).toHaveBeenCalled();
  });
});

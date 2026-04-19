// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { Task } from '../../types/task';
import { TaskNode } from '../TaskNode';

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

describe('TaskNode', () => {
  it('renders title', () => {
    render(
      <TaskNode
        task={makeTask({ title: 'My Task' })}
        depth={0}
        onStatusChange={vi.fn()}
        onDelete={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );
    expect(screen.getByText('My Task')).toBeTruthy();
  });

  it.each([
    ['pending', 'Pending'],
    ['active', 'Active'],
    ['done', 'Done'],
    ['pending_review', 'Review'],
    ['blocked', 'Blocked'],
    ['skipped', 'Skipped'],
    ['failed', 'Failed'],
  ] as const)('renders correct label for status %s', (status, expectedLabel) => {
    const { container } = render(
      <TaskNode
        task={makeTask({ status })}
        depth={0}
        onStatusChange={vi.fn()}
        onDelete={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );
    const statusBtn = container.querySelector('.task-card-chip');
    expect(statusBtn?.textContent).toBe(expectedLabel);
  });

  it('toggles expand/collapse for tasks with children', () => {
    const child = makeTask({ id: 'child-1', parentId: 'task-1', title: 'Child task', depth: 1 });
    const task = makeTask({ children: [child] });

    render(
      <TaskNode
        task={task}
        depth={0}
        onStatusChange={vi.fn()}
        onDelete={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );

    // Children should be visible by default
    expect(screen.getByText('Child task')).toBeTruthy();

    // Click collapse
    const chevron = screen.getByText('\u25BE');
    fireEvent.click(chevron);

    // Children should be hidden
    expect(screen.queryByText('Child task')).toBeNull();
  });

  it('does not apply inline depth indentation (handled by CSS nesting)', () => {
    const { container } = render(
      <TaskNode
        task={makeTask()}
        depth={2}
        onStatusChange={vi.fn()}
        onDelete={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );
    const node = container.firstElementChild as HTMLElement;
    expect(node.style.paddingLeft).toBe('');
  });

  it('renders children recursively', () => {
    const grandchild = makeTask({
      id: 'gc-1',
      parentId: 'child-1',
      title: 'Grandchild',
      depth: 2,
    });
    const child = makeTask({
      id: 'child-1',
      parentId: 'task-1',
      title: 'Child',
      depth: 1,
      children: [grandchild],
    });
    const task = makeTask({ children: [child] });

    render(
      <TaskNode
        task={task}
        depth={0}
        onStatusChange={vi.fn()}
        onDelete={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );

    expect(screen.getByText('Child')).toBeTruthy();
    expect(screen.getByText('Grandchild')).toBeTruthy();
  });

  it('calls onStatusChange when status icon clicked', () => {
    const onStatusChange = vi.fn();
    const { container } = render(
      <TaskNode
        task={makeTask({ id: 'sc-1', status: 'pending' })}
        depth={0}
        onStatusChange={onStatusChange}
        onDelete={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );

    const statusBtn = container.querySelector('.task-card-chip')!;
    fireEvent.click(statusBtn);
    expect(onStatusChange).toHaveBeenCalledWith('sc-1', expect.any(String));
  });

  it('calls onDelete when delete button clicked', () => {
    const onDelete = vi.fn();
    const { container } = render(
      <TaskNode
        task={makeTask({ id: 'del-1' })}
        depth={0}
        onStatusChange={vi.fn()}
        onDelete={onDelete}
        onAddChild={vi.fn()}
      />,
    );

    const deleteBtn = container.querySelector('.task-card-action--reject')!;
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledWith('del-1');
  });
});

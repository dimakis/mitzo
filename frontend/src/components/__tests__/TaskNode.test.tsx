// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Task } from '../../types/task';
import type { TaskDisplayMeta } from '../../hooks/useTaskBoard';
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
    stageType: null,
    gateConfig: null,
    artifacts: null,
    retryCount: 0,
    maxRetries: 0,
    templateId: null,
    children: [],
    ...overrides,
  };
}

function renderNode(task: Task, opts: { displayMeta?: Map<string, TaskDisplayMeta> } = {}) {
  return render(
    <MemoryRouter>
      <TaskNode
        task={task}
        depth={0}
        displayMeta={opts.displayMeta}
        onStatusChange={vi.fn()}
        onDelete={vi.fn()}
        onAddChild={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('TaskNode', () => {
  it('renders title', () => {
    renderNode(makeTask({ title: 'My Task' }));
    expect(screen.getByText('My Task')).toBeTruthy();
  });

  it.each([
    ['pending', '\u25CB'],
    ['active', '\u25C9'],
    ['done', '\u2713'],
    ['pending_review', '\u25D4'],
    ['blocked', '\u2298'],
    ['skipped', '\u2014'],
    ['failed', '\u2717'],
  ] as const)('renders correct label for status %s', (status, expectedIcon) => {
    const { container } = renderNode(makeTask({ status }));
    const statusBtn = container.querySelector('.task-node-status');
    expect(statusBtn?.textContent).toBe(expectedIcon);
  });

  it('toggles expand/collapse for tasks with children', () => {
    const child = makeTask({ id: 'child-1', parentId: 'task-1', title: 'Child task', depth: 1 });
    const task = makeTask({ children: [child] });

    renderNode(task);

    // Children should be visible by default
    expect(screen.getByText('Child task')).toBeTruthy();

    // Click collapse
    const chevron = screen.getByText('\u25BC');
    fireEvent.click(chevron);

    // Children should be hidden
    expect(screen.queryByText('Child task')).toBeNull();
  });

  it('does not apply inline depth indentation (handled by CSS nesting)', () => {
    const { container } = renderNode(makeTask());
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

    renderNode(task);

    expect(screen.getByText('Child')).toBeTruthy();
    expect(screen.getByText('Grandchild')).toBeTruthy();
  });

  it('calls onStatusChange when status icon clicked', () => {
    const onStatusChange = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <TaskNode
          task={makeTask({ id: 'sc-1', status: 'pending' })}
          depth={0}
          onStatusChange={onStatusChange}
          onDelete={vi.fn()}
          onAddChild={vi.fn()}
        />
      </MemoryRouter>,
    );

    const statusBtn = container.querySelector('.task-node-status')!;
    fireEvent.click(statusBtn);
    expect(onStatusChange).toHaveBeenCalledWith('sc-1', expect.any(String));
  });

  it('calls onDelete when delete button clicked', () => {
    const onDelete = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <TaskNode
          task={makeTask({ id: 'del-1' })}
          depth={0}
          onStatusChange={vi.fn()}
          onDelete={onDelete}
          onAddChild={vi.fn()}
        />
      </MemoryRouter>,
    );

    const deleteBtn = container.querySelector('.task-node-action--danger')!;
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledWith('del-1');
  });

  it('renders session link for active task with sessionId', () => {
    const task = makeTask({
      status: 'active',
      sessionId: 'abc123def456',
      claimedAt: Date.now() - 60000,
    });
    const meta = new Map<string, TaskDisplayMeta>([
      [task.id, { attendTier: 3, fadeOpacity: 1, sessionHash: 'abc123', elapsedLabel: '1m' }],
    ]);

    const { container } = renderNode(task, { displayMeta: meta });
    const link = container.querySelector('.task-node-session-link') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toBe('abc123');
    expect(link.getAttribute('href')).toBe('/chat/abc123def456');
  });

  it('renders summary when present', () => {
    renderNode(makeTask({ summary: 'Completed the migration successfully' }));
    expect(screen.getByText('Completed the migration successfully')).toBeTruthy();
  });

  it('does not render summary when null', () => {
    const { container } = renderNode(makeTask({ summary: null }));
    expect(container.querySelector('.task-node-summary')).toBeNull();
  });
});

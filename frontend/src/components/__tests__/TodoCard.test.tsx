// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TodoCard } from '../TodoCard';
import type { TodoItem } from '../../types/todo';

const mockItem: TodoItem = {
  id: 'abc123',
  summary: '[dimakis/mitzo#1] Fix bug',
  profile: 'centaur',
  urgency: 0.5,
  status: 'active',
  ageDays: 3,
  parentId: null,
  children: [],
  childCount: 0,
  completedChildCount: 0,
  sources: [
    {
      type: 'github',
      url: 'https://github.com/dimakis/mitzo/issues/1',
      title: 'Fix bug',
      author: 'dimakis',
      snippet: 'Some description',
    },
  ],
  contextHints: {
    repos: ['dimakis/mitzo'],
    paths: [],
    issues: ['dimakis/mitzo#1'],
    docIds: [],
    people: [],
    jiraKeys: [],
    keywords: [],
    taskHint: 'Fix bug',
  },
};

describe('TodoCard', () => {
  it('renders item summary', () => {
    render(
      <TodoCard
        item={mockItem}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );
    expect(screen.getByText('[dimakis/mitzo#1] Fix bug')).toBeTruthy();
  });

  it('renders source badge and age', () => {
    const { container } = render(
      <TodoCard
        item={mockItem}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );
    expect(container.querySelector('.todo-card-source')?.textContent).toBe('GH');
    expect(container.querySelector('.todo-card-age')?.textContent).toBe('3d');
  });

  it('renders author', () => {
    const { container } = render(
      <TodoCard
        item={mockItem}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );
    expect(container.querySelector('.todo-card-author')?.textContent).toBe('dimakis');
  });

  it('calls onTap on tap (touchstart + touchend without move)', () => {
    const onTap = vi.fn();
    const { container } = render(
      <TodoCard
        item={mockItem}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={onTap}
        onAddChild={vi.fn()}
      />,
    );
    const card = container.querySelector('.todo-card')!;
    fireEvent.touchStart(card, { touches: [{ clientX: 100, clientY: 200 }] });
    fireEvent.touchEnd(card);
    expect(onTap).toHaveBeenCalledWith(mockItem);
  });

  it('does not fire onTap when scrolling vertically', () => {
    const onTap = vi.fn();
    const { container } = render(
      <TodoCard
        item={mockItem}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={onTap}
        onAddChild={vi.fn()}
      />,
    );
    const card = container.querySelector('.todo-card')!;

    fireEvent.touchStart(card, { touches: [{ clientX: 100, clientY: 200 }] });
    fireEvent.touchMove(card, { touches: [{ clientX: 100, clientY: 230 }] }); // 30px vertical
    fireEvent.touchEnd(card);

    expect(onTap).not.toHaveBeenCalled();
  });

  it('does not fire onTap when scrolling vertically even with small X movement', () => {
    const onTap = vi.fn();
    const { container } = render(
      <TodoCard
        item={mockItem}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={onTap}
        onAddChild={vi.fn()}
      />,
    );
    const card = container.querySelector('.todo-card')!;

    fireEvent.touchStart(card, { touches: [{ clientX: 100, clientY: 200 }] });
    fireEvent.touchMove(card, { touches: [{ clientX: 105, clientY: 215 }] }); // 5px X, 15px Y
    fireEvent.touchEnd(card);

    expect(onTap).not.toHaveBeenCalled();
  });

  it('shows new label for 0 day age', () => {
    const newItem = { ...mockItem, ageDays: 0 };
    render(
      <TodoCard
        item={newItem}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );
    expect(screen.getByText('new')).toBeTruthy();
  });

  it('shows acknowledged icon for acknowledged status', () => {
    const ackItem = { ...mockItem, status: 'acknowledged' as const };
    render(
      <TodoCard
        item={ackItem}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );
    // ◐ character for acknowledged
    expect(screen.getByText('\u25D0')).toBeTruthy();
  });

  it('triggers onAck on swipe right past threshold', () => {
    vi.useFakeTimers();
    const onAck = vi.fn();
    const { container } = render(
      <TodoCard
        item={mockItem}
        onAck={onAck}
        onDone={vi.fn()}
        onTap={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );
    const card = container.querySelector('.todo-card')!;

    fireEvent.touchStart(card, { touches: [{ clientX: 0 }] });
    fireEvent.touchMove(card, { touches: [{ clientX: 150 }] });
    fireEvent.touchEnd(card);

    vi.advanceTimersByTime(200);
    expect(onAck).toHaveBeenCalledWith('abc123');
    vi.useRealTimers();
  });

  it('triggers onDone on swipe left past threshold', () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    const { container } = render(
      <TodoCard
        item={mockItem}
        onAck={vi.fn()}
        onDone={onDone}
        onTap={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );
    const card = container.querySelector('.todo-card')!;

    fireEvent.touchStart(card, { touches: [{ clientX: 200 }] });
    fireEvent.touchMove(card, { touches: [{ clientX: 50 }] });
    fireEvent.touchEnd(card);

    vi.advanceTimersByTime(200);
    expect(onDone).toHaveBeenCalledWith('abc123');
    vi.useRealTimers();
  });

  it('snaps back on partial swipe', () => {
    const onAck = vi.fn();
    const onDone = vi.fn();
    const { container } = render(
      <TodoCard
        item={mockItem}
        onAck={onAck}
        onDone={onDone}
        onTap={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );
    const card = container.querySelector('.todo-card')!;

    fireEvent.touchStart(card, { touches: [{ clientX: 100 }] });
    fireEvent.touchMove(card, { touches: [{ clientX: 140 }] }); // only 40px
    fireEvent.touchEnd(card);

    expect(onAck).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect((card as HTMLElement).style.transform).toBe('translateX(0)');
  });

  it('does not show expand button when no children', () => {
    const { container } = render(
      <TodoCard
        item={mockItem}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );
    expect(container.querySelector('.todo-card-expand')).toBeNull();
  });

  it('shows expand button and toggles children', () => {
    const childItem: TodoItem = {
      ...mockItem,
      id: 'child-1',
      summary: 'Child task',
      parentId: 'abc123',
      children: [],
      childCount: 0,
      completedChildCount: 0,
    };
    const parentItem: TodoItem = {
      ...mockItem,
      children: [childItem],
      childCount: 1,
      completedChildCount: 0,
    };

    const { container } = render(
      <TodoCard
        item={parentItem}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );

    const expandBtn = container.querySelector('.todo-card-expand')!;
    expect(expandBtn).toBeTruthy();
    expect(expandBtn.textContent).toBe('\u25B6'); // collapsed

    // Children not visible yet
    expect(container.querySelector('.todo-card-children')).toBeNull();

    // Expand
    fireEvent.click(expandBtn);
    expect(expandBtn.textContent).toBe('\u25BC'); // expanded
    expect(container.querySelector('.todo-card-children')).toBeTruthy();
    expect(screen.getByText('Child task')).toBeTruthy();

    // Collapse
    fireEvent.click(expandBtn);
    expect(container.querySelector('.todo-card-children')).toBeNull();
  });

  it('shows progress counter for parent items', () => {
    const parentItem: TodoItem = {
      ...mockItem,
      children: [{ ...mockItem, id: 'c1' }],
      childCount: 3,
      completedChildCount: 1,
    };

    const { container } = render(
      <TodoCard
        item={parentItem}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );

    const progress = container.querySelector('.todo-card-progress');
    expect(progress?.textContent).toBe('1/3');
  });

  it('calls onAddChild when sub-task button is clicked', () => {
    const onAddChild = vi.fn();
    const { container } = render(
      <TodoCard
        item={mockItem}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={vi.fn()}
        onAddChild={onAddChild}
      />,
    );

    const addBtn = container.querySelector('.todo-card-add-child')!;
    fireEvent.click(addBtn);
    expect(onAddChild).toHaveBeenCalledWith('abc123');
  });

  it('applies depth indentation via tree node class', () => {
    const { container } = render(
      <TodoCard
        item={mockItem}
        depth={1}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );

    const treeNode = container.querySelector('.todo-card-tree-node');
    expect(treeNode?.classList.contains('todo-card-tree-node--child')).toBe(true);
  });

  it('does not apply child class at depth 0', () => {
    const { container } = render(
      <TodoCard
        item={mockItem}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={vi.fn()}
        onAddChild={vi.fn()}
      />,
    );

    const treeNode = container.querySelector('.todo-card-tree-node');
    expect(treeNode?.classList.contains('todo-card-tree-node--child')).toBe(false);
  });
});

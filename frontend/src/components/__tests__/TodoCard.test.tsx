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
    render(<TodoCard item={mockItem} onAck={vi.fn()} onDone={vi.fn()} onTap={vi.fn()} />);
    expect(screen.getByText('[dimakis/mitzo#1] Fix bug')).toBeTruthy();
  });

  it('renders source badge and age', () => {
    const { container } = render(
      <TodoCard item={mockItem} onAck={vi.fn()} onDone={vi.fn()} onTap={vi.fn()} />,
    );
    expect(container.querySelector('.todo-card-source')?.textContent).toBe('GH');
    expect(container.querySelector('.todo-card-age')?.textContent).toBe('3d');
  });

  it('renders author', () => {
    const { container } = render(
      <TodoCard item={mockItem} onAck={vi.fn()} onDone={vi.fn()} onTap={vi.fn()} />,
    );
    expect(container.querySelector('.todo-card-author')?.textContent).toBe('dimakis');
  });

  it('calls onTap on tap (touchstart + touchend without move)', () => {
    const onTap = vi.fn();
    const { container } = render(
      <TodoCard item={mockItem} onAck={vi.fn()} onDone={vi.fn()} onTap={onTap} />,
    );
    const card = container.querySelector('.todo-card')!;
    fireEvent.touchStart(card, { touches: [{ clientX: 100 }] });
    fireEvent.touchEnd(card);
    expect(onTap).toHaveBeenCalledWith(mockItem);
  });

  it('shows new label for 0 day age', () => {
    const newItem = { ...mockItem, ageDays: 0 };
    render(<TodoCard item={newItem} onAck={vi.fn()} onDone={vi.fn()} onTap={vi.fn()} />);
    expect(screen.getByText('new')).toBeTruthy();
  });

  it('shows acknowledged icon for acknowledged status', () => {
    const ackItem = { ...mockItem, status: 'acknowledged' as const };
    render(<TodoCard item={ackItem} onAck={vi.fn()} onDone={vi.fn()} onTap={vi.fn()} />);
    // ◐ character for acknowledged
    expect(screen.getByText('\u25D0')).toBeTruthy();
  });

  it('triggers onAck on swipe right past threshold', () => {
    vi.useFakeTimers();
    const onAck = vi.fn();
    const { container } = render(
      <TodoCard item={mockItem} onAck={onAck} onDone={vi.fn()} onTap={vi.fn()} />,
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
      <TodoCard item={mockItem} onAck={vi.fn()} onDone={onDone} onTap={vi.fn()} />,
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
      <TodoCard item={mockItem} onAck={onAck} onDone={onDone} onTap={vi.fn()} />,
    );
    const card = container.querySelector('.todo-card')!;

    fireEvent.touchStart(card, { touches: [{ clientX: 100 }] });
    fireEvent.touchMove(card, { touches: [{ clientX: 140 }] }); // only 40px
    fireEvent.touchEnd(card);

    expect(onAck).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect((card as HTMLElement).style.transform).toBe('translateX(0)');
  });
});

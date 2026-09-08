// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TodoCard } from '../TodoCard';
import type { TodoItem } from '../../types/todo';
const item = {
  id: 'gesture',
  summary: 'Swipe from this title',
  urgency: 0.5,
  status: 'active',
  ageDays: 0,
  children: [],
  sources: [],
  profile: 'manual',
} as unknown as TodoItem;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('TELOS title gestures', () => {
  it.each([
    [150, 'seen'],
    [-150, 'done'],
  ] as const)('preserves a title-originated %s px swipe', (dx, action) => {
    vi.useFakeTimers();
    const onAck = vi.fn(),
      onDone = vi.fn(),
      onTap = vi.fn();
    render(
      <TodoCard
        item={item}
        onAck={onAck}
        onDone={onDone}
        onTap={onTap}
        onAddChild={vi.fn()}
        onStar={vi.fn()}
        onStartSession={vi.fn()}
      />,
    );
    const title = screen.getByRole('button', { name: item.summary });
    fireEvent.touchStart(title, { touches: [{ clientX: 200, clientY: 100 }] });
    fireEvent.touchMove(title, { touches: [{ clientX: 200 + dx, clientY: 100 }] });
    fireEvent.touchEnd(title);
    vi.advanceTimersByTime(250);
    expect(action === 'seen' ? onAck : onDone).toHaveBeenCalledWith(item.id);
    expect(onTap).not.toHaveBeenCalled();
  });
  it('handles a touch tap once and cancels the synthesized mouse click', () => {
    const onTap = vi.fn();
    render(
      <TodoCard
        item={item}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={onTap}
        onAddChild={vi.fn()}
        onStar={vi.fn()}
        onStartSession={vi.fn()}
      />,
    );
    const title = screen.getByRole('button', { name: item.summary });
    fireEvent.touchStart(title, { touches: [{ clientX: 200, clientY: 100 }] });
    expect(fireEvent.touchEnd(title, { cancelable: true })).toBe(false);
    expect(onTap).toHaveBeenCalledExactlyOnceWith(item);
  });
});

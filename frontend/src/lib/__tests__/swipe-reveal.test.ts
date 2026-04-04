import { describe, it, expect } from 'vitest';
import { computeSwipeState, type SwipePhase } from '../swipe-reveal';

function swipe(dx: number): SwipePhase {
  return computeSwipeState(dx, false);
}

function swipeWhileRevealed(dx: number): SwipePhase {
  return computeSwipeState(dx, true);
}

describe('computeSwipeState', () => {
  it('returns idle for small movements', () => {
    const state = swipe(-20);
    expect(state).toBe('dragging');
  });

  it('does not reveal until threshold is reached', () => {
    expect(swipe(-50).toString()).not.toBe('reveal');
    expect(swipe(-79).toString()).not.toBe('reveal');
  });

  it('returns reveal when swiped past threshold', () => {
    expect(swipe(-80)).toBe('reveal');
    expect(swipe(-150)).toBe('reveal');
  });

  it('does not trigger reveal for rightward swipes', () => {
    expect(swipe(100)).toBe('idle');
    expect(swipe(50)).toBe('idle');
  });

  it('returns dragging for small leftward swipes', () => {
    expect(swipe(-10)).toBe('dragging');
    expect(swipe(-40)).toBe('dragging');
  });

  it('returns close when swiping back while revealed', () => {
    // Swiping right while delete is revealed should close it
    expect(swipeWhileRevealed(30)).toBe('close');
  });

  it('stays in reveal when dragging further left while revealed', () => {
    expect(swipeWhileRevealed(-20)).toBe('reveal');
  });
});

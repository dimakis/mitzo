/** Threshold in px — how far left you must swipe to reveal the delete button */
export const REVEAL_THRESHOLD = 80;

/** Width of the revealed delete button area */
export const REVEAL_WIDTH = 80;

export type SwipePhase = 'idle' | 'dragging' | 'reveal' | 'close';

/**
 * Pure function that computes the swipe state from the horizontal delta
 * and whether the delete button is currently revealed.
 */
export function computeSwipeState(dx: number, isRevealed: boolean): SwipePhase {
  if (isRevealed) {
    // Swiping right while revealed → close
    if (dx > 20) return 'close';
    return 'reveal';
  }

  // Rightward or negligible movement
  if (dx >= 0) return 'idle';

  // Left swipe past threshold → reveal
  if (dx <= -REVEAL_THRESHOLD) return 'reveal';

  // Actively dragging left but not past threshold
  return 'dragging';
}

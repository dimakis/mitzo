import { describe, it, expect } from 'vitest';
import { shouldAutoScroll } from '../scroll';

describe('shouldAutoScroll', () => {
  // ─── Non-streaming (finished messages) ───────────────────────────────────────

  it('scrolls when near bottom during non-streaming', () => {
    // dist = 1000 - 850 - 100 = 50 < 150
    expect(shouldAutoScroll(1000, 850, 100, false)).toBe(true);
  });

  it('does not scroll when far from bottom during non-streaming', () => {
    // dist = 1000 - 500 - 100 = 400 > 150
    expect(shouldAutoScroll(1000, 500, 100, false)).toBe(false);
  });

  it('scrolls when exactly at threshold during non-streaming', () => {
    // dist = 1000 - 750 - 100 = 150 <= 150
    expect(shouldAutoScroll(1000, 750, 100, false)).toBe(true);
  });

  // ─── Streaming (active content) ─────────────────────────────────────────────

  it('scrolls during streaming when within one viewport of bottom', () => {
    // dist = 5000 - 4800 - 100 = 100 <= 100 (clientHeight)
    expect(shouldAutoScroll(5000, 4800, 100, true)).toBe(true);
  });

  it('scrolls during streaming even when beyond fixed 150px threshold', () => {
    // dist = 5000 - 4500 - 200 = 300 > 150 but <= 200 * 2
    // With streaming threshold = clientHeight * 2 = 400, this should scroll
    expect(shouldAutoScroll(5000, 4500, 200, true)).toBe(true);
  });

  it('does not scroll during streaming when user scrolled far up', () => {
    // dist = 5000 - 3000 - 200 = 1800 >> viewport
    expect(shouldAutoScroll(5000, 3000, 200, true)).toBe(false);
  });

  it('uses larger threshold during streaming to survive rapid tool call growth', () => {
    // Simulate: 15 tool calls at ~50px each = 750px of growth
    // User was at bottom, now 750px behind after batched render
    // viewport = 700px, streaming threshold = 700*2 = 1400
    // dist = 5000 - 3550 - 700 = 750 <= 1400 → should scroll
    expect(shouldAutoScroll(5000, 3550, 700, true)).toBe(true);
    // Same scenario non-streaming: 750 > 150 → should NOT scroll
    expect(shouldAutoScroll(5000, 3550, 700, false)).toBe(false);
  });
});

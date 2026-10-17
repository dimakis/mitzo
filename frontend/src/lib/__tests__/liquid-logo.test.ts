import { expect, it } from 'vitest';
import { liquidFrame } from '../liquid-logo';
it('falls from the top, contacts the floor, and finishes at the exact logo point', () => {
  const point = { x: 0.3, y: 0.6, seed: 0.4 };
  expect(liquidFrame(point, 0, 390, 600).y).toBeLessThan(0);
  expect(liquidFrame(point, 0.35, 390, 600).y).toBeGreaterThan(500);
  expect(liquidFrame(point, 1, 390, 600)).toMatchObject({ x: 143.8, y: 261.4, radius: 2.2 });
});
it('remains finite and within the lower screen boundary at every frame', () => {
  for (const width of [240, 320, 390, 1280])
    for (let time = 0; time <= 1; time += 0.01) {
      const frame = liquidFrame({ x: 0.8, y: 0.1, seed: 0.9 }, time, width, 460);
      expect(Number.isFinite(frame.x + frame.y + frame.radius)).toBe(true);
      expect(frame.y).toBeLessThanOrEqual(460);
      expect(frame.x).toBeGreaterThanOrEqual(0);
      expect(frame.x).toBeLessThanOrEqual(width);
    }
});

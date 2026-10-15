import { expect, it } from 'vitest';
import { waterfallParticle, waterfallFrame } from '../waterfall';

it('samples once and keeps every splash above the composer border', () => {
  let count = 0;
  const random = () => {
    count++;
    return 0.65;
  };
  const particle = waterfallParticle(70, 35, random);
  const samples = count;
  for (let progress = 0; progress <= 1; progress += 0.005) {
    const frame = waterfallFrame(particle, progress, 390, 460);
    expect(frame.y + frame.size).toBeLessThanOrEqual(460);
    expect(frame.x).toBeGreaterThanOrEqual(0);
    expect(frame.alpha).toBeGreaterThanOrEqual(0);
  }
  expect(count).toBe(samples);
  expect(waterfallFrame(particle, 0.75, 390, 460)).toEqual(
    waterfallFrame(particle, 1 - 0.25, 390, 460),
  );
  expect(waterfallFrame(particle, 1, 390, 460).alpha).toBe(0);
});

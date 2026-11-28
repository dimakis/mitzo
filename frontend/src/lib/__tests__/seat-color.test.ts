import { expect, it } from 'vitest';
import { seatAccentColor } from '../seat-color';

it('assigns distinct retained roster accents even when identity hashes collide', () => {
  const roster = Array.from({ length: 16 }, (_, index) => `seat-${index}`);
  expect(new Set(roster.map((id) => seatAccentColor(id, roster))).size).toBe(16);
  expect(seatAccentColor('seat-9', roster)).toBe(
    seatAccentColor('seat-9', [...roster, 'later-seat']),
  );
});

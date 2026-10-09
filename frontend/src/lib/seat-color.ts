/** Stable accent derived from identity, never role, label, or roster position. */
const palette = Array.from({ length: 8 }, (_, index) => `var(--seat-color-${index + 1})`);
export function seatAccentColor(seatId: string): string {
  let hash = 2166136261;
  for (const character of seatId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return palette[(hash >>> 0) % palette.length];
}

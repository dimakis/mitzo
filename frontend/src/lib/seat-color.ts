/** Stable identity slots use retained membership order, never the current active roster. */
const palette = Array.from({ length: 8 }, (_, index) => `var(--seat-color-${index + 1})`);
export function seatAccentColor(seatId: string, roster: readonly string[] = []): string {
  const ordinal = roster.indexOf(seatId);
  if (ordinal >= 0) {
    const color = palette[ordinal % palette.length];
    const generation = Math.floor(ordinal / palette.length);
    // Reserve removed seats' slots. Additional generations derive from shared
    // semantic tokens rather than colliding with an earlier identity's accent.
    return generation === 0
      ? color
      : `color-mix(in oklab, ${color} ${100 / (generation + 1)}%, var(--color-text))`;
  }
  let hash = 2166136261;
  for (const character of seatId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return palette[(hash >>> 0) % palette.length];
}

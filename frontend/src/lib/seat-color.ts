/** Stable accent derived from identity, never role, label, or roster position. */
const palette = [
  '#347fb5',
  '#9a65b8',
  '#b36d30',
  '#328977',
  '#b75c69',
  '#6d7cb6',
  '#927e35',
  '#537f91',
];
export function seatAccentColor(seatId: string): string {
  let hash = 2166136261;
  for (const character of seatId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return palette[(hash >>> 0) % palette.length];
}

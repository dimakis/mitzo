import type { SeatConfig } from '@mitzo/protocol';

/** Only the host-approved portable role contract enters the native system context. */
export function symposiumSeatSystemPrompt(seat: SeatConfig): string {
  const sections = [seat.systemPrompt];
  if (seat.expectedOutput) sections.push(`Expected output:\n${seat.expectedOutput}`);
  if (seat.acceptanceCriteria?.length)
    sections.push(
      `Acceptance criteria:\n${seat.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}`,
    );
  return sections.filter(Boolean).join('\n\n');
}

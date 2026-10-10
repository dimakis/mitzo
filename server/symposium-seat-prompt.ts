import type { SeatConfig, AgentContextSnapshot } from '@mitzo/protocol';

/** Only the host-approved portable role contract enters the native system context. */
export function symposiumSeatSystemPrompt(
  seat: SeatConfig,
  agentContext?: AgentContextSnapshot,
): string {
  if (seat.contextRecipe && !agentContext)
    throw new Error('Selected context recipe requires a prepared boot snapshot');
  const sections = [seat.systemPrompt];
  if (seat.expectedOutput) sections.push(`Expected output:\n${seat.expectedOutput}`);
  if (seat.acceptanceCriteria?.length)
    sections.push(
      `Acceptance criteria:\n${seat.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}`,
    );
  if (agentContext) sections.push(agentContext.context.fullMarkdown);
  return sections.filter(Boolean).join('\n\n');
}

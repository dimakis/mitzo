import { agentProfileLabel } from '@mitzo/protocol';
import { PortableProfileDefinitionSchema } from './symposium-profile-portability.js';

/** Profile behavior only; compilation and runtime grants are provided by the chat. */
export function buildAgentProfilePrompt(value: unknown): string {
  const definition = PortableProfileDefinitionSchema.parse(value);
  return [
    `# Agent profile: ${agentProfileLabel(definition)}`,
    definition.description ?? '',
    definition.instructions,
    `Expected output: ${definition.expectedOutput}`,
    `Acceptance criteria:\n${definition.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

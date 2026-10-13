import { PROFILE_BUILDER_ID, PROFILE_BUILDER_REVISION } from '@mitzo/protocol';
import type { SymposiumProfileDefinition } from '@mitzo/protocol';
import { symposiumProfileTemplates } from './symposium-profile-templates';

export const agentAdvisorPrompt = 'Help me create an agent.';
export const agentAdvisorHref = `/chat?${new URLSearchParams({
  agentProfile: PROFILE_BUILDER_ID,
  agentProfileKind: 'builtin',
  profileRevision: String(PROFILE_BUILDER_REVISION),
  prompt: agentAdvisorPrompt,
})}`;
export const newAgentDefinition = (): SymposiumProfileDefinition => ({
  name: '',
  descriptor: '',
  description: '',
  role: 'agent',
  instructions: 'Help with the task at hand. Ask for missing context when it changes the answer.',
  expectedOutput: 'A clear response with supporting evidence and next steps',
  acceptanceCriteria: ['Distinguish established facts from open questions'],
  modelPolicyRole: 'agent',
});
export const agentLibraryTemplates = symposiumProfileTemplates.map((template) => ({
  ...template,
  definition: {
    ...template.definition,
    descriptor: template.definition.name,
    description: template.definition.instructions.split('. ')[0] + '.',
  },
}));
export function agentChatHref(profileId: string, revision: number): string {
  return `/chat?${new URLSearchParams({ agentProfile: profileId, profileRevision: String(revision) })}`;
}

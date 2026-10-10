import type { SymposiumProfileDefinition } from '@mitzo/protocol';
import { symposiumProfileTemplates } from './symposium-profile-templates';

export const agentAdvisorPrompt =
  'Help me create a reusable agent profile. Ask about its job and success criteria, then propose a name, short descriptor (for example Bob, The architect), description, instructions, expected output, acceptance criteria, and optional context recipe. Use SymposiumProposeProfile to propose portable guidance for my review if that tool is available. Do not publish it or include accounts, credentials, machine paths, or runtime grants. If the tool is unavailable, explain that and return JSON for Agent Library import: {"definition":{"name":"Bob","descriptor":"The architect","description":"When to use this agent","role":"agent","instructions":"Its behavioral guidance","expectedOutput":"Its output format","acceptanceCriteria":["A measurable success criterion"],"modelPolicyRole":"agent"}}. Customize every value for the agreed job; role is a lowercase identifier. This remains a draft for my review.';
export const agentAdvisorHref = `/chat?prompt=${encodeURIComponent(agentAdvisorPrompt)}`;
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

import type { SymposiumProfileDefinition } from '@mitzo/protocol';
import { symposiumProfileTemplates } from './symposium-profile-templates';

export const agentAdvisorPrompt =
  'Help me create a reusable agent profile. Ask about its job and success criteria, then propose a name, short descriptor (for example Bob, The architect), description, instructions, expected output, and acceptance criteria. Ask whether it needs compiled context for local chats, OpenShell and Symposium. Prefer reusable published packs through contextRecipe {"version":2,"source":"packs","packs":[{"id":"verified-pack","revision":1,"hash":"verified-64-character-hash"}],"tokenBudget":4000}. Confirm each exact published id, revision and hash; never invent references or silently upgrade pins. Ask which pack combination fits the task, such as general review versus Mitzo review, and agree the final composed token budget. Version 1 workspace and ContexGin recipes remain compatible with local chats: {"version":1,"source":"workspace","files":["docs/architecture.md"],"tokenBudget":4000,"required":[],"excluded":[]} with relative Markdown references and heading paths as arrays, or {"version":1,"source":"contexgin","agentName":"configured-preset"} for an existing host-configured preset. Confirm source references with me; never invent preset names. The older recipe field is advisory reviewer setup. Published pack recipes support all three runtime paths through their existing admission and context setup. Version 1 recipes remain local-only. Context recipes never grant access. Never embed compiled context or grant access. Use SymposiumProposeProfile to propose portable guidance for my review if that tool is available. Do not publish it or include accounts, credentials, machine paths, or runtime grants. If the tool is unavailable, explain that and return JSON for Agent Library import: {"definition":{"name":"Bob","descriptor":"The architect","description":"When to use this agent","role":"agent","instructions":"Its behavioral guidance","expectedOutput":"Its output format","acceptanceCriteria":["A measurable success criterion"],"modelPolicyRole":"agent"}}. Customize every value for the agreed job; role is a lowercase identifier. This remains a draft for my review, explicit save and publication.';
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

import type { SymposiumProfileDefinition, SymposiumProfileRecipe } from '@mitzo/protocol';

const templates: [SymposiumProfileRecipe['reviewerTemplate'], string, string][] = [
  [
    'general',
    'Code correctness reviewer',
    'Review behavior, edge cases, regressions and correctness against the task and acceptance criteria.',
  ],
  [
    'security',
    'Security reviewer',
    'Review trust boundaries, input validation, authorization and credential handling. Identify concrete exploit conditions.',
  ],
  [
    'architecture',
    'Architecture critic',
    'Review component boundaries, dependencies, integration contracts and architectural tradeoffs.',
  ],
  [
    'testability',
    'Testability reviewer',
    'Review measurable acceptance criteria, test coverage, observability and reproducible validation gaps.',
  ],
  [
    'editorial',
    'Artifact/editorial critic',
    'Review the artifact for clarity, audience fit, structure, factual support and internal consistency.',
  ],
];
/** Local starters become owner catalog revisions only after an explicit save. */
export const symposiumProfileTemplates: { id: string; definition: SymposiumProfileDefinition }[] =
  templates.map(([id, name, instructions]) => ({
    id,
    definition: {
      name,
      role: 'reviewer',
      instructions: `${instructions} Read only the explicitly supplied context. Report evidence and uncertainty; do not modify artifacts.`,
      expectedOutput:
        'Prioritized findings with evidence references, impact, and suggested verification',
      acceptanceCriteria: [
        'Each finding cites supplied evidence',
        'Distinguish verified findings from uncertainty',
      ],
      modelPolicyRole: 'reviewer',
      recipe: {
        version: 1,
        reviewerTemplate: id,
        context: { include: ['task', 'diff', 'acceptance-criteria'], sources: ['workspace'] },
        skillRefs: [],
        toolDefaults: { mode: 'read-only', preferredTools: [] },
        compatibleProviders: ['anthropic-vertex', 'google-vertex', 'openai-codex', 'openai'],
      },
    },
  }));

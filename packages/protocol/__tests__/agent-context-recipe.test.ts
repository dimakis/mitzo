import { expect, it } from 'vitest';
import { AgentContextRecipeSchema, SymposiumProfileDefinitionSchema } from '../src/index.js';

const workspace = {
  version: 1,
  source: 'workspace',
  files: ['docs/architecture.md'],
  tokenBudget: 4000,
  required: [['docs/architecture.md', 'Architecture']],
  excluded: [],
};
const profile = {
  name: 'Bob',
  role: 'agent',
  instructions: 'Challenge assumptions.',
  expectedOutput: 'Decision brief',
  acceptanceCriteria: ['Use evidence'],
  modelPolicyRole: 'agent',
};

it('stores a portable workspace compiler recipe on a profile without changing legacy definitions', () => {
  expect(SymposiumProfileDefinitionSchema.parse(profile)).toEqual(profile);
  expect(AgentContextRecipeSchema.parse(workspace)).toEqual(workspace);
  expect(SymposiumProfileDefinitionSchema.parse({ ...profile, contextRecipe: workspace })).toEqual({
    ...profile,
    contextRecipe: workspace,
  });
});
it('references a configured ContexGin preset without importing its paths or provider grants', () => {
  expect(
    AgentContextRecipeSchema.parse({ version: 1, source: 'contexgin', agentName: 'architect' }),
  ).toEqual({ version: 1, source: 'contexgin', agentName: 'architect' });
  for (const extra of [
    { url: 'https://example.com' },
    { workspace: '/private' },
    { tokenBudget: 1 },
  ]) {
    expect(
      AgentContextRecipeSchema.safeParse({
        version: 1,
        source: 'contexgin',
        agentName: 'architect',
        ...extra,
      }).success,
    ).toBe(false);
  }
});
it.each([
  '/home/operator/private.md',
  '../private.md',
  'docs/../../private.md',
  'C:\\Users\\private.md',
  'docs//a.md',
  'docs/./a.md',
  '.env',
  'script.sh',
  'https://example.com/a.md',
])('rejects nonportable or non-document source %s', (file) => {
  expect(AgentContextRecipeSchema.safeParse({ ...workspace, files: [file] }).success).toBe(false);
});
it.each([0, 255, 32001, 4000.5, Number.NaN])('rejects invalid token budget %s', (tokenBudget) => {
  expect(AgentContextRecipeSchema.safeParse({ ...workspace, tokenBudget }).success).toBe(false);
});
it('bounds source and section selectors and refuses caller-supplied runtime permissions', () => {
  for (const invalid of [
    { ...workspace, files: Array(21).fill('README.md') },
    { ...workspace, required: [[]] },
    { ...workspace, excluded: [Array(9).fill('section')] },
    { ...workspace, required: Array(21).fill(['Section']) },
    { ...workspace, grants: ['read-all'] },
    { ...workspace, files: ['README.md', 'README.md'] },
  ])
    expect(AgentContextRecipeSchema.safeParse(invalid).success).toBe(false);
});

import { expect, it } from 'vitest';
import { SymposiumProfileDefinitionSchema } from '../src/symposium.js';
import { AgentToolReferencesSchema } from '../src/agent-tools.js';

it('accepts bounded portable versioned references, including explicit empty, without grants or aliases', () => {
  expect(AgentToolReferencesSchema.parse([])).toEqual([]);
  expect(AgentToolReferencesSchema.parse([{ id: 'mitzo:Read', version: 1 }])).toHaveLength(1);
  for (const value of [
    [{ id: 'mcp__mitzo-connections__Read', version: 1 }],
    [{ id: 'mitzo:Read', version: 0 }],
    [{ id: 'mitzo:Read', version: 1, connectionId: 'private' }],
    [
      { id: 'mitzo:Read', version: 1 },
      { id: 'mitzo:Read', version: 2 },
    ],
    Array.from({ length: 101 }, (_, i) => ({ id: `mitzo:Tool${i}`, version: 1 })),
  ])
    expect(AgentToolReferencesSchema.safeParse(value).success).toBe(false);
});
it('keeps absent legacy selection absent without changing serialized definitions', () => {
  const legacy = {
    name: 'Old',
    role: 'agent',
    instructions: 'Help',
    expectedOutput: 'Result',
    acceptanceCriteria: ['Correct'],
    modelPolicyRole: 'agent',
  };
  expect(JSON.stringify(SymposiumProfileDefinitionSchema.parse(legacy))).toBe(
    JSON.stringify(legacy),
  );
  expect(SymposiumProfileDefinitionSchema.parse({ ...legacy, tools: [] }).tools).toEqual([]);
});
it('requires an opaque configured receipt and excludes private launch inputs from portable references', () => {
  const ref = {
    id: `mcp:11111111-1111-4111-8111-111111111111:${'a'.repeat(64)}`,
    version: 1,
    revision: '22222222-2222-4222-8222-222222222222',
  };
  expect(AgentToolReferencesSchema.parse([ref])).toEqual([ref]);
  for (const input of [
    { id: ref.id, version: 1 },
    { ...ref, revision: 'friendly-name' },
    { ...ref, id: 'mcp:server:search' },
    { ...ref, command: 'never-export' },
    { ...ref, env: { TOKEN: 'never-export' } },
    { ...ref, cwd: '/private' },
    { ...ref, grant: 'allow' },
    { id: 'mitzo:Read', version: 1, revision: ref.revision },
  ])
    expect(AgentToolReferencesSchema.safeParse([input]).success).toBe(false);
  expect(AgentToolReferencesSchema.safeParse([ref, { ...ref, version: 2 }]).success).toBe(false);
});

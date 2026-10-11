import { expect, it } from 'vitest';
import { ContextPackDefinitionSchema, AgentContextRecipeSchema } from '../src/index.js';
const pack = {
  version: 1,
  id: 'core',
  name: 'Core',
  description: 'Shared context',
  tokenBudget: 4000,
  documents: [
    {
      path: 'architecture/core.md',
      revision: 'a'.repeat(40),
      mode: 'required',
      headings: [],
      priority: 100,
    },
  ],
  retrievalGuidance: 'Read evidence before conclusions.',
};
it('defines portable packs and pins composition without runtime authority', () => {
  expect(ContextPackDefinitionSchema.parse(pack)).toEqual(pack);
  expect(
    AgentContextRecipeSchema.parse({
      version: 2,
      source: 'packs',
      packs: [{ id: 'core', revision: 1, hash: 'b'.repeat(64) }],
      tokenBudget: 8000,
    }),
  ).toMatchObject({ source: 'packs' });
  for (const extra of [{ credentials: 'secret' }, { workspace: '/private' }, { grants: ['read'] }])
    expect(ContextPackDefinitionSchema.safeParse({ ...pack, ...extra }).success).toBe(false);
});
it('rejects unsafe references, duplicate selections and conflicting modes', () => {
  for (const path of ['../secret.md', '/private/a.md', 'https://example.com/a.md', 'docs//a.md'])
    expect(
      ContextPackDefinitionSchema.safeParse({
        ...pack,
        documents: [{ ...pack.documents[0], path }],
      }).success,
    ).toBe(false);
  expect(
    ContextPackDefinitionSchema.safeParse({
      ...pack,
      documents: [...pack.documents, ...pack.documents],
    }).success,
  ).toBe(false);
  expect(
    ContextPackDefinitionSchema.safeParse({
      ...pack,
      documents: [...pack.documents, { ...pack.documents[0], mode: 'excluded' }],
    }).success,
  ).toBe(false);
  expect(
    AgentContextRecipeSchema.safeParse({
      version: 2,
      source: 'packs',
      packs: [
        { id: 'core', revision: 1, hash: 'b'.repeat(64) },
        { id: 'core', revision: 2, hash: 'c'.repeat(64) },
      ],
      tokenBudget: 4000,
    }).success,
  ).toBe(false);
});
it.each(['name', 'description', 'retrievalGuidance', 'rationale'])(
  'rejects private material in portable %s',
  (field) => {
    for (const value of [
      '/Users/alice/private/context.md',
      'C:\\Users\\Alice\\secret.md',
      'Bearer abcdefghijklmnop',
      'api_key=secret',
      '[conversation transcript]',
      '-----BEGIN PRIVATE KEY-----',
    ])
      expect(ContextPackDefinitionSchema.safeParse({ ...pack, [field]: value }).success).toBe(
        false,
      );
  },
);
it('matches compiler selectors case insensitively when rejecting duplicate and overlapping curation', () => {
  expect(
    ContextPackDefinitionSchema.safeParse({
      ...pack,
      documents: [{ ...pack.documents[0], headings: [['Architecture'], ['architecture']] }],
    }).success,
  ).toBe(false);
  expect(
    ContextPackDefinitionSchema.safeParse({
      ...pack,
      documents: [
        { ...pack.documents[0], headings: [['Architecture']], mode: 'required' },
        { ...pack.documents[0], headings: [['architecture', 'Constraints']], mode: 'excluded' },
      ],
    }).success,
  ).toBe(false);
});

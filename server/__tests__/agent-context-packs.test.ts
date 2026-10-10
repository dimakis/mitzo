import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  compileAgentContext,
  contextDigest,
  verifyCompiledAgentContext,
} from '../agent-context-compiler.js';

const revision = 'a'.repeat(40);
const document = {
  path: 'context/architecture.md',
  revision,
  mode: 'required' as const,
  headings: [],
  priority: 100,
};
const definition = {
  version: 1 as const,
  id: 'architecture',
  name: 'Architecture',
  description: '',
  tokenBudget: 1000,
  documents: [document],
  retrievalGuidance: 'Cite the selected accepted revision.',
};
const pack = {
  id: definition.id,
  revision: 2,
  hash: contextDigest(definition),
  definition,
  publishedAt: '2026-10-10T00:00:00.000Z',
};
const recipe = {
  version: 2,
  source: 'packs',
  packs: [{ id: pack.id, revision: pack.revision, hash: pack.hash }],
  tokenBudget: 1000,
};
function adapter() {
  return {
    sourceIdentity: 'accepted-mgmt',
    resolve: vi.fn(async () => pack),
    authorize: vi.fn(async () => {}),
    assertCurrent: vi.fn(),
    readDocument: vi.fn(async () => ({
      storeId: 'accepted-mgmt',
      path: document.path,
      revision,
      content: '# Architecture\nUse immutable snapshots.',
    })),
  };
}
it('compiles exact authorized packs and pins source bytes and omission accounting', async () => {
  const packs = adapter();
  const result = await compileAgentContext(recipe, { packs });
  expect(result.context.fullMarkdown).toContain('Use immutable snapshots.');
  expect(result.context.fullMarkdown).toContain('Cite the selected accepted revision.');
  expect(result.provenance?.packs).toEqual(recipe.packs);
  expect(result.provenance?.documents).toEqual([
    {
      storeId: 'accepted-mgmt',
      path: document.path,
      revision,
      contentHash: createHash('sha256')
        .update('# Architecture\nUse immutable snapshots.')
        .digest('hex'),
    },
  ]);
  expect(packs.authorize).toHaveBeenCalledWith(document, undefined);
  expect(packs.authorize.mock.invocationCallOrder[0]).toBeLessThan(
    packs.readDocument.mock.invocationCallOrder[0],
  );
  expect(result.context.tokenCount).toBeLessThanOrEqual(recipe.tokenBudget);
  expect(packs.assertCurrent).toHaveBeenCalled();
});
it('reuses pinned payload on resume without fetching mutable sources and detects provenance tampering', async () => {
  const packs = adapter();
  const result = await compileAgentContext(recipe, { packs });
  packs.readDocument.mockRejectedValue(Error('Changed source must not be fetched'));
  expect(await verifyCompiledAgentContext(result, recipe, { packs })).toEqual(result);
  expect(packs.readDocument).toHaveBeenCalledOnce();
  await expect(
    verifyCompiledAgentContext(
      { ...result, provenance: { ...result.provenance, documents: [] } },
      recipe,
      { packs },
    ),
  ).rejects.toThrow(/hash|provenance/);
});
it('requires runtime source authorization and rejects substituted pack/source identities', async () => {
  await expect(compileAgentContext(recipe)).rejects.toThrow(/authorized|authorization/);
  const denied = adapter();
  denied.authorize.mockRejectedValue(Error('Source grant denied'));
  await expect(compileAgentContext(recipe, { packs: denied })).rejects.toThrow(
    'Source grant denied',
  );
  expect(denied.readDocument).not.toHaveBeenCalled();
  const substituted = adapter();
  substituted.resolve.mockResolvedValue({
    ...pack,
    definition: { ...definition, name: 'Changed' },
  });
  await expect(compileAgentContext(recipe, { packs: substituted })).rejects.toThrow(/pack.*hash/i);
  const wrongSource = adapter();
  wrongSource.readDocument.mockResolvedValue({
    storeId: 'accepted-mgmt',
    path: document.path,
    revision: 'b'.repeat(40),
    content: 'Substituted',
  });
  await expect(compileAgentContext(recipe, { packs: wrongSource })).rejects.toThrow(
    /source.*identity/i,
  );
});
it('keeps required source sections within budget and rejects revoked authorization before return', async () => {
  const packs = adapter();
  packs.readDocument.mockResolvedValue({
    storeId: 'accepted-mgmt',
    path: document.path,
    revision,
    content: '# Architecture\n' + 'Required guidance. '.repeat(1000),
  });
  await expect(compileAgentContext({ ...recipe, tokenBudget: 256 }, { packs })).rejects.toThrow(
    /budget/i,
  );
  const revoked = adapter();
  revoked.assertCurrent.mockImplementation(() => {
    throw Error('Grant revoked');
  });
  await expect(compileAgentContext(recipe, { packs: revoked })).rejects.toThrow('Grant revoked');
});
it('delivers every nested retrieval guidance section as required context', async () => {
  const packs = adapter();
  const nested = {
    ...definition,
    retrievalGuidance:
      '# Retrieval\nUse accepted references.\n## Exact revisions\nCite the selected source commit.\n### Boundaries\nPreserve private source grants.',
  };
  const selected = { ...pack, definition: nested, hash: contextDigest(nested) };
  packs.resolve.mockResolvedValue(selected);
  const result = await compileAgentContext(
    { ...recipe, packs: [{ id: selected.id, revision: selected.revision, hash: selected.hash }] },
    { packs },
  );
  expect(result.context.fullMarkdown).toContain('Use accepted references.');
  expect(result.context.fullMarkdown).toContain('Cite the selected source commit.');
  expect(result.context.fullMarkdown).toContain('Preserve private source grants.');
});
it('uses optional document priority during actual ContexGin budget trimming', async () => {
  const selectedDefinition = {
    ...definition,
    documents: [
      { ...document, path: 'context/low.md', mode: 'prioritized' as const, priority: 1 },
      { ...document, path: 'context/high.md', mode: 'prioritized' as const, priority: 99 },
    ],
    retrievalGuidance: '',
  };
  const selected = {
    ...pack,
    definition: selectedDefinition,
    hash: contextDigest(selectedDefinition),
  };
  const packs = {
    ...adapter(),
    resolve: async () => selected,
    readDocument: async (selection: { path: string; revision: string }) => ({
      storeId: 'accepted-mgmt',
      path: selection.path,
      revision: selection.revision,
      content:
        '# ' +
        (selection.path.includes('high') ? 'High' : 'Low') +
        '\n' +
        (selection.path.includes('high') ? 'Priority guidance. ' : 'Background advice. ').repeat(
          35,
        ),
    }),
  };
  const result = await compileAgentContext(
    {
      ...recipe,
      tokenBudget: 256,
      packs: [{ id: selected.id, revision: selected.revision, hash: selected.hash }],
    },
    { packs },
  );
  expect(result.context.fullMarkdown).toContain('Priority guidance.');
  expect(result.context.fullMarkdown).not.toContain('Background advice.');
  expect(result.provenance?.omissions).toContainEqual(
    expect.objectContaining({ path: 'context/low.md', reason: 'budget' }),
  );
});
it.each(['required', 'prioritized', 'excluded'] as const)(
  'accepts an empty selected heading in %s mode without inventing content',
  async (mode) => {
    const selectedDefinition = {
      ...definition,
      documents: [
        { ...document, headings: [['Rules']] },
        { ...document, headings: [['Appendix']], mode },
      ],
      retrievalGuidance: '',
    };
    const selected = {
      ...pack,
      definition: selectedDefinition,
      hash: contextDigest(selectedDefinition),
    };
    const packs = adapter();
    packs.resolve.mockResolvedValue(selected);
    packs.readDocument.mockResolvedValue({
      storeId: 'accepted-mgmt',
      path: document.path,
      revision,
      content: '# Rules\nKeep guidance.\n# Appendix\n',
    });
    const result = await compileAgentContext(
      { ...recipe, packs: [{ id: selected.id, revision: selected.revision, hash: selected.hash }] },
      { packs },
    );
    expect(result.context.included).toHaveLength(1);
    expect(result.context.included[0].content).toContain('Keep guidance.');
    expect(result.context.fullMarkdown).not.toContain('Appendix');
    expect(result.provenance?.omissions).toEqual([]);
  },
);
it.each([
  { content: '# Appendix\n', error: /no content/i },
  { content: '# Appendix\n# appendix\n', error: /ambiguous.*heading/i },
  { content: '# Rules\nKeep guidance.\n', error: /unavailable/i },
])(
  'rejects unusable empty-only or unavailable selections: $content',
  async ({ content, error }) => {
    const selectedDefinition = {
      ...definition,
      documents: [{ ...document, headings: [['Appendix']] }],
      retrievalGuidance: '',
    };
    const selected = {
      ...pack,
      definition: selectedDefinition,
      hash: contextDigest(selectedDefinition),
    };
    const packs = adapter();
    packs.resolve.mockResolvedValue(selected);
    packs.readDocument.mockResolvedValue({
      storeId: 'accepted-mgmt',
      path: document.path,
      revision,
      content,
    });
    await expect(
      compileAgentContext(
        {
          ...recipe,
          packs: [{ id: selected.id, revision: selected.revision, hash: selected.hash }],
        },
        { packs },
      ),
    ).rejects.toThrow(error);
  },
);
it.each([
  {
    headings: [['rules']],
    content:
      '# Rules\nKeep accepted guidance.\n# Appendix\nFirst appendix.\n# appendix\nSecond appendix.',
    included: ['Keep accepted guidance.'],
    omitted: ['First appendix.', 'Second appendix.'],
  },
  {
    headings: [['rules']],
    content:
      '# Rules\nKeep accepted guidance.\n## Detail\nFirst detail.\n## detail\nSecond detail.',
    included: ['Keep accepted guidance.', 'First detail.', 'Second detail.'],
    omitted: [],
  },
  {
    headings: [['guide', 'rules']],
    content:
      '# Guide\nIntroduction.\n## Rules\nKeep accepted guidance.\n## Appendix\nFirst appendix.\n## appendix\nSecond appendix.',
    included: ['Keep accepted guidance.'],
    omitted: ['Introduction.', 'First appendix.', 'Second appendix.'],
  },
  {
    headings: [],
    content: 'Document preamble.\n# Appendix\nFirst appendix.\n# appendix\nSecond appendix.',
    included: ['Document preamble.', 'First appendix.', 'Second appendix.'],
    omitted: [],
  },
])(
  'compiles selected paths despite unselected duplicate headings: $headings',
  async ({ headings, content, included, omitted }) => {
    const selectedDefinition = {
      ...definition,
      documents: [{ ...document, headings }],
    };
    const selected = {
      ...pack,
      definition: selectedDefinition,
      hash: contextDigest(selectedDefinition),
    };
    const packs = adapter();
    packs.resolve.mockResolvedValue(selected);
    packs.readDocument.mockResolvedValue({
      storeId: 'accepted-mgmt',
      path: document.path,
      revision,
      content,
    });
    const result = await compileAgentContext(
      { ...recipe, packs: [{ id: selected.id, revision: selected.revision, hash: selected.hash }] },
      { packs },
    );
    for (const text of included) expect(result.context.fullMarkdown).toContain(text);
    for (const text of omitted) expect(result.context.fullMarkdown).not.toContain(text);
  },
);
it.each([
  {
    headings: [['architecture']],
    mode: 'required' as const,
    content: '# Architecture\nFirst definition.\n# architecture\nConflicting second definition.',
  },
  {
    headings: [['guide', 'rules']],
    mode: 'required' as const,
    content: '# Guide\nIntroduction.\n## Rules\nFirst rules.\n## rules\nConflicting rules.',
  },
  {
    headings: [['guide'], ['guide', 'rules']],
    mode: 'prioritized' as const,
    content: '# Guide\nIntroduction.\n## Rules\nFirst rules.\n## rules\nConflicting rules.',
  },
  {
    headings: [['guide', 'rules']],
    mode: 'excluded' as const,
    content: '# Guide\nIntroduction.\n## Rules\nFirst rules.\n## rules\nConflicting rules.',
  },
])(
  'fails for requested ambiguous heading paths selected case insensitively: $headings ($mode)',
  async ({ headings, mode, content }) => {
    const selectedDefinition = {
      ...definition,
      documents: [{ ...document, headings, mode }],
    };
    const selected = {
      ...pack,
      definition: selectedDefinition,
      hash: contextDigest(selectedDefinition),
    };
    const packs = {
      ...adapter(),
      resolve: async () => selected,
      readDocument: async () => ({
        storeId: 'accepted-mgmt',
        path: document.path,
        revision,
        content,
      }),
    };
    await expect(
      compileAgentContext(
        {
          ...recipe,
          packs: [{ id: selected.id, revision: selected.revision, hash: selected.hash }],
        },
        { packs },
      ),
    ).rejects.toThrow(/ambiguous.*heading/i);
  },
);
it('bounds global nodes including excluded material before compilation', async () => {
  const selectedDefinition = {
    ...definition,
    documents: [document, { ...document, path: 'context/omitted.md', mode: 'excluded' as const }],
  };
  const selected = {
    ...pack,
    definition: selectedDefinition,
    hash: contextDigest(selectedDefinition),
  };
  const packs = {
    ...adapter(),
    resolve: async () => selected,
    readDocument: async (selection: { path: string }) => ({
      storeId: 'accepted-mgmt',
      path: selection.path,
      revision,
      content: selection.path.includes('omitted')
        ? Array.from({ length: 501 }, (_, index) => `# Section ${index}\nExcluded.`).join('\n')
        : '# Architecture\nRequired.',
    }),
  };
  await expect(
    compileAgentContext(
      { ...recipe, packs: [{ id: selected.id, revision: selected.revision, hash: selected.hash }] },
      { packs },
    ),
  ).rejects.toThrow(/too many sections/i);
});

it('reauthorizes retained provenance without source reads and rejects namespace retargeting', async () => {
  const packs = adapter();
  const result = await compileAgentContext(recipe, { packs });
  packs.resolve.mockClear();
  packs.readDocument.mockClear();
  packs.authorize.mockClear();
  await verifyCompiledAgentContext(result, recipe, { packs });
  expect(packs.authorize).toHaveBeenCalledOnce();
  expect(packs.readDocument).not.toHaveBeenCalled();
  expect(packs.resolve).not.toHaveBeenCalled();
  await expect(
    verifyCompiledAgentContext(result, recipe, {
      packs: { ...packs, sourceIdentity: 'another-source' },
    }),
  ).rejects.toThrow(/namespace|identity/i);
  packs.authorize.mockRejectedValue(Error('Grant revoked'));
  await expect(verifyCompiledAgentContext(result, recipe, { packs })).rejects.toThrow(
    'Grant revoked',
  );
  await expect(verifyCompiledAgentContext(result, recipe)).rejects.toThrow(/authorization/i);
});
it('rejects changing source bytes under one immutable identity during pack composition', async () => {
  const secondDefinition = { ...definition, id: 'second' };
  const second = {
    ...pack,
    id: 'second',
    definition: secondDefinition,
    hash: contextDigest(secondDefinition),
  };
  const packs = {
    ...adapter(),
    resolve: async (pin: { id: string }) => (pin.id === second.id ? second : pack),
  };
  packs.readDocument.mockResolvedValueOnce({
    storeId: 'accepted-mgmt',
    path: document.path,
    revision,
    content: '# Architecture\nFirst immutable version.',
  });
  packs.readDocument.mockResolvedValueOnce({
    storeId: 'accepted-mgmt',
    path: document.path,
    revision,
    content: '# Architecture\nDifferent bytes under the same source identity.',
  });
  await expect(
    compileAgentContext(
      {
        ...recipe,
        packs: [...recipe.packs, { id: second.id, revision: second.revision, hash: second.hash }],
      },
      { packs },
    ),
  ).rejects.toThrow(/source.*content|source.*changed/i);
});
it('keeps pack guidance identity distinct from similarly named accepted documents', async () => {
  const path = 'packs/architecture/retrieval-guidance.md';
  const selectedDefinition = { ...definition, documents: [{ ...document, path }] };
  const selected = {
    ...pack,
    definition: selectedDefinition,
    hash: contextDigest(selectedDefinition),
  };
  const packs = {
    ...adapter(),
    resolve: async () => selected,
    readDocument: async () => ({
      storeId: 'accepted-mgmt',
      path,
      revision,
      content: 'Accepted document instructions.',
    }),
  };
  const result = await compileAgentContext(
    { ...recipe, packs: [{ id: selected.id, revision: selected.revision, hash: selected.hash }] },
    { packs },
  );
  expect(result.context.fullMarkdown).toContain('Accepted document instructions.');
  expect(result.context.fullMarkdown).toContain(definition.retrievalGuidance);
});

it.each([false, true])(
  'counts unique source bytes across disjoint selections (shared packs: %s)',
  async (shared) => {
    const content = Array.from(
      { length: 18 },
      (_, index) => `# Section ${index}\n${'Useful guidance. '.repeat(200)}`,
    ).join('\n');
    expect(Buffer.byteLength(content)).toBeLessThan(65536);
    expect(Buffer.byteLength(content) * 18).toBeGreaterThan(1048576);
    const selections = Array.from({ length: 18 }, (_, index) => ({
      ...document,
      mode: 'prioritized' as const,
      headings: [[`Section ${index}`]],
    }));
    const definitions = shared
      ? [
          { ...definition, documents: selections.slice(0, 9), retrievalGuidance: '' },
          {
            ...definition,
            id: 'second',
            documents: selections.slice(9),
            retrievalGuidance: '',
          },
        ]
      : [{ ...definition, documents: selections, retrievalGuidance: '' }];
    const published = definitions.map((definition) => ({
      ...pack,
      id: definition.id,
      hash: contextDigest(definition),
      definition,
    }));
    const packs = {
      ...adapter(),
      resolve: vi.fn(async (pin: { id: string }) =>
        published.find((value) => value.id === pin.id)!,
      ),
    };
    packs.readDocument.mockResolvedValue({
      storeId: packs.sourceIdentity,
      path: document.path,
      revision,
      content,
    });
    const result = await compileAgentContext(
      {
        ...recipe,
        tokenBudget: 18000,
        packs: published.map(({ id, revision, hash }) => ({ id, revision, hash })),
      },
      { packs },
    );
    expect(result.provenance?.documents).toHaveLength(1);
    expect(result.context.fullMarkdown).toContain('Section 0');
    expect(result.context.fullMarkdown).toContain('Section 17');
    expect(packs.readDocument).toHaveBeenCalledTimes(18);
  },
);

it('still bounds the aggregate bytes of distinct immutable sources', async () => {
  const selectedDefinition = {
    ...definition,
    documents: Array.from({ length: 18 }, (_, index) => ({
      ...document,
      path: `context/source-${index}.md`,
      mode: 'prioritized' as const,
    })),
  };
  const selected = {
    ...pack,
    definition: selectedDefinition,
    hash: contextDigest(selectedDefinition),
  };
  const packs = {
    ...adapter(),
    resolve: async () => selected,
    readDocument: async (selection: { path: string }) => ({
      storeId: 'accepted-mgmt',
      path: selection.path,
      revision,
      content: '# Architecture\n' + 'x'.repeat(60000),
    }),
  };
  await expect(
    compileAgentContext(
      { ...recipe, packs: [{ id: selected.id, revision: selected.revision, hash: selected.hash }] },
      { packs },
    ),
  ).rejects.toThrow(/too large/i);
});

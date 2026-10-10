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
  expect(await verifyCompiledAgentContext(result, recipe)).toEqual(result);
  expect(packs.readDocument).toHaveBeenCalledOnce();
  await expect(
    verifyCompiledAgentContext(
      { ...result, provenance: { ...result.provenance, documents: [] } },
      recipe,
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

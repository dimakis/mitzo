import { afterEach, expect, it, vi } from 'vitest';
import { ContextPackStore } from '../context-pack-store.js';
import {
  createAcceptedContextPacks,
  installContextPackRuntime,
  getContextPackRuntime,
} from '../context-pack-runtime.js';

const stores: ContextPackStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const revision = 'a'.repeat(40);
function fixture() {
  const contextPacks = new ContextPackStore(':memory:');
  stores.push(contextPacks);
  const draft = contextPacks.create({
    version: 1,
    id: 'review',
    name: 'Review',
    description: '',
    tokenBudget: 1000,
    retrievalGuidance: '',
    documents: [{ path: 'review.md', revision, mode: 'required', headings: [], priority: 100 }],
  });
  const published = contextPacks.publish(draft.id, draft.version);
  const source = {
    allowed: vi.fn((path: string) => path === 'review.md'),
    read: vi.fn(async (path: string, revision: string) => ({
      path,
      revision,
      content: '# Review\nUse evidence.',
    })),
  };
  return {
    runtime: { source, contextPacks, sourceIdentity: 'github:owner/knowledge@main' },
    published,
  };
}
it('resolves only the pinned accepted pack and binds reads to the enrolled source identity', async () => {
  const { runtime, published } = fixture();
  const assertCurrent = vi.fn();
  const packs = createAcceptedContextPacks(runtime, { assertCurrent });
  expect(
    await packs.resolve({ id: published.id, revision: published.revision, hash: published.hash }),
  ).toEqual(published);
  const document = published.definition.documents[0]!;
  await packs.authorize(document);
  expect(await packs.readDocument(document)).toEqual({
    path: 'review.md',
    revision,
    content: '# Review\nUse evidence.',
    storeId: runtime.sourceIdentity,
  });
  await expect(
    packs.resolve({ id: published.id, revision: published.revision, hash: 'b'.repeat(64) }),
  ).rejects.toThrow(/hash|identity/i);
  expect(assertCurrent).toHaveBeenCalled();
});
it('rejects documents outside the host-enrolled Knowledge scope before reading', async () => {
  const { runtime, published } = fixture();
  const packs = createAcceptedContextPacks(runtime, { assertCurrent: () => {} });
  const selection = { ...published.definition.documents[0]!, path: 'private.md' };
  await expect(packs.authorize(selection)).rejects.toThrow(/scope|authorized/i);
  await expect(packs.readDocument(selection)).rejects.toThrow(/scope|authorized/i);
  expect(runtime.source.read).not.toHaveBeenCalled();
});
it('rechecks current operator authority after asynchronous accepted-source reads', async () => {
  const { runtime, published } = fixture();
  let active = true;
  runtime.source.read.mockImplementation(async (path, revision) => {
    active = false;
    return { path, revision, content: 'Private accepted source' };
  });
  const packs = createAcceptedContextPacks(runtime, {
    assertCurrent: () => {
      if (!active) throw Error('Operator revoked');
    },
  });
  await expect(packs.readDocument(published.definition.documents[0]!)).rejects.toThrow(
    'Operator revoked',
  );
});
it('uses the single trusted runtime loader and does not infer a source from a task workspace', async () => {
  expect(await getContextPackRuntime()).toBeUndefined();
  const { runtime } = fixture();
  const release = installContextPackRuntime(async () => runtime);
  try {
    expect(await getContextPackRuntime()).toBe(runtime);
  } finally {
    release();
  }
  expect(await getContextPackRuntime()).toBeUndefined();
});

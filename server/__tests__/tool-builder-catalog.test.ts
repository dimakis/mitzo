import { expect, it, vi } from 'vitest';
import { createToolBuilderCatalog } from '../tool-builder-catalog.js';
import { apiToolTemplate } from '../api-tool-template.js';
import { toolBuilderFixture } from './fixtures/tool-builder.js';

it('reads actual installed contracts and ranks overlap without treating it as equivalence', async () => {
  const f = toolBuilderFixture();
  try {
    const catalog = createToolBuilderCatalog({ store: f.store });
    const matches = await catalog.search('mitzo:Read');
    expect(matches[0]).toMatchObject({
      id: 'mitzo:Read',
      equivalent: true,
      reference: { id: 'mitzo:Read', version: 1 },
    });
    const contract = await catalog.readContract({ id: 'mitzo:Read', version: 1 });
    expect(contract).toMatchObject({ entry: { id: 'mitzo:Read' }, definition: { name: 'Read' } });
    const similar = await catalog.search('read workspace file please');
    expect(similar.length).toBeGreaterThan(0);
    expect(similar.every((match) => !match.equivalent)).toBe(true);
    await expect(catalog.readContract({ id: 'mitzo:Read', version: 999 })).rejects.toThrow(
      'Exact installed',
    );
    await expect(catalog.readContract({ id: 'mitzo:Missing', version: 1 })).rejects.toThrow();
  } finally {
    f.store.close();
  }
});

it('offers only the installed reviewed API template and no unpublished custom implementation', async () => {
  const f = toolBuilderFixture();
  try {
    f.store.save('user', 'builder', 'prepare', f.draft, 0);
    const catalog = createToolBuilderCatalog({ store: f.store });
    const matches = await catalog.search('Home Assistant entity state');
    expect(matches).toContainEqual(
      expect.objectContaining({
        id: 'template:home-assistant.state@1',
        kind: 'reviewed-template',
        equivalent: false,
      }),
    );
    expect(
      await catalog.readContract({ id: 'template:home-assistant.state@1', version: 1 }),
    ).toEqual({
      kind: 'reviewed-template',
      reference: { id: 'template:home-assistant.state@1', version: 1 },
      template: apiToolTemplate,
    });
    expect(
      (await catalog.search('Text length')).some((match) => match.id.startsWith('custom:')),
    ).toBe(false);
  } finally {
    f.store.close();
  }
});
it('does not recommend an unavailable published version as automatic equivalent reuse', async () => {
  const f = toolBuilderFixture();
  try {
    const draft = f.draft;
    f.store.save('user', 'builder', 'call', draft, 0);
    f.store.submit('user', 'builder', draft.id, 1, draft.contractDigest);
    f.store.review(
      'user',
      draft.id,
      1,
      { decision: 'accepted', feedback: '', contractDigest: draft.contractDigest },
      'user',
    );
    await f.store.publish('user', draft.id, 1, draft.contractDigest);
    const catalog = createToolBuilderCatalog({ store: f.store });
    expect(
      (await catalog.search('Text length')).find((match) => match.id === `custom:${draft.id}`)
        ?.equivalent,
    ).toBe(true);
    f.drift();
    expect(
      (await catalog.search('Text length')).find((match) => match.id === `custom:${draft.id}`)
        ?.equivalent,
    ).toBe(false);
  } finally {
    f.store.close();
  }
});

function externalOwner(kind: 'api' | 'configured') {
  const id =
    kind === 'api'
      ? 'api:11111111-1111-4111-8111-111111111111'
      : `mcp:11111111-1111-4111-8111-111111111111:${'a'.repeat(64)}`;
  const entry = {
    id,
    version: 1,
    revision: '22222222-2222-4222-8222-222222222222',
    name: 'External length',
    description: 'Count external text length',
    source: kind,
    behavior: 'read',
    required: false,
    routes: ['local-api'],
    requirement: 'Existing authority required',
  };
  let available = true;
  let listed = entry;
  const definition = {
    name: 'external_length',
    description: entry.description,
    parameters: { type: 'object' },
  };
  const resolve = vi.fn((_reference: unknown, _authority: unknown) => {
    if (!available) throw Error('Current source configuration changed');
    return { entry, definition };
  });
  const catalog = { list: () => [listed], resolve };
  const owner =
    kind === 'api' ? { api: { catalog, service: {} } } : { configured: { catalog, options: {} } };
  return {
    entry,
    definition,
    resolve,
    reference: { id, version: entry.version, revision: entry.revision },
    owner: owner as unknown as Omit<Parameters<typeof createToolBuilderCatalog>[0], 'store'>,
    revoke: () => {
      available = false;
    },
    listNewerVersion: () => {
      listed = { ...entry, version: 2, revision: '33333333-3333-4333-8333-333333333333' };
    },
  };
}
it.each(['api', 'configured'] as const)(
  'checks current %s resolution before proposing automatic reuse',
  async (kind) => {
    const f = toolBuilderFixture();
    const external = externalOwner(kind);
    try {
      const catalog = createToolBuilderCatalog({ store: f.store, ...external.owner });
      expect(
        (await catalog.search('External length')).find((match) => match.id === external.entry.id)
          ?.equivalent,
      ).toBe(true);
      external.revoke();
      expect(
        (await catalog.search('External length')).find((match) => match.id === external.entry.id)
          ?.equivalent,
      ).toBe(false);
      expect(external.resolve).toHaveBeenCalledTimes(2);
      expect(external.resolve.mock.calls[0][0]).toEqual(external.reference);
    } finally {
      f.store.close();
    }
  },
);
it.each(['api', 'configured'] as const)(
  'reads exact older %s references through their owner after a newer publication',
  async (kind) => {
    const f = toolBuilderFixture();
    const external = externalOwner(kind);
    try {
      external.listNewerVersion();
      const catalog = createToolBuilderCatalog({ store: f.store, ...external.owner });
      expect(await catalog.readContract(external.reference)).toMatchObject({
        entry: external.entry,
        definition: external.definition,
      });
      external.revoke();
      await expect(catalog.readContract(external.reference)).rejects.toThrow('changed');
    } finally {
      f.store.close();
    }
  },
);
it('reads an older accepted custom version after a newer publication without changing its receipt', async () => {
  const f = toolBuilderFixture();
  try {
    const second = { ...f.draft, version: 2 };
    f.installDraft(second);
    const publish = async (draft: typeof f.draft, expected: number) => {
      f.store.save('user', 'builder', `call-${draft.version}`, draft, expected);
      f.store.submit('user', 'builder', draft.id, draft.version, draft.contractDigest);
      f.store.review(
        'user',
        draft.id,
        draft.version,
        { decision: 'accepted', feedback: '', contractDigest: draft.contractDigest },
        'user',
      );
      return f.store.publish('user', draft.id, draft.version, draft.contractDigest);
    };
    const first = await publish(f.draft, 0);
    await publish(second, 1);
    expect(f.store.listTools('user').map((entry) => entry.version)).toEqual([2]);
    expect(f.store.resolve('user', first.reference)).toEqual(first);
    const catalog = createToolBuilderCatalog({ store: f.store });
    expect(await catalog.readContract(first.reference)).toMatchObject({
      entry: first.entry,
      definition: first.binding.definition,
      outputSchema: f.draft.outputSchema,
    });
    expect(f.store.resolve('user', first.reference)).toEqual(first);
  } finally {
    f.store.close();
  }
});

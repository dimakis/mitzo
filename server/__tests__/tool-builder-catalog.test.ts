import { expect, it } from 'vitest';
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

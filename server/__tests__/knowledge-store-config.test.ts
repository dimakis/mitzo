import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgeStoreFromEnvironment } from '../knowledge-store-config.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-knowledge-config-')));
  roots.push(root);
  const publisherConfig = join(root, 'publisher.json');
  const adapterConfig = join(root, 'adapter.json');
  const configPath = join(root, 'stores.json');
  const source = {
    id: 'other-store',
    url: 'https://example.com/other.git',
    ref: 'refs/tags/accepted',
    paths: ['AGENTS.md'],
  };
  writeFileSync(
    publisherConfig,
    JSON.stringify({
      root: join(root, 'publisher'),
      readTokenEnv: 'TEST_PUBLICATION_TOKEN',
      sources: [source],
    }),
  );
  writeFileSync(
    adapterConfig,
    JSON.stringify({
      root: join(root, 'adapter'),
      sourceUrl: source.url,
      mitzoRepo: join(root, 'mitzo'),
      builderCommit: 'a'.repeat(40),
    }),
  );
  mkdirSync(join(root, 'adapter'), { mode: 0o700 });
  const config = {
    defaultStore: source.id,
    stores: [
      {
        id: source.id,
        publisherUrl: 'http://127.0.0.1:8643',
        publisherConfig,
        adapter: {
          kind: 'mgmt-v1',
          release: join(root, 'adapter-release'),
          releaseCommit: 'b'.repeat(40),
          python: '/usr/bin/python3',
          config: adapterConfig,
        },
      },
    ],
  };
  writeFileSync(configPath, JSON.stringify(config));
  return { root, configPath, config, publisherConfig, adapterConfig };
}
it('is opt-in and loads a different store and accepted ref from the publisher configuration', () => {
  expect(knowledgeStoreFromEnvironment({})).toBeUndefined();
  const f = fixture();
  const store = knowledgeStoreFromEnvironment({
    MITZO_KNOWLEDGE_STORE_CONFIG: f.configPath,
    TEST_PUBLICATION_TOKEN: 'secret',
  });
  expect(store?.id).toBe('other-store');
});
it.each(['secret', 'source', 'default', 'adapter'])(
  'rejects incomplete %s configuration before enrollment',
  (kind) => {
    const f = fixture();
    if (kind === 'source')
      writeFileSync(
        f.adapterConfig,
        JSON.stringify({ sourceUrl: 'https://wrong.example/notes.git' }),
      );
    if (kind === 'default') f.config.defaultStore = 'missing';
    if (kind === 'adapter') (f.config.stores[0].adapter as { kind: string }).kind = 'unsupported';
    writeFileSync(f.configPath, JSON.stringify(f.config));
    expect(() =>
      knowledgeStoreFromEnvironment({
        MITZO_KNOWLEDGE_STORE_CONFIG: f.configPath,
        ...(kind !== 'secret' ? { TEST_PUBLICATION_TOKEN: 'secret' } : {}),
      }),
    ).toThrow();
  },
);

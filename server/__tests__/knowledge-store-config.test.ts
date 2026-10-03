import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgeStoreFromEnvironment, mgmtKnowledgeAdapter } from '../knowledge-store-config.js';
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
          kind: 'mgmt-v1' as const,
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

it('revalidates private adapter state before each execution', async () => {
  const f = fixture();
  const adapter = mgmtKnowledgeAdapter(f.config.stores[0].adapter, 'https://example.com/other.git');
  chmodSync(join(f.root, 'adapter'), 0o777);
  await expect(adapter({ revision: 'c'.repeat(40) }, new AbortController().signal)).rejects.toThrow(
    'Knowledge adapter state must be private and physical',
  );
});

it.each(['physical', 'symlink'])(
  'requires a %s publications directory while running the pinned adapter',
  async (kind) => {
    const f = fixture();
    const release = join(f.root, 'release');
    mkdirSync(join(release, 'mgmt_lib'), { recursive: true });
    writeFileSync(join(release, '.gitignore'), '__pycache__/\n');
    writeFileSync(join(release, 'mgmt_lib/__init__.py'), '');
    writeFileSync(
      join(release, 'mgmt_lib/knowledge_publication.py'),
      `
import argparse, hashlib, json, pathlib
p=argparse.ArgumentParser()
p.add_argument('--config')
p.add_argument('--once', action='store_true')
p.add_argument('--published-revision')
a=p.parse_args()
c=json.loads(pathlib.Path(a.config).read_text())
root=pathlib.Path(c['root'])/'publications'
bundle=root/('release-'+a.published_revision)
(bundle/'mgmt').mkdir(parents=True, exist_ok=True)
baseline={'startingCommit':a.published_revision,'payloadSha256':'f'*64}
raw=json.dumps(baseline)
(bundle/'baseline.json').write_text(raw)
receipt={'sourceCommit':a.published_revision,'builderCommit':c['builderCommit'],'payloadSha256':'f'*64,'baselineSha256':hashlib.sha256(raw.encode()).hexdigest()}
(bundle/'publication.json').write_text(json.dumps(receipt))
(root/'current').symlink_to(bundle)
print(json.dumps({'status':'current','publishedCommit':a.published_revision,'receipt':receipt}))
`,
    );
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', release, ...args],
        { encoding: 'utf8' },
      ).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    git('add', '.');
    git('commit', '-qm', 'test: adapter fixture');
    const releaseCommit = git('rev-parse', 'HEAD');
    git('checkout', '-q', '--detach');
    const adapter = mgmtKnowledgeAdapter(
      {
        kind: 'mgmt-v1',
        release,
        releaseCommit,
        python: '/usr/bin/python3',
        config: f.adapterConfig,
      },
      f.config.stores[0] ? 'https://example.com/other.git' : '',
    );
    const revision = 'c'.repeat(40);
    if (kind === 'symlink') {
      mkdirSync(join(f.root, 'outside'));
      symlinkSync(join(f.root, 'outside'), join(f.root, 'adapter/publications'));
      await expect(adapter({ revision }, AbortSignal.timeout(5000))).rejects.toThrow(
        'Knowledge bundle escaped adapter state',
      );
      return;
    }
    const result = await adapter({ revision }, AbortSignal.timeout(5000));
    expect(result).toEqual({
      sourceCommit: revision,
      seed: join(f.root, 'adapter/publications/release-' + revision, 'mgmt'),
      baselineSha256: JSON.parse(readFileSync(join(result.seed, '..', 'publication.json'), 'utf8'))
        .baselineSha256,
    });
    writeFileSync(join(release, 'dirty.md'), 'unreviewed adapter code');
    await expect(adapter({ revision }, AbortSignal.timeout(5000))).rejects.toThrow(
      'clean pinned detached release',
    );
  },
);

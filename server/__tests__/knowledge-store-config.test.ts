import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  chmodSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgeStoreFromEnvironment, mgmtKnowledgeAdapter } from '../knowledge-store-config.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
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

it.each([
  'physical',
  'symlink',
  'advanced-current',
  'missing-directory',
  'foreign-directory',
  'aliased-directory',
  'cached',
  'cached-file-tamper',
  'cached-extra-file',
  'cached-mode-tamper',
  'cached-metadata-tamper',
  'cached-new-revision',
  'cached-config-change',
  'combined-probe',
  'wrong-commit',
  'attached',
  'detached-named-branch',
  'linked-worktree',
  'tracked-dirty',
  'staged-dirty',
  'untracked-directory',
  'missing-release',
])('requires a %s publications directory while running the pinned adapter', async (kind) => {
  const f = fixture();
  let release = join(f.root, 'release');
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
state_root=pathlib.Path(c['root'])
counter=state_root/'adapter-calls'
counter.write_text(str(int(counter.read_text())+1 if counter.exists() else 1))
root=state_root/'publications'
bundle=root/('release-'+a.published_revision)
(bundle/'mgmt').mkdir(parents=True, exist_ok=True)
(bundle/'mgmt/AGENTS.md').write_text('accepted instructions')
(bundle/'mgmt/AGENTS.md').chmod(0o600)
baseline={'startingCommit':a.published_revision,'payloadSha256':'f'*64,'files':{'AGENTS.md':{'sha256':hashlib.sha256(b'accepted instructions').hexdigest(),'mode':'0600'}}}
raw=json.dumps(baseline)
(bundle/'baseline.json').write_text(raw)
receipt={'sourceCommit':a.published_revision,'builderCommit':c['builderCommit'],'payloadSha256':'f'*64,'baselineSha256':hashlib.sha256(raw.encode()).hexdigest()}
(bundle/'publication.json').write_text(json.dumps(receipt))
current=bundle
if c.get('fixtureMode')=='advanced-current':
 current=root/'later-release'
 current.mkdir()
if (root/'current').is_symlink(): (root/'current').unlink()
(root/'current').symlink_to(current)
output={'status':'current','publishedCommit':a.published_revision,'receipt':receipt,'publicationDirectory':str(bundle)}
if c.get('fixtureMode')=='missing-directory': del output['publicationDirectory']
if c.get('fixtureMode')=='foreign-directory': output['publicationDirectory']=str(root.parent/'outside')
if c.get('fixtureMode')=='aliased-directory':
 (root/'alias').symlink_to(bundle)
 output['publicationDirectory']=str(root/'alias')
output.update(builderCommit=c['builderCommit'],publishedSourceUrl=c['sourceUrl'])
(state_root/'state.json').write_text(json.dumps(output, sort_keys=True))
print(json.dumps(output))
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
  if (kind === 'linked-worktree') {
    const linked = join(f.root, 'linked-release');
    git('worktree', 'add', '-q', '--detach', linked, releaseCommit);
    release = linked;
  }
  const adapterConfiguration = JSON.parse(readFileSync(f.adapterConfig, 'utf8'));
  writeFileSync(f.adapterConfig, JSON.stringify({ ...adapterConfiguration, fixtureMode: kind }));
  const adapter = mgmtKnowledgeAdapter(
    {
      kind: 'mgmt-v1',
      release,
      releaseCommit: kind === 'wrong-commit' ? '0'.repeat(40) : releaseCommit,
      python: '/usr/bin/python3',
      config: f.adapterConfig,
    },
    f.config.stores[0] ? 'https://example.com/other.git' : '',
  );
  const revision = 'c'.repeat(40);
  const probeCases = [
    'combined-probe',
    'wrong-commit',
    'attached',
    'detached-named-branch',
    'linked-worktree',
    'tracked-dirty',
    'staged-dirty',
    'untracked-directory',
    'missing-release',
  ];
  const gitCalls = join(f.root, 'git-calls');
  if (probeCases.includes(kind)) {
    const bin = join(f.root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$MITZO_TEST_ADAPTER_GIT_CALLS"\nexec /usr/bin/git "$@"\n`,
      { mode: 0o700 },
    );
    // Observe the real subprocess boundary without replacing Git's parser/output.
    vi.stubEnv('PATH', bin + ':' + process.env.PATH);
    vi.stubEnv('MITZO_TEST_ADAPTER_GIT_CALLS', gitCalls);
    if (kind === 'attached') git('checkout', '-q', 'main');
    if (kind === 'detached-named-branch') git('checkout', '-q', '-b', '(detached)');
    if (kind === 'tracked-dirty')
      writeFileSync(join(release, '.gitignore'), '# unaccepted change\n');
    if (kind === 'staged-dirty') {
      writeFileSync(join(release, '.gitignore'), '# staged change\n');
      git('add', '.gitignore');
    }
    if (kind === 'untracked-directory') {
      mkdirSync(join(release, 'untracked'));
      writeFileSync(join(release, 'untracked/file.md'), 'not accepted');
    }
    if (kind === 'missing-release') rmSync(release, { recursive: true });
    // Fixture setup uses execFileSync; count only adapter admission subprocesses.
    writeFileSync(gitCalls, '');
    if (!['combined-probe', 'linked-worktree'].includes(kind)) {
      const result = expect(adapter({ revision }, AbortSignal.timeout(5000))).rejects;
      if (kind === 'missing-release') await result.toThrow();
      else await result.toThrow('clean pinned detached release');
      expect(readFileSync(gitCalls, 'utf8').trim().split('\n')).toHaveLength(
        kind === 'detached-named-branch' ? 2 : 1,
      );
      expect(existsSync(join(f.root, 'adapter/adapter-calls'))).toBe(false);
      return;
    }
  }
  if (kind === 'symlink') {
    mkdirSync(join(f.root, 'outside'));
    symlinkSync(join(f.root, 'outside'), join(f.root, 'adapter/publications'));
    await expect(adapter({ revision }, AbortSignal.timeout(5000))).rejects.toThrow(
      'Knowledge bundle escaped adapter state',
    );
    return;
  }
  if (['missing-directory', 'foreign-directory', 'aliased-directory'].includes(kind)) {
    await expect(adapter({ revision }, AbortSignal.timeout(5000))).rejects.toThrow(
      'Knowledge adapter returned unsafe publication directory',
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
  if (['combined-probe', 'linked-worktree'].includes(kind)) {
    expect(readFileSync(gitCalls, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(await adapter({ revision }, AbortSignal.timeout(5000))).toEqual(result);
    expect(readFileSync(gitCalls, 'utf8').trim().split('\n')).toHaveLength(4);
    expect(readFileSync(join(f.root, 'adapter/adapter-calls'), 'utf8')).toBe('1');
  }
  if (kind.startsWith('cached')) {
    const file = join(result.seed, 'AGENTS.md');
    if (kind === 'cached-file-tamper') writeFileSync(file, 'unaccepted instructions');
    if (kind === 'cached-extra-file') writeFileSync(join(result.seed, 'extra.md'), 'extra');
    if (kind === 'cached-mode-tamper') chmodSync(file, 0o777);
    if (kind === 'cached-metadata-tamper')
      writeFileSync(join(result.seed, '..', 'baseline.json'), '{}');
    if (kind === 'cached-config-change')
      writeFileSync(
        f.adapterConfig,
        JSON.stringify({ ...adapterConfiguration, builderCommit: 'd'.repeat(40) }),
      );
    if (
      kind.includes('tamper') ||
      kind === 'cached-extra-file' ||
      kind === 'cached-config-change'
    ) {
      await expect(adapter({ revision }, AbortSignal.timeout(5000))).rejects.toThrow();
      expect(readFileSync(join(f.root, 'adapter/adapter-calls'), 'utf8')).toBe('1');
      return;
    }
    const nextRevision = kind === 'cached-new-revision' ? 'd'.repeat(40) : revision;
    const next = await adapter({ revision: nextRevision }, AbortSignal.timeout(5000));
    expect(next.sourceCommit).toBe(nextRevision);
    expect(readFileSync(join(f.root, 'adapter/adapter-calls'), 'utf8')).toBe(
      kind === 'cached-new-revision' ? '2' : '1',
    );
  }
  writeFileSync(join(release, 'dirty.md'), 'unreviewed adapter code');
  await expect(adapter({ revision }, AbortSignal.timeout(5000))).rejects.toThrow(
    'clean pinned detached release',
  );
});

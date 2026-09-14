import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function writeRuntimeInputs(source: string, dependencies = ['runtime-dependency==1']) {
  writeFileSync(
    join(source, 'pyproject.toml'),
    `[project]\nname = "fixture"\nrequires-python = ">=3.11"\ndependencies = [${dependencies.map((item) => `"${item}"`).join(', ')}]\n\n[build-system]\nrequires = ["setuptools>=1"]\n`,
  );
  writeFileSync(join(source, 'uv.lock'), 'version = 1\n');
}

function currentCommit(source: string) {
  return execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function writeMemoryManifests(source: string, sourceCommit: string) {
  const manifest = join(source, 'memory', 'manifest');
  writeFileSync(
    join(manifest, 'index.json'),
    JSON.stringify({ sourceCommit, total_memories: 0, memories: [] }) + '\n',
  );
  writeFileSync(
    join(manifest, 'wikilinks.json'),
    JSON.stringify({ sourceCommit, forward_links: {}, backlinks: {}, total_links: 0 }) + '\n',
  );
  writeFileSync(join(manifest, 'by_type.json'), JSON.stringify({ sourceCommit, types: {} }) + '\n');
  writeFileSync(join(manifest, 'by_tag.json'), JSON.stringify({ sourceCommit, tags: {} }) + '\n');
}

it('builds a versioned MGMT seed without host credentials or repository administration', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-mgmt-seed-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  mkdirSync(source);
  writeRuntimeInputs(source);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(source, 'AGENTS.md'), '# Synthetic instructions\n');
  writeFileSync(join(source, 'work.txt'), 'tracked\n');
  writeFileSync(join(source, '.env.local'), 'TRACKED_SECRET=must-not-copy\n');
  writeFileSync(join(source, '.npmrc'), '//registry.invalid/:_authToken=must-not-copy\n');
  writeFileSync(join(source, 'client.key'), 'synthetic-private-key\n');
  mkdirSync(join(source, '.ssh'));
  writeFileSync(join(source, '.ssh', 'id_ed25519'), 'synthetic-private-key\n');
  mkdirSync(join(source, 'src'));
  writeFileSync(join(source, 'src', 'credentials.json'), '{"token":"must-not-copy"}\n');
  writeFileSync(join(source, 'src', 'client_secret_fixture.json'), '{"secret":"no"}\n');
  mkdirSync(join(source, 'memory', 'manifest'), { recursive: true });
  writeFileSync(join(source, 'memory', 'manifest', '.gitignore'), '*.json\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'fixture',
  ]);
  writeFileSync(join(source, '.env'), 'SYNTHETIC_SECRET=must-not-copy\n');
  writeFileSync(join(source, '.netrc'), 'password must-not-copy\n');
  writeFileSync(join(source, 'certificate.pem'), 'synthetic-certificate\n');
  writeFileSync(join(source, 'work.txt'), 'working tree overlay\n');
  writeMemoryManifests(source, currentCommit(source));
  writeFileSync(join(source, 'memory', 'manifest', 'secret-export.json'), '{"secret":"no"}\n');

  execFileSync(
    'bash',
    [resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'), source, output],
    { cwd: resolve('.') },
  );

  const workspace = join(output, 'mgmt');
  expect(readFileSync(join(workspace, 'work.txt'), 'utf8')).toBe('tracked\n');
  expect(
    JSON.parse(readFileSync(join(workspace, 'memory', 'manifest', 'index.json'), 'utf8')),
  ).toMatchObject({
    sourceCommit: currentCommit(source),
    total_memories: 0,
    memories: [],
  });
  expect(() => readFileSync(join(workspace, '.env'), 'utf8')).toThrow();
  for (const path of [
    '.env.local',
    '.npmrc',
    '.netrc',
    'client.key',
    'certificate.pem',
    join('.ssh', 'id_ed25519'),
    join('src', 'credentials.json'),
    join('src', 'client_secret_fixture.json'),
    join('memory', 'manifest', 'secret-export.json'),
  ]) {
    expect(() => readFileSync(join(workspace, path), 'utf8')).toThrow();
  }
  expect(execFileSync('git', ['-C', workspace, 'status', '--short'], { encoding: 'utf8' })).toBe(
    '',
  );
  expect(
    execFileSync('git', ['-C', workspace, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim(),
  ).toBe('chore: seed isolated MGMT workspace');
  const baseline = JSON.parse(readFileSync(join(output, 'baseline.json'), 'utf8'));
  expect(baseline.startingCommit).toMatch(/^[a-f0-9]{40,64}$/);
  expect(baseline.runtimeBaseCommit).toBe(baseline.startingCommit);
  expect(baseline.saveBack).toBe('not-implemented');
  expect(existsSync(join(root, '.output.lock'))).toBe(false);
});

it('fails closed when a required rebuilt memory manifest is missing', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-mgmt-seed-missing-manifest-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  mkdirSync(join(source, 'memory', 'manifest'), { recursive: true });
  writeRuntimeInputs(source);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(source, 'memory', 'manifest', '.gitignore'), '*.json\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'fixture',
  ]);
  writeMemoryManifests(source, currentCommit(source));
  unlinkSync(join(source, 'memory', 'manifest', 'wikilinks.json'));

  expect(() =>
    execFileSync(
      'bash',
      [resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'), source, output],
      { cwd: resolve('.'), stdio: 'pipe' },
    ),
  ).toThrow();
  expect(existsSync(output)).toBe(false);
  expect(existsSync(join(root, '.output.lock'))).toBe(false);
});

it('fails closed when a rebuilt memory manifest is inconsistent', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-mgmt-seed-missing-manifest-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  mkdirSync(join(source, 'memory', 'manifest'), { recursive: true });
  writeRuntimeInputs(source);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(source, 'memory', 'manifest', '.gitignore'), '*.json\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'fixture',
  ]);
  writeMemoryManifests(source, currentCommit(source));
  writeFileSync(join(source, 'memory', 'manifest', 'by_tag.json'), '{"wrong":true}\n');

  expect(() =>
    execFileSync(
      'bash',
      [resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'), source, output],
      { cwd: resolve('.'), stdio: 'pipe' },
    ),
  ).toThrow();
  expect(existsSync(output)).toBe(false);
  expect(existsSync(join(root, '.output.lock'))).toBe(false);
});

it('rejects manifest provenance that does not attest to the archived starting commit', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-mgmt-seed-provenance-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  mkdirSync(join(source, 'memory', 'manifest'), { recursive: true });
  writeRuntimeInputs(source);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(source, 'memory', 'manifest', '.gitignore'), '*.json\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'fixture',
  ]);
  writeMemoryManifests(source, 'a'.repeat(40));

  expect(() =>
    execFileSync(
      'bash',
      [resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'), source, output],
      { cwd: resolve('.'), stdio: 'pipe' },
    ),
  ).toThrow();
  expect(existsSync(output)).toBe(false);
});

it('records an explicit runtime base ref as its canonical commit', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-mgmt-seed-runtime-base-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  mkdirSync(source);
  writeRuntimeInputs(source);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(source, 'requirements.txt'), 'runtime-dependency==1\n');
  mkdirSync(join(source, 'memory', 'manifest'), { recursive: true });
  writeFileSync(join(source, 'memory', 'manifest', '.gitignore'), '*.json\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'runtime base',
  ]);
  const runtimeBaseCommit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  writeFileSync(join(source, 'knowledge.md'), '# New knowledge\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'knowledge update',
  ]);
  const startingCommit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  writeMemoryManifests(source, currentCommit(source));

  execFileSync(
    'bash',
    [resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'), source, output, 'HEAD~1'],
    { cwd: resolve('.') },
  );

  const baseline = JSON.parse(readFileSync(join(output, 'baseline.json'), 'utf8'));
  expect(baseline.startingCommit).toBe(startingCommit);
  expect(baseline.runtimeBaseCommit).toBe(runtimeBaseCommit);
});

it('rejects runtime dependency changes after the runtime base commit', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-mgmt-seed-runtime-inputs-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  mkdirSync(join(source, 'memory', 'manifest'), { recursive: true });
  writeRuntimeInputs(source);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(source, 'memory', 'manifest', '.gitignore'), '*.json\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'runtime base',
  ]);
  writeRuntimeInputs(source, ['runtime-dependency==2']);
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'runtime dependency change',
  ]);
  writeMemoryManifests(source, currentCommit(source));

  expect(() =>
    execFileSync(
      'bash',
      [resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'), source, output, 'HEAD~1'],
      { cwd: resolve('.'), stdio: 'pipe' },
    ),
  ).toThrow();
  expect(existsSync(output)).toBe(false);
});

it('rejects a changed uv.lock after the runtime base commit', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-mgmt-seed-runtime-lock-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  mkdirSync(join(source, 'memory', 'manifest'), { recursive: true });
  writeRuntimeInputs(source);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(source, 'memory', 'manifest', '.gitignore'), '*.json\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'runtime base',
  ]);
  writeFileSync(join(source, 'uv.lock'), 'version = 2\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'lockfile change',
  ]);
  writeMemoryManifests(source, currentCommit(source));

  expect(() =>
    execFileSync(
      'bash',
      [resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'), source, output, 'HEAD~1'],
      { cwd: resolve('.'), stdio: 'pipe' },
    ),
  ).toThrow();
  expect(existsSync(output)).toBe(false);
});

it('allows a dev or build-system-only change after the runtime base commit', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-mgmt-seed-dev-inputs-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  mkdirSync(join(source, 'memory', 'manifest'), { recursive: true });
  writeRuntimeInputs(source);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(source, 'memory', 'manifest', '.gitignore'), '*.json\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'runtime base',
  ]);
  writeFileSync(
    join(source, 'pyproject.toml'),
    readFileSync(join(source, 'pyproject.toml'), 'utf8').replace('setuptools>=1', 'setuptools>=2'),
  );
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'build dependency change',
  ]);
  writeMemoryManifests(source, currentCommit(source));

  expect(() =>
    execFileSync(
      'bash',
      [resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'), source, output, 'HEAD~1'],
      { cwd: resolve('.') },
    ),
  ).not.toThrow();
});

it('rejects a runtime base that is not an ancestor of the seed starting commit', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-mgmt-seed-nonancestor-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  mkdirSync(join(source, 'memory', 'manifest'), { recursive: true });
  writeRuntimeInputs(source);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(source, 'memory', 'manifest', '.gitignore'), '*.json\n');
  writeFileSync(join(source, 'base.txt'), 'base\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', ['-C', source, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base']);
  execFileSync('git', ['-C', source, 'checkout', '-q', '-b', 'runtime-side']);
  writeFileSync(join(source, 'runtime.txt'), 'runtime side\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'runtime',
  ]);
  const unrelatedRuntimeBase = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  execFileSync('git', ['-C', source, 'checkout', '-q', '-']);
  writeFileSync(join(source, 'knowledge.md'), 'knowledge\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'knowledge',
  ]);
  writeMemoryManifests(source, currentCommit(source));

  expect(() =>
    execFileSync(
      'bash',
      [
        resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'),
        source,
        output,
        unrelatedRuntimeBase,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    ),
  ).toThrow();
  expect(existsSync(output)).toBe(false);
});

it('never overwrites an existing versioned seed', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-mgmt-seed-existing-output-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  mkdirSync(join(source, 'memory', 'manifest'), { recursive: true });
  writeRuntimeInputs(source);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(source, 'memory', 'manifest', '.gitignore'), '*.json\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'fixture',
  ]);
  writeMemoryManifests(source, currentCommit(source));
  mkdirSync(output);
  writeFileSync(join(output, 'must-remain'), 'preserved\n');

  expect(() =>
    execFileSync(
      'bash',
      [resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'), source, output],
      { cwd: resolve('.'), stdio: 'pipe' },
    ),
  ).toThrow();
  expect(readFileSync(join(output, 'must-remain'), 'utf8')).toBe('preserved\n');
});

it('rejects a symlinked memory-manifest parent that escapes the source repository', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-mgmt-seed-manifest-parent-symlink-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  const outside = join(root, 'outside');
  mkdirSync(join(source, 'memory', 'manifest'), { recursive: true });
  mkdirSync(join(outside, 'memory', 'manifest'), { recursive: true });
  writeRuntimeInputs(source);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(source, 'memory', 'manifest', '.gitignore'), '*.json\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'fixture',
  ]);
  writeMemoryManifests(outside, currentCommit(source));
  rmSync(join(source, 'memory'), { recursive: true, force: true });
  symlinkSync(join(outside, 'memory'), join(source, 'memory'), 'dir');

  expect(() =>
    execFileSync(
      'bash',
      [resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'), source, output],
      { cwd: resolve('.'), stdio: 'pipe' },
    ),
  ).toThrow();
  expect(existsSync(output)).toBe(false);
});

it('rejects concurrent publishers without leaving an output, temp directory, or lock', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-mgmt-seed-publish-lock-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  mkdirSync(join(source, 'memory', 'manifest'), { recursive: true });
  writeRuntimeInputs(source);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(source, 'memory', 'manifest', '.gitignore'), '*.json\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'fixture',
  ]);
  writeMemoryManifests(source, currentCommit(source));
  const concurrentLock = join(root, '.output.lock');
  mkdirSync(concurrentLock);

  expect(() =>
    execFileSync(
      'bash',
      [resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'), source, output],
      { cwd: resolve('.'), stdio: 'pipe' },
    ),
  ).toThrow();
  expect(existsSync(output)).toBe(false);
  expect(readdirSync(root).filter((entry) => entry.startsWith('.output.tmp.'))).toEqual([]);
  rmSync(concurrentLock, { recursive: true, force: true });
});

it('rejects a tracked symlink before an overlay can write through it', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-mgmt-seed-symlink-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  const outside = join(root, 'outside');
  mkdirSync(source);
  mkdirSync(outside);
  writeRuntimeInputs(source);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  symlinkSync(outside, join(source, 'redirect'), 'dir');
  execFileSync('git', ['-C', source, 'add', 'redirect']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'tracked symlink',
  ]);
  unlinkSync(join(source, 'redirect'));
  mkdirSync(join(source, 'redirect'));
  writeFileSync(join(source, 'redirect', 'escaped.txt'), 'must stay contained\n');

  expect(() =>
    execFileSync(
      'bash',
      [resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'), source, output],
      { cwd: resolve('.'), stdio: 'pipe' },
    ),
  ).toThrow();
  expect(existsSync(join(outside, 'escaped.txt'))).toBe(false);
});

it('serializes ContexGin maps and trimmed sections into the sandbox boot-context schema', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-mgmt-context-'));
  const modulePath = join(root, 'contexgin-fixture.mjs');
  writeFileSync(
    modulePath,
    `export async function compile() {
      return {
        bootPayload: '# Context',
        bootTokens: 2,
        sources: [{ relativePath: 'AGENTS.md', kind: 'reference' }],
        contextBlocks: new Map([['Current task', 'Ship safely']]),
        trimmed: [{
          source: { path: '/sandbox/workspaces/mgmt/memory.md', relativePath: 'memory.md' },
          headingPath: ['History'],
          tokenEstimate: 3,
          content: 'Older context'
        }]
      };
    }`,
  );

  const output = execFileSync(
    process.execPath,
    [
      resolve('docs/spikes/openshell-codex/compile-mgmt-context.mjs'),
      '/sandbox/workspaces/mgmt',
      '12000',
    ],
    {
      cwd: resolve('.'),
      env: { ...process.env, MITZO_CONTEXGIN_MODULE: modulePath },
      encoding: 'utf8',
    },
  );
  expect(JSON.parse(output)).toMatchObject({
    included: [
      { source: 'Current task', heading: 'Current task', tokens: 3, content: 'Ship safely' },
    ],
    trimmed: [{ source: 'memory.md', heading: 'History', tokens: 3, content: 'Older context' }],
  });
});

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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

it('builds a versioned MGMT seed without host credentials or repository administration', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-mgmt-seed-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  mkdirSync(source);
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

  execFileSync(
    'bash',
    [resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'), source, output],
    { cwd: resolve('.') },
  );

  const workspace = join(output, 'mgmt');
  expect(readFileSync(join(workspace, 'work.txt'), 'utf8')).toBe('working tree overlay\n');
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
  expect(baseline.saveBack).toBe('not-implemented');
});

it('rejects a tracked symlink before an overlay can write through it', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-mgmt-seed-symlink-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  const outside = join(root, 'outside');
  mkdirSync(source);
  mkdirSync(outside);
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

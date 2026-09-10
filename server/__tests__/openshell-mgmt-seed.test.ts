import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  writeFileSync(join(source, 'work.txt'), 'working tree overlay\n');

  execFileSync(
    'bash',
    [resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'), source, output],
    { cwd: resolve('.') },
  );

  const workspace = join(output, 'mgmt');
  expect(readFileSync(join(workspace, 'work.txt'), 'utf8')).toBe('working tree overlay\n');
  expect(() => readFileSync(join(workspace, '.env'), 'utf8')).toThrow();
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

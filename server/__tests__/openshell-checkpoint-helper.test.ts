import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
const helper = join(process.cwd(), 'docs/spikes/openshell-codex/mitzo-checkpoint.py');
function root() {
  const value = mkdtempSync(join(tmpdir(), 'mitzo-checkpoint-helper-'));
  roots.push(value);
  return value;
}
function run(args: string[]) {
  return execFileSync(
    'python3',
    [
      helper,
      ...args,
      '--sandbox-id',
      'sandbox',
      '--resource-version',
      '1',
      '--account-provider',
      'account',
      '--account-id',
      'id',
      '--provider',
      'openai',
      '--model',
      'model',
      '--profile-revision',
      'r1',
      '--runtime-scope',
      'scope',
      '--route-kind',
      'api',
      '--route-provider',
      'openai',
    ],
    { encoding: 'utf8' },
  );
}
function source(root: string) {
  mkdirSync(join(root, '.codex/sessions'), { recursive: true });
  mkdirSync(join(root, 'workspace/empty'), { recursive: true });
  writeFileSync(join(root, '.codex/state_5.sqlite'), 'state');
  writeFileSync(join(root, '.codex/installation_id'), 'install');
  writeFileSync(join(root, '.codex/sessions/thread.jsonl'), '{"id":"thread"}');
  writeFileSync(join(root, 'workspace/tool.sh'), '#!/bin/sh\necho ok\n');
  chmodSync(join(root, 'workspace/tool.sh'), 0o755);
  execFileSync('git', ['init', '-q'], { cwd: join(root, 'workspace') });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
    cwd: join(root, 'workspace'),
  });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: join(root, 'workspace') });
  execFileSync('git', ['add', '.'], { cwd: join(root, 'workspace') });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'seed'], {
    cwd: join(root, 'workspace'),
  });
  writeFileSync(join(root, 'workspace/untracked.txt'), 'untracked');
  const db = new Database(join(root, '.codex/queue_1.sqlite'));
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('ok')");
  db.close();
}
afterEach(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true });
  roots.length = 0;
});
it('captures and restores git, executable files, empty directories, and sqlite state', () => {
  const from = root(),
    archive = join(root(), 'checkpoint.tar'),
    to = join(root(), 'restored');
  source(from);
  run([
    'capture',
    '--source',
    from,
    '--output',
    archive,
    '--conversation',
    'c',
    '--thread',
    'thread',
    '--binding',
    'binding',
    '--image',
    'image',
    '--policy',
    'policy',
  ]);
  run([
    'restore',
    '--input',
    archive,
    '--destination',
    to,
    '--conversation',
    'c',
    '--thread',
    'thread',
    '--binding',
    'binding',
    '--image',
    'image',
    '--policy',
    'policy',
  ]);
  expect(readFileSync(join(to, 'workspace/untracked.txt'), 'utf8')).toBe('untracked');
  expect(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(to, 'workspace'), encoding: 'utf8' }),
  ).toMatch(/[a-f0-9]{40}/);
  expect(readFileSync(join(to, '.codex/queue_1.sqlite')).length).toBeGreaterThan(0);
  expect(statSync(join(to, 'workspace/empty')).isDirectory()).toBe(true);
  expect(statSync(join(to, 'workspace/tool.sh')).mode & 0o777).toBe(0o755);
  expect(statSync(archive).mode & 0o777).toBe(0o600);
  const db = new Database(join(to, '.codex/queue_1.sqlite'));
  expect(db.prepare('SELECT v FROM t').get()).toEqual({ v: 'ok' });
  db.close();
});
it('rejects auth state and corrupt archives', () => {
  const from = root(),
    archive = join(root(), 'checkpoint.tar');
  source(from);
  writeFileSync(join(from, '.codex/auth.json'), 'secret');
  expect(() =>
    run([
      'capture',
      '--source',
      from,
      '--output',
      archive,
      '--conversation',
      'c',
      '--thread',
      'thread',
      '--binding',
      'binding',
      '--image',
      'image',
      '--policy',
      'policy',
    ]),
  ).toThrow();
  writeFileSync(archive, 'not a tar');
  expect(() =>
    run([
      'verify',
      '--input',
      archive,
      '--conversation',
      'c',
      '--thread',
      'thread',
      '--binding',
      'binding',
      '--image',
      'image',
      '--policy',
      'policy',
    ]),
  ).toThrow();
});
it('fails closed for remaining execution processes but exempts only the pinned root supervisor', () => {
  const from = root(); source(from);
  const proc = join(root(), 'proc');
  mkdirSync(join(proc, '1'), { recursive: true });
  writeFileSync(join(proc, '1/status'), 'Name:\topenshell-sandb\nUid:\t0\t0\t0\t0\nPPid:\t0\n');
  run(['capture', '--source', from, '--output', join(root(), 'safe.tar'), '--require-quiescent', '--proc-root', proc, '--conversation', 'c', '--thread', 'thread', '--binding', 'binding', '--image', 'image', '--policy', 'policy']);
  mkdirSync(join(proc, '999'), { recursive: true });
  writeFileSync(join(proc, '999/status'), `Name:\tagent\nUid:\t${process.getuid?.() ?? 998}\t998\t998\t998\nPPid:\t1\n`);
  expect(() => run(['capture', '--source', from, '--output', join(root(), 'blocked.tar'), '--require-quiescent', '--proc-root', proc, '--conversation', 'c', '--thread', 'thread', '--binding', 'binding', '--image', 'image', '--policy', 'policy'])).toThrow(/execution process/);
});

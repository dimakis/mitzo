#!/usr/bin/env node
import process from 'node:process';
import console from 'node:console';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditColdRefusal, git } from './lib/staging-cold-audit.mjs';
import { prepareColdMetadata } from './lib/staging-cold-prepare.mjs';
import { assertVisibleTrackedIndex } from './lib/staging-files.mjs';
const root = join(homedir(), '.local/share/mitzo-staging'),
  source = dirname(dirname(fileURLToPath(import.meta.url)));
export function acceptedSource() {
  const current = git(source, 'rev-parse', 'HEAD'),
    main = git(
      source,
      'ls-remote',
      'https://github.com/dimakis/mitzo.git',
      'refs/heads/main',
    ).split(/\s+/)[0];
  if (
    current !== main ||
    git(source, 'status', '--porcelain', '--untracked-files=no') ||
    git(source, 'remote', 'get-url', 'origin') !== 'https://github.com/dimakis/mitzo.git'
  )
    throw Error('Recovery requires exact clean accepted main');
  assertVisibleTrackedIndex(git(source, 'ls-files', '-v'));
  return current;
}
try {
  const args = process.argv.slice(2),
    command = args.shift();
  if (process.platform !== 'darwin') throw Error('Canonical macOS only');
  if (command === 'audit' && !args.length) {
    const v = await auditColdRefusal(root);
    console.log(
      JSON.stringify({
        snapshot: v.snapshot,
        auditSha256: v.auditSha256,
        serviceControl: false,
        modelCalls: 0,
      }),
    );
  } else if (
    command === 'prepare' &&
    args.length === 2 &&
    args[0] === '--expected-audit' &&
    /^[a-f0-9]{64}$/.test(args[1])
  ) {
    acceptedSource();
    console.log(JSON.stringify(await prepareColdMetadata(root, args[1])));
  } else throw Error('Use audit or prepare --expected-audit SHA256');
} catch (error) {
  console.error(
    error.message +
      '; preserve original lock, archive and reservation. No forced restart or rollback.',
  );
  process.exitCode = 1;
}

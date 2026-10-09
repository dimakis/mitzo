#!/usr/bin/env node
import process from 'node:process';
import console from 'node:console';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditColdRefusal, git } from './lib/staging-cold-audit.mjs';
import { prepareColdMetadata } from './lib/staging-cold-prepare.mjs';
import { assertVisibleTrackedIndex, privateJson } from './lib/staging-files.mjs';
import {
  verifyPreparedController,
  prepareFreshRecovery,
  verifyFreshRecovery,
} from './lib/staging-cold-control.mjs';
import { run } from './lib/staging-cold-audit.mjs';
import { auditKeyRefusal } from './lib/staging-key-audit.mjs';
import { prepareKeyMetadata } from './lib/staging-key-recovery.mjs';
const root = join(homedir(), '.local/share/mitzo-staging'),
  source = dirname(dirname(fileURLToPath(import.meta.url)));
export function acceptedSource(prepared = true) {
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
    git(source, 'remote', 'get-url', 'origin') !== 'https://github.com/dimakis/mitzo.git' ||
    realpathSync(git(source, 'rev-parse', '--show-toplevel')) !== source
  )
    throw Error('Recovery requires exact clean accepted main');
  assertVisibleTrackedIndex(git(source, 'ls-files', '-v'));
  if (prepared) verifyPreparedController(root, source, current);
  return current;
}
try {
  const args = process.argv.slice(2),
    command = args.shift();
  if (process.platform !== 'darwin') throw Error('Canonical macOS only');
  if (['audit', 'audit-keys'].includes(command) && !args.length) {
    const v = await (command === 'audit-keys' ? auditKeyRefusal : auditColdRefusal)(root);
    console.log(
      JSON.stringify({
        snapshot: v.snapshot,
        auditSha256: v.auditSha256,
        serviceControl: false,
        modelCalls: 0,
      }),
    );
  } else if (
    ['prepare', 'prepare-keys'].includes(command) &&
    args.length === 2 &&
    args[0] === '--expected-audit' &&
    /^[a-f0-9]{64}$/.test(args[1])
  ) {
    acceptedSource();
    console.log(
      JSON.stringify(
        await (command === 'prepare-keys'
          ? prepareKeyMetadata(root, args[1], auditKeyRefusal)
          : prepareColdMetadata(root, args[1])),
      ),
    );
  } else if (
    command === 'prepare-release' &&
    args.length === 6 &&
    args[0] === '--commit' &&
    args[2] === '--dependency-source' &&
    args[4] === '--expected-dependency-fingerprint'
  ) {
    const current = acceptedSource(false);
    if (
      args[1] !== current ||
      privateJson(join(root, 'service/deployment.lock')).mode !== 'ordinary-to-owned'
    )
      throw Error('Exact retained operation and accepted target required');
    console.log(
      run(
        process.execPath,
        [join(source, 'scripts/staging.mjs'), 'prepare', ...args],
        source,
        undefined,
        0,
      ),
    );
  } else if (['plan', 'activate', 'verify'].includes(command) && !args.length) {
    const current = acceptedSource();
    console.log(
      JSON.stringify(
        command === 'verify'
          ? await verifyFreshRecovery(root, source, current)
          : await prepareFreshRecovery(root, source, current, command === 'activate'),
      ),
    );
  } else
    throw Error(
      'Use audit, audit-keys, prepare-release, prepare/prepare-keys --expected-audit SHA256, plan, activate or verify',
    );
} catch (error) {
  console.error(
    error.message +
      '; preserve original lock, archive and reservation. No forced restart or rollback.',
  );
  process.exitCode = 1;
}

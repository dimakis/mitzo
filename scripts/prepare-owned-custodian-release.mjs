#!/usr/bin/env node
// Writes a reviewable preparation bundle only; never installs a service or starts a process.
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOwnedRelease, renderOwnedPlist } from '../dist/symposium-owned-release.js';
try {
  if (process.argv.length !== 6 || process.argv[2] !== '--owned-custodian') throw Error();
  const releaseRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const plan = prepareOwnedRelease({
    releaseRoot,
    configPath: resolve(process.argv[3]),
    repositoryPath: resolve(process.argv[4]),
    planDirectory: resolve(process.argv[5]),
  });
  for (const [name, content] of [
    ['empty-accounts.json', '[]\n'],
    ['owned-release.json', JSON.stringify(plan, null, 2) + '\n'],
    ['com.mitzo.owned-custodian.plist', renderOwnedPlist(plan, process.execPath)],
  ]) {
    const fd = openSync(
      join(plan.planDirectory, name),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  const parent = openSync(plan.planDirectory, constants.O_RDONLY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  console.log(
    JSON.stringify({
      prepared: true,
      mode: plan.mode,
      installed: false,
      started: false,
      admissionVerified: false,
      providerRequests: 0,
      modelCalls: 0,
    }),
  );
} catch {
  process.stderr.write(
    'Owned release preparation refused; no service installed or started. Inspect any partial preparation before retry.\n',
  );
  process.exitCode = 1;
}

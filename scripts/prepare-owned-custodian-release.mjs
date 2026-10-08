#!/usr/bin/env node
import process from 'node:process';
import console from 'node:console';
// Writes a reviewable preparation bundle only; never installs a service or starts a process.
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  requiresCanonicalStaging,
  canonicalStagingRoot,
  assertCanonicalStagingService,
} from '../dist/symposium-staging-service.js';
import { prepareOwnedRelease, renderOwnedPlist } from '../dist/symposium-owned-release.js';
try {
  const canonical = process.argv[6] === '--canonical';
  const baseline = process.argv[8];
  if (
    process.argv[2] !== '--owned-custodian' ||
    (!canonical && process.argv.length !== 6) ||
    (canonical &&
      (process.argv.length !== 9 ||
        process.argv[7] !== '--accepted-main-baseline' ||
        !/^[a-f0-9]{40}$/.test(baseline ?? '')))
  )
    throw Error();
  const releaseRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const plan = prepareOwnedRelease({
    releaseRoot,
    acceptedMainBaseline: baseline,
    configPath: resolve(process.argv[3]),
    repositoryPath: resolve(process.argv[4]),
    planDirectory: resolve(process.argv[5]),
  });
  if (requiresCanonicalStaging(plan) !== canonical)
    throw Error('Canonical preparation mode required');
  if (canonical)
    assertCanonicalStagingService(
      plan,
      join(canonicalStagingRoot(), 'symposium/settings/staging-registration.json'),
      canonicalStagingRoot(),
    );
  for (const [name, content] of [
    ['empty-accounts.json', '[]\n'],
    ['owned-release.json', JSON.stringify(plan, null, 2) + '\n'],
    ...(canonical
      ? []
      : [['com.mitzo.owned-custodian.plist', renderOwnedPlist(plan, process.execPath)]]),
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

#!/usr/bin/env node
// Fresh launch only: registration cannot adopt existing custody or resume a launch intent.
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readOwnedReleasePlan,
  verifyOwnedRelease,
  claimOwnedLaunch,
} from '../dist/symposium-owned-release.js';
import { ownedCustodianEnvironment } from '../dist/symposium-custodian-launch.js';
import { readStagingOperatorEnvironment } from '../dist/symposium-staging-service.js';
import { launchStagingCustodian, StagingLaunchSchema } from '../dist/symposium-staging-launch.js';
import { runSymposiumCustodian } from '../dist/symposium-custodian-main.js';
try {
  if (![4, 5].includes(process.argv.length) || process.send) throw Error();
  const releaseRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const plan = readOwnedReleasePlan(resolve(process.argv[2]));
  if (
    plan.releaseRoot !== releaseRoot ||
    resolve(process.argv[2]) !== join(plan.planDirectory, 'owned-release.json') ||
    plan.entry !== 'dist/symposium-custodian-main.js'
  )
    throw Error();
  const env =
    process.argv.length === 5
      ? readStagingOperatorEnvironment(plan, resolve(process.argv[4]), process.env)
      : ownedCustodianEnvironment(plan, process.env);
  const fd = openSync(resolve(process.argv[3]), constants.O_RDONLY | constants.O_NOFOLLOW);
  let registration;
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 8192
    )
      throw Error();
    registration = StagingLaunchSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
  } finally {
    closeSync(fd);
  }
  // Same process retains the original recorder and runtime authority throughout startup/shutdown.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  process.chdir(releaseRoot);
  await launchStagingCustodian(plan, registration, {
    verify: verifyOwnedRelease,
    claim: claimOwnedLaunch,
    run: runSymposiumCustodian,
  });
} catch {
  process.stderr.write(
    'Staging launch or retirement refused or uncertain; retain registry, intent and original resources.\n',
  );
  process.exitCode = 1;
}

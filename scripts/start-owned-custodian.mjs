#!/usr/bin/env node
// Explicit fresh launch only. This wrapper never bootstraps a provider itself.
import { dirname, join, resolve } from 'node:path';
import { ownedCustodianEnvironment } from '../dist/symposium-custodian-launch.js';
import { fileURLToPath } from 'node:url';
import {
  readOwnedReleasePlan,
  verifyOwnedRelease,
  claimOwnedLaunch,
} from '../dist/symposium-owned-release.js';
try {
  if (process.argv.length !== 3 || typeof process.execve !== 'function') throw Error();
  const source = process.env;
  const releaseRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const plan = readOwnedReleasePlan(resolve(process.argv[2]));
  if (
    plan.releaseRoot !== releaseRoot ||
    resolve(process.argv[2]) !== join(plan.planDirectory, 'owned-release.json') ||
    plan.entry !== 'dist/symposium-custodian-main.js'
  )
    throw Error();
  const env = ownedCustodianEnvironment(plan, source);
  verifyOwnedRelease(plan);
  claimOwnedLaunch(plan); // Durable intent is retained on every later error.
  verifyOwnedRelease(plan); // Fresh checks immediately before the irreversible exec boundary.
  process.chdir(releaseRoot);
  process.execve(process.execPath, [process.execPath, join(releaseRoot, plan.entry)], env);
} catch {
  process.stderr.write(
    'Owned custodian launch refused or uncertain; never delete the launch intent to retry.\n',
  );
  process.exitCode = 1;
}

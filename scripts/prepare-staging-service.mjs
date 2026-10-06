#!/usr/bin/env node
import process from 'node:process';
import console from 'node:console';
// Prepare only: no launchctl, bootstrap, provider login or model requests.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOwnedReleasePlan, verifyOwnedRelease } from '../dist/symposium-owned-release.js';
import {
  prepareStagingService,
  prepareCanonicalStagingService,
  canonicalStagingRoot,
  requiresCanonicalStaging,
} from '../dist/symposium-staging-service.js';
try {
  const canonical = process.argv.length === 6 && process.argv[5] === '--canonical';
  if (
    (!canonical && process.argv.length !== 5) ||
    process.send ||
    (canonical && process.argv[4] !== '3190')
  )
    throw Error();
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const planPath = resolve(process.argv[2]);
  const plan = readOwnedReleasePlan(planPath);
  if (plan.releaseRoot !== root || planPath !== join(plan.planDirectory, 'owned-release.json'))
    throw Error();
  verifyOwnedRelease(plan);
  if (requiresCanonicalStaging(plan) && !canonical)
    throw Error('Canonical plan requires canonical preparation');
  const prepared = canonical
    ? prepareCanonicalStagingService(
        plan,
        resolve(process.argv[3]),
        process.execPath,
        canonicalStagingRoot(),
      )
    : prepareStagingService(
        plan,
        resolve(process.argv[3]),
        process.execPath,
        Number(process.argv[4]),
      );
  console.log(JSON.stringify({ ...prepared, installed: false, started: false, modelCalls: 0 }));
} catch {
  process.stderr.write(
    'Staging service preparation refused; preserve partial inputs and original resources.\n',
  );
  process.exitCode = 1;
}

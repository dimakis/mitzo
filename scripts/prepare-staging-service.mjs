#!/usr/bin/env node
// Prepare only: no launchctl, bootstrap, provider login or model requests.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOwnedReleasePlan, verifyOwnedRelease } from '../dist/symposium-owned-release.js';
import { prepareStagingService } from '../dist/symposium-staging-service.js';
try {
  if (process.argv.length !== 5 || process.send) throw Error();
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const planPath = resolve(process.argv[2]);
  const plan = readOwnedReleasePlan(planPath);
  if (plan.releaseRoot !== root || planPath !== join(plan.planDirectory, 'owned-release.json'))
    throw Error();
  verifyOwnedRelease(plan);
  const prepared = prepareStagingService(
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

#!/usr/bin/env node
// Explicit fresh launch only. This wrapper never bootstraps a provider itself.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readOwnedReleasePlan,
  verifyOwnedRelease,
  claimOwnedLaunch,
} from '../dist/symposium-owned-release.js';
try {
  if (process.argv.length !== 3 || typeof process.execve !== 'function') throw Error();
  const releaseRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const plan = readOwnedReleasePlan(resolve(process.argv[2]));
  if (
    plan.releaseRoot !== releaseRoot ||
    resolve(process.argv[2]) !== join(plan.planDirectory, 'owned-release.json') ||
    plan.entry !== 'dist/symposium-custodian-main.js'
  )
    throw Error();
  verifyOwnedRelease(plan);
  claimOwnedLaunch(plan); // Durable intent is retained on every later error.
  verifyOwnedRelease(plan); // Fresh checks immediately before the irreversible exec boundary.
  process.chdir(releaseRoot);
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    HOME: plan.appHome,
    XDG_CONFIG_HOME: join(plan.appHome, '.config'),
    XDG_STATE_HOME: join(plan.appHome, '.local', 'state'),
    XDG_CACHE_HOME: join(plan.appHome, '.cache'),
    MITZO_SYMPOSIUM_OWNED_HOST_CONFIG: plan.configPath,
    REPO_PATH: plan.repositoryPath,
    MITZO_REPO_PATH_CEILING: plan.repositoryPath,
    MITZO_DISABLE_REPO_MAINTENANCE: '1',
    MITZO_WORKTREE_CLEANUP_POLICY: 'report',
    MITZO_CODEX_PRIVATE_DIR: join(plan.repositoryPath, '.mitzo', 'codex-private'),
    MITZO_ACCOUNT_PROFILES_FILE: join(plan.planDirectory, 'empty-accounts.json'),
    MITZO_OPENSHELL_ENABLED: '0',
  };
  delete env.MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER;
  delete env.MITZO_SYMPOSIUM_CUSTODIAN_OWNER;
  process.execve(process.execPath, [process.execPath, join(releaseRoot, plan.entry)], env);
} catch {
  process.stderr.write(
    'Owned custodian launch refused or uncertain; never delete the launch intent to retry.\n',
  );
  process.exitCode = 1;
}

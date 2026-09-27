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
  const source = process.env;
  if (
    source.NODE_OPTIONS ||
    source.NODE_PATH ||
    (source.DOTENV_CONFIG_PATH && source.DOTENV_CONFIG_PATH !== '/dev/null')
  )
    throw Error();
  if (
    !source.AUTH_PASSPHRASE ||
    source.AUTH_PASSPHRASE.length < 32 ||
    !source.AUTH_SECRET ||
    source.AUTH_SECRET.length < 64 ||
    !/^[0-9]{4,5}$/.test(source.PORT ?? '') ||
    Number(source.PORT) < 1024 ||
    Number(source.PORT) > 65535 ||
    !['127.0.0.1', '::1'].includes(source.MITZO_BIND_HOST ?? '')
  )
    throw Error();
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
    PATH: '/usr/bin:/bin',
    AUTH_PASSPHRASE: source.AUTH_PASSPHRASE,
    AUTH_SECRET: source.AUTH_SECRET,
    PORT: source.PORT,
    MITZO_BIND_HOST: source.MITZO_BIND_HOST,
    DOTENV_CONFIG_PATH: '/dev/null',
    MITZO_CODEX_ENABLED: '1',
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
  process.execve(process.execPath, [process.execPath, join(releaseRoot, plan.entry)], env);
} catch {
  process.stderr.write(
    'Owned custodian launch refused or uncertain; never delete the launch intent to retry.\n',
  );
  process.exitCode = 1;
}

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { parse } from 'dotenv';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);

export function productionFrontendEnvironment(config, inheritedEnv = process.env) {
  const origin = config.MITZO_PUBLIC_ORIGIN;
  if (typeof origin !== 'string' || origin.length === 0) {
    throw new Error('MITZO_PUBLIC_ORIGIN is required to build the production browser bundle');
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('MITZO_PUBLIC_ORIGIN must be an HTTPS public origin');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('MITZO_PUBLIC_ORIGIN must be an HTTPS public origin');
  }
  return { ...inheritedEnv, VITE_API_BASE_URL: origin };
}

export function main(argv = process.argv.slice(2), { root = repoRoot } = {}) {
  const envPath = resolve(root, argv[0] ?? '.env');
  if (!existsSync(envPath))
    throw new Error(`production environment file does not exist: ${envPath}`);
  const config = parse(readFileSync(envPath));
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    env: productionFrontendEnvironment(config),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();

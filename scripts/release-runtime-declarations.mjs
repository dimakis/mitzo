#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'dotenv';
import process from 'node:process';
import console from 'node:console';
import {
  checkRuntimeDeclarations,
  prepareRuntimeDeclarations,
  readPrivateEnvironment,
  runtimeDeclarationsEnabled,
} from './lib/release-runtime-declarations.mjs';

const root = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
try {
  if (process.argv.length !== 3 || !['--prepare', '--check'].includes(process.argv[2]))
    throw Error();
  const source = readPrivateEnvironment(join(root, '.env'));
  const env = parse(source);
  // start.sh loads .env without override. Reject conflicting launcher/shell
  // selectors rather than validate settings different from the daemon's.
  const critical = (name) =>
    name.startsWith('MITZO_ORDINARY_LOCAL_') ||
    name.startsWith('MITZO_ORDINARY_OPENSHELL_') ||
    name.startsWith('MITZO_OPENSHELL_') ||
    name.startsWith('OPENSHELL_') ||
    name.startsWith('DOTENV_');
  const plistEnv = JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        'import json,plistlib,sys;print(json.dumps(plistlib.load(open(sys.argv[1],"rb")).get("EnvironmentVariables",{})))',
        join(root, 'com.mitzo.server.plist'),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
  if (
    Object.keys(plistEnv).some(critical) ||
    Object.keys(env).some((n) => n.startsWith('DOTENV_')) ||
    Object.keys(process.env).some((n) => critical(n) && process.env[n] !== env[n])
  )
    throw Error();
  if (!runtimeDeclarationsEnabled(env)) {
    console.log(JSON.stringify({ localRuntimeDeclarations: 'disabled' }));
  } else {
    // Load the same compiled validators and source manifest as the candidate.
    // Configuration is persisted configuration, never shell-only credentials.
    for (const name of Object.keys(process.env))
      if (
        !(name in env) &&
        !(name in plistEnv) &&
        !['PATH', 'HOME', 'USER', 'TMPDIR'].includes(name)
      )
        delete process.env[name];
    Object.assign(process.env, env, plistEnv);
    const load = (name) => import(pathToFileURL(join(root, 'dist', name)).href);
    const runtime = {
      codex: await load('ordinary-local-codex-host-runtime.js'),
      responses: await load('ordinary-local-responses-capabilities.js'),
      vertex: await load('ordinary-local-vertex-capabilities.js'),
      openshell: await load('ordinary-openshell-codex-entry-owner.js'),
      shell: await load('openshell-runtime.js'),
      shellRoute: await load('ordinary-openshell-codex-route.js'),
      native: await load('frozen-host-codex-executable.js'),
    };
    const result =
      process.argv[2] === '--prepare'
        ? prepareRuntimeDeclarations(root, source, runtime)
        : { changed: false, targets: checkRuntimeDeclarations(env, runtime) };
    console.log(
      JSON.stringify({
        localRuntimeDeclarations: 'verified',
        changed: result.changed,
        targets: result.targets.map((t) => t.targetId),
      }),
    );
  }
} catch {
  // Never print private environment values, declaration contents or parser errors.
  console.error(
    JSON.stringify({
      error: 'local_runtime_declarations_invalid',
      action:
        'Check the selected private declarations, native pins and accepted release before restarting.',
    }),
  );
  process.exitCode = 1;
}

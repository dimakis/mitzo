import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { parse } from 'dotenv';
import process from 'node:process';
import {
  previousOpenShellContract,
  readAcceptedOpenShellSource,
} from './release-openshell-source.mjs';

export const runtimeKinds = ['CODEX', 'RESPONSES', 'VERTEX', 'GEMINI'];
const prefix = 'MITZO_ORDINARY_LOCAL_';
const key = (kind, suffix) => `${prefix}${kind}_${suffix}`;
export const runtimeDeclarationsEnabled = (env) =>
  runtimeKinds.some((kind) => env[key(kind, 'ENABLED')] === '1') ||
  env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED === '1';

// Environment files contain credentials. Never return parser errors to the CLI.
export function readPrivateEnvironment(file) {
  assert.equal(realpathSync(file), file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1);
    assert.equal(stat.mode & 0o777, 0o600);
    assert(stat.size <= 1024 * 1024);
    const source = readFileSync(fd, 'utf8');
    for (const current of [fstatSync(fd), lstatSync(file)])
      for (const field of [
        'dev',
        'ino',
        'mode',
        'uid',
        'gid',
        'nlink',
        'size',
        'mtimeMs',
        'ctimeMs',
      ])
        assert.equal(current[field], stat[field]);
    return source;
  } finally {
    closeSync(fd);
  }
}

export function checkRuntimeDeclarations(env, runtime) {
  const targets = [];
  if (env[key('CODEX', 'ENABLED')] === '1') {
    const host = new runtime.codex.OrdinaryLocalCodexHostRuntime(env);
    host.assertCurrentSync();
    targets.push(host.target().descriptor());
  }
  for (const [kind, harness] of [
    ['RESPONSES', 'responses'],
    ['GEMINI', 'gemini'],
  ]) {
    if (env[key(kind, 'ENABLED')] === '1') {
      const target = new runtime.responses.OrdinaryLocalResponsesTarget(env, harness);
      target.assertCurrentSync();
      targets.push(target.descriptor());
    }
  }
  if (env[key('VERTEX', 'ENABLED')] === '1') {
    const target = new runtime.vertex.OrdinaryLocalVertexTarget(env);
    target.assertCurrentSync();
    targets.push(target.descriptor());
  }
  if (env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED === '1') {
    const selected = runtime.openshell.loadOrdinaryOpenShellCodexTarget(env);
    assert(selected);
    targets.push(selected.target);
  }
  return targets;
}

/** Deployment-only renewal of existing operator declarations. Never adopts new
 * binaries, accounts, host identity or continuity contracts. The caller must
 * qualify accepted sources and build the exact candidate before invoking this.
 */
export function prepareRuntimeDeclarations(root, source, runtime) {
  root = realpathSync(root);
  const envFile = join(root, '.env');
  assert.equal(readPrivateEnvironment(envFile), source);
  const env = parse(source);
  const directory = join(root, '.runtime-targets');
  const inside = (file) => {
    const rel = relative(directory, file);
    return rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
  };
  const plans = [];
  const read = runtime.codex.readPrivateRuntimeSettings;
  const add = (name, fileName, revision) => {
    const previous = read(env[name]);
    plans.push({
      name,
      fileName,
      previous,
      next: revision ? { ...previous, runtimeContractRevision: revision } : previous,
    });
    return previous;
  };
  if (env[key('CODEX', 'ENABLED')] === '1') {
    const native = add(key('CODEX', 'NATIVE_FILE'), 'codex-native.json');
    const revision = runtime.codex.ordinaryLocalCodexHostContractRevision(
      native.executableSha256,
      native.codeModeHostSha256,
    );
    const previous = add(key('CODEX', 'TARGET_FILE'), 'codex.json', revision);
    // A v1 target hashes the deployment into conversation identity. Deployment
    // must not silently migrate it or strand retained conversations.
    if (previous.version !== 2) assert.equal(previous.runtimeContractRevision, revision);
  }
  for (const [kind, harness] of [
    ['RESPONSES', 'responses'],
    ['GEMINI', 'gemini'],
  ]) {
    if (env[key(kind, 'ENABLED')] === '1')
      add(
        key(kind, 'TARGET_FILE'),
        `${harness}.json`,
        runtime.responses.ordinaryLocalResponsesContractRevision(harness),
      );
  }
  if (env[key('VERTEX', 'ENABLED')] === '1')
    add(
      key('VERTEX', 'TARGET_FILE'),
      'vertex.json',
      runtime.vertex.ordinaryLocalVertexContractRevision(),
    );
  if (env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED === '1') {
    const name = 'MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE';
    const previous = read(env[name]);
    const config = runtime.shell.openShellRuntimeConfig(env);
    assert(config && config.seedStackManifest);
    const measurement = runtime.native.measureHostCodexExecutable(config.cli);
    const revision = runtime.openshell.ordinaryOpenShellCodexContractRevision(
      config,
      measurement.sha256,
    );
    if (previous.runtimeContractRevision !== revision || !inside(env[name])) {
      const source = readAcceptedOpenShellSource(root, env[name]);
      const priorEnv = parse(readPrivateEnvironment(join(source.releaseRoot, '.env')));
      assert.equal(priorEnv[name], env[name]);
      const priorConfig = runtime.shell.openShellRuntimeConfig(priorEnv);
      assert(priorConfig);
      assert.deepEqual(
        runtime.shellRoute.ordinaryOpenShellCodexTarget({ ...previous, config }),
        runtime.shellRoute.ordinaryOpenShellCodexTarget({ ...previous, config: priorConfig }),
      );
      assert.equal(
        previous.runtimeContractRevision,
        previousOpenShellContract(config, measurement.sha256, source),
      );
      const currentVersion = readFileSync(
        join(root, 'docs/spikes/openshell-codex/runtime-codex-version'),
        'utf8',
      ).trim();
      assert.equal(source.codexVersion, currentVersion);
    }
    measurement.assertCurrent();
    assert.deepEqual(add(name, 'openshell.json', revision), previous);
  }
  if (!plans.length) return { changed: false, targets: [] };
  if (
    plans.every((p) => inside(env[p.name]) && JSON.stringify(p.previous) === JSON.stringify(p.next))
  ) {
    return { changed: false, targets: checkRuntimeDeclarations(env, runtime) };
  }
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(directory);
  assert(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700);
  assert.equal(realpathSync(directory), directory);
  // Failed preparation leaves its private evidence intact. No selected files or
  // previous releases are overwritten; .env is the atomic selection point.
  const prepared = mkdtempSync(join(directory, 'release-'));
  const nextEnv = { ...env };
  for (const p of plans) {
    nextEnv[p.name] = join(prepared, p.fileName);
    writeFileSync(nextEnv[p.name], JSON.stringify(p.next, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  }
  const targets = checkRuntimeDeclarations(nextEnv, runtime);
  let nextSource = source;
  for (const p of plans) {
    // Append canonical assignments after the unchanged original text, including
    // quoted/exported values and duplicate keys. dotenv uses the last value.
    nextSource += `\n${p.name}=${JSON.stringify(nextEnv[p.name])}\n`;
  }
  assert.deepEqual(parse(nextSource), nextEnv);
  assert.equal(readPrivateEnvironment(envFile), source);
  const id = randomUUID();
  writeFileSync(join(root, `.env.before-runtime-${id}`), source, { mode: 0o600, flag: 'wx' });
  const temporary = join(root, `.env.runtime-${id}`);
  writeFileSync(temporary, nextSource, { mode: 0o600, flag: 'wx' });
  assert.equal(readPrivateEnvironment(envFile), source);
  renameSync(temporary, envFile);
  return { changed: true, targets };
}

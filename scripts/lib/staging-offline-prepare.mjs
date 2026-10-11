import process from 'node:process';
import { randomUUID, createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  renameSync,
} from 'node:fs';
import {
  artifacts,
  fingerprintDirectory,
  fingerprintDependencyCopy,
  assertVisibleTrackedIndex,
  stageDirectory,
} from './staging-files.mjs';
import { verifyDependencySource } from './staging-dependency-source.mjs';
import { buildStagingOfflineAuthHelper } from './staging-offline-auth-build.mjs';
import { verifyPreparedController } from './staging-cold-control.mjs';

const repository = 'https://github.com/dimakis/mitzo.git';
const required = [
  'assertPreparationBoundary',
  'assertSourceAccepted',
  'assertDestinationAbsent',
  'qualifyDependencies',
  'cloneAcceptedSource',
  'copyDependencies',
  'buildApplication',
  'compileOperatorHelper',
  'freezePreparedController',
  'verifyPreparedController',
];
/** Preparation has no service control, authentication, registry or old-state effects.
 * Failed candidates remain available for investigation; they are never adopted. */
export function createOfflineRecoveryPreparation(effects) {
  if (required.some((name) => typeof effects?.[name] !== 'function'))
    throw Error('Reviewed preparation effects required');
  let used = false;
  return Object.freeze({
    async prepare(input) {
      if (
        used ||
        !/^[a-f0-9]{40}$/.test(input?.target ?? '') ||
        !/^[a-f0-9]{64}$/.test(input?.dependencyFingerprint ?? '') ||
        typeof input?.dependencySource !== 'string' ||
        !input.dependencySource.startsWith('/')
      )
        throw Error('Exact accepted source and audited dependency pins required');
      used = true;
      const facts = Object.freeze({ ...input });
      await effects.assertPreparationBoundary(facts);
      await effects.assertSourceAccepted(facts);
      await effects.assertDestinationAbsent(facts);
      await effects.qualifyDependencies(facts);
      await effects.cloneAcceptedSource(facts);
      await effects.copyDependencies(facts);
      await effects.assertSourceAccepted(facts);
      await effects.buildApplication(facts);
      await effects.compileOperatorHelper(facts);
      await effects.qualifyDependencies(facts);
      await effects.assertSourceAccepted(facts);
      await effects.freezePreparedController(facts);
      return effects.verifyPreparedController(facts);
    },
  });
}

/** Concrete adapter for a clean accepted checkout. No current deployment receipt
 * authorizes preparation: this creates an independent source candidate only. */
export function createOfflineRecoveryPreparationEffects({ sourceRoot }) {
  const root = join(homedir(), '.local/share/mitzo-staging');
  let attempt, destination, buildHome, lockHash, copyHash, dependencyBefore;
  const hash = (data) => createHash('sha256').update(data).digest('hex');
  const run = (program, argv, cwd = sourceRoot) => {
    if (program === '/usr/bin/git')
      argv = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...argv];
    const result = spawnSync(program, argv, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 ** 2,
      timeout: 180000,
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: buildHome ?? '/private/tmp',
        TMPDIR: '/private/tmp',
        LANG: 'en_US.UTF-8',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        DOTENV_CONFIG_PATH: '/dev/null',
      },
    });
    if (result.status !== 0 || result.error || result.signal)
      throw Error('Source preparation command failed; preserve candidate: ' + program);
    return result.stdout.trim();
  };
  const qualify = (path, target) => {
    assertVisibleTrackedIndex(run('/usr/bin/git', ['ls-files', '-v'], path));
    if (
      realpathSync(path) !== path ||
      run('/usr/bin/git', ['rev-parse', '--show-toplevel'], path) !== path ||
      run('/usr/bin/git', ['rev-parse', 'HEAD'], path) !== target ||
      run('/usr/bin/git', ['status', '--porcelain'], path) ||
      run('/usr/bin/git', ['remote', 'get-url', 'origin'], path) !== repository ||
      run('/usr/bin/git', ['ls-remote', repository, 'refs/heads/main'], path).split(/\s+/)[0] !==
        target
    )
      throw Error('Clean exact accepted source required');
  };
  return {
    assertPreparationBoundary() {
      if (process.platform !== 'darwin' || process.getuid() === 0 || realpathSync(root) !== root)
        throw Error('Canonical macOS preparation required');
      stageDirectory(root, 'releases');
      if (lstatSync(join(root, 'service/deployment.lock'), { throwIfNoEntry: false }))
        throw Error('Retained deployment lock requires investigation');
    },
    assertSourceAccepted({ target }) {
      qualify(sourceRoot, target);
    },
    assertDestinationAbsent({ target }) {
      destination = join(root, 'releases', target.slice(0, 12));
      if (lstatSync(destination, { throwIfNoEntry: false }))
        throw Error('Release already exists; inspect without overwriting');
    },
    qualifyDependencies({ target, dependencySource, dependencyFingerprint }) {
      lockHash ??= hash(readFileSync(join(sourceRoot, 'package-lock.json')));
      verifyDependencySource(dependencySource, target, lockHash, dependencyFingerprint);
    },
    cloneAcceptedSource({ target }) {
      buildHome = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-offline-build-home-')));
      attempt = join(root, 'releases', '.offline-prepare-' + randomUUID());
      run('/usr/bin/git', ['clone', '--no-checkout', repository, attempt]);
      run('/usr/bin/git', ['checkout', '--detach', target], attempt);
      qualify(attempt, target);
    },
    copyDependencies({ dependencySource }) {
      dependencyBefore = fingerprintDirectory(dependencySource, 'node_modules');
      copyHash = fingerprintDependencyCopy(dependencySource);
      cpSync(join(dependencySource, 'node_modules'), join(attempt, 'node_modules'), {
        recursive: true,
        verbatimSymlinks: true,
      });
      if (fingerprintDependencyCopy(attempt) !== copyHash)
        throw Error('Independent dependency copy changed');
    },
    buildApplication() {
      run('/opt/homebrew/bin/npm', ['run', 'build:server'], attempt);
      run('/opt/homebrew/bin/npm', ['run', 'build'], attempt);
    },
    compileOperatorHelper({ target }) {
      buildStagingOfflineAuthHelper({
        controllerRoot: attempt,
        sourceCommit: target,
        assertQualifiedSource(path, selected) {
          qualify(path, selected);
        },
      });
    },
    freezePreparedController({ target, dependencySource }) {
      if (fingerprintDirectory(dependencySource, 'node_modules') !== dependencyBefore)
        throw Error('Dependency source changed during build');
      qualify(attempt, target);
      const tree = run('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], attempt);
      writeFileSync(
        join(attempt, 'release.txt'),
        'source_commit=' + target + '\nbase_main=' + target + '\nsource_tree=' + tree + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      renameSync(attempt, destination);
      const receipt = {
        version: 1,
        release: destination,
        sourceCommit: target,
        sourceTree: tree,
        label: 'com.mitzo.staging',
        port: 3190,
        bind: '127.0.0.1',
        workspace: join(root, 'workspace'),
        compiledArtifacts: artifacts(destination),
        dependencyFingerprint: fingerprintDirectory(destination, 'node_modules'),
      };
      writeFileSync(
        join(destination, 'staging-release.json'),
        JSON.stringify(receipt, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
    },
    verifyPreparedController({ target }) {
      qualify(destination, target);
      return verifyPreparedController(root, destination, target);
    },
  };
}

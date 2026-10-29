import { execFile } from 'node:child_process';
import { readFile, statfs, mkdtemp, writeFile, rm, access, mkdir, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import process from 'node:process';
import console from 'node:console';

const execute = promisify(execFile);

// Do not retain raw subprocess output: package/Git diagnostics can contain credentials.
export class DevelopmentSetupError extends Error {
  constructor(phase, reason, message, effectStatus = 'not_started') {
    super(message);
    this.name = 'DevelopmentSetupError';
    Object.assign(this, { phase, reason, effectStatus });
  }
  toJSON() {
    return { ready: false, phase: this.phase, reason: this.reason, effectStatus: this.effectStatus, message: this.message, ...(this.cleanupReason ? { cleanupReason: this.cleanupReason } : {}) };
  }
}
function failure(phase, cause, message, effectStatus = 'not_started') {
  if (cause instanceof DevelopmentSetupError) return cause;
  const detail = `${cause?.code ?? ''} ${cause?.message ?? ''} ${cause?.stderr ?? ''}`;
  const reason = /\b(?:EPERM|EACCES)\b/.test(detail) ? 'filesystem_denied'
    : /\bENOSPC\b/.test(detail) ? 'insufficient_space'
      : /\b(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT)\b/.test(detail) ? 'network_unavailable'
        : /package(?:-lock)?\.json.*(?:in sync|synchron)|npm ci.*(?:in sync|lock)/i.test(detail) ? 'lockfile_mismatch'
          : /gyp (?:ERR|error)|(?:python|make|c\+\+).*(?:not found|missing)/i.test(detail) ? 'native_toolchain'
            : cause?.code === 'ENOENT' ? 'missing_tool_or_file' : 'command_failed';
  const advice = {
    filesystem_denied: 'A required filesystem write was denied. Check the selected task permissions.',
    insufficient_space: 'The selected task has insufficient disk space.',
    network_unavailable: 'Public npm registry or GitHub access failed.',
    lockfile_mismatch: 'The manifest and pinned lockfile do not agree.',
    native_toolchain: 'Check the Python, make and C++ native build toolchain.',
  }[reason];
  return new DevelopmentSetupError(phase, reason, `${message}${advice ? ` ${advice}` : ''}`, effectStatus);
}
// The caller selects an admitted task root. Refuse pre-existing setup symlinks
// outside it before creating descendants, rather than borrowing host caches.
async function directory(root, ...parts) {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    await mkdir(current).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const actual = await realpath(current);
    const path = relative(root, actual);
    if (path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path))
      throw new DevelopmentSetupError('environment', 'workspace_escape', 'Development setup directories must remain inside the selected task.');
  }
  return current;
}
// This project's engines declare minimum stable versions. Fail closed if a
// future manifest changes that contract rather than guessing at a semver range.
function meetsMinimum(version, requirement) {
  const actual = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const minimum = /^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(requirement);
  if (!actual || !minimum) return false;
  for (let i = 1; i <= 3; i++) {
    const difference = Number(actual[i]) - Number(minimum[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}
/** Run inside the selected development workspace; never use a host node_modules copy. */
export async function prepareDevelopment({
  cwd = process.cwd(),
  install = false,
  run = async (command, args, options) => {
    const result = await execute(command, args, { ...options, encoding: 'utf8' });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  },
  freeBytes = async () => {
    const s = await statfs(cwd);
    return s.bavail * s.bsize;
  },
} = {}) {
  let phase = 'capacity';
  let effectStatus = 'not_started';
  let temporary;
  let pendingError;
  try {
    const available = await freeBytes();
    if (available < 2 * 1024 ** 3)
      throw new DevelopmentSetupError(phase, 'insufficient_space', 'Development setup needs at least 2 GiB free for dependencies and builds. Free space in this sandbox and retry.');
    phase = 'manifest';
    cwd = await realpath(cwd);
    const [manifest] = await Promise.all(['package.json', 'package-lock.json'].map((name) => readFile(join(cwd, name), 'utf8')));
    const { engines } = JSON.parse(manifest);
    phase = 'environment';
    const tools = await directory(cwd, '.mitzo-devtools');
    const environment = {
      home: await directory(tools, 'home'),
      tmp: await directory(tools, 'tmp'),
      cache: await directory(tools, 'cache'),
      config: await directory(tools, 'config'),
      data: await directory(tools, 'data'),
      nodeGyp: await directory(tools, 'node-gyp'),
      prefix: await directory(tools, 'prefix'),
    };
    temporary = await mkdtemp(join(environment.tmp, 'install-'));
    await writeFile(join(temporary, 'user.npmrc'), '');
    await writeFile(join(temporary, 'global.npmrc'), '');
    // Only the executable search path and Windows platform location are inherited.
    // HOME, temp, npm, node-gyp and XDG writes all belong to the selected task.
    const env = Object.fromEntries(['PATH', 'SystemRoot'].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
    Object.assign(env, {
      HOME: environment.home,
      USERPROFILE: environment.home,
      TMPDIR: environment.tmp, TMP: environment.tmp, TEMP: environment.tmp,
      XDG_CACHE_HOME: environment.cache, XDG_CONFIG_HOME: environment.config, XDG_DATA_HOME: environment.data,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_0: 'ssh://git@github.com/',
      GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'git@github.com:',
      GIT_CONFIG_KEY_2: 'credential.helper', GIT_CONFIG_VALUE_2: '',
      npm_config_userconfig: join(temporary, 'user.npmrc'), npm_config_globalconfig: join(temporary, 'global.npmrc'),
      npm_config_cache: environment.cache, npm_config_prefix: environment.prefix,
      npm_config_devdir: environment.nodeGyp, npm_package_config_node_gyp_devdir: environment.nodeGyp,
      npm_config_jobs: '1', npm_package_config_node_gyp_jobs: '1',
    });
    const options = { cwd, env, timeout: 15 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 };
    phase = 'prerequisites';
    for (const tool of ['npm', 'git', 'python3', 'make', 'c++']) {
      try { await run(tool, ['--version'], options); }
      catch (cause) { throw failure(phase, cause, `Development setup is missing ${tool}. Use a sandbox image with the Node/native build toolchain.`); }
    }
    const bin = join(tools, 'node_modules', '.bin');
    let npm = 'npm', node = process.execPath;
    const local = await access(join(bin, 'node')).then(() => true, () => false);
    if (install) {
      phase = 'toolchain'; effectStatus = 'may_have_changed';
      try {
        await run('npm', ['install', '--prefix', tools, '--engine-strict=false', '--no-audit', '--no-fund', 'node@24', 'npm@11.18.0'], { ...options, cwd: temporary });
      } catch (cause) { throw failure(phase, cause, 'Development toolchain installation failed.', effectStatus); }
    }
    if (install || local) {
      env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${env.PATH ?? ''}`;
      npm = join(bin, 'npm'); node = join(bin, 'node');
    }
    phase = 'versions';
    const nodeVersion = (await run(node, ['--version'], options)).stdout.trim();
    const npmVersion = (await run(npm, ['--version'], options)).stdout.trim();
    if (!meetsMinimum(nodeVersion, engines?.node) || !meetsMinimum(npmVersion, engines?.npm))
      throw new DevelopmentSetupError(phase, 'incompatible_toolchain', `Development needs Node.js ${engines?.node} and npm ${engines?.npm}. Run npm run setup:dev -- --install to prepare them inside this workspace.`, effectStatus);
    if (install) {
      phase = 'dependencies'; effectStatus = 'may_have_changed';
      try { await run(npm, ['ci', '--include=dev', '--no-audit', '--no-fund'], options); }
      catch (cause) { throw failure(phase, cause, 'Dependency installation failed.', effectStatus); }
    }
    phase = 'verification';
    try {
      await run(npm, ['ls', '--depth=0', '--include=dev'], options);
      await run(node, ['-e', "const Database = require('better-sqlite3'); new Database(':memory:').close(); require('node-pty'); require.resolve('vitest'); require.resolve('typescript'); require.resolve('vite');"], options);
    } catch (cause) { throw failure(phase, cause, 'Development dependencies are missing, stale, or built for another platform. Run npm run setup:dev -- --install in this sandbox.', effectStatus); }
    return { ready: true, platform: process.platform, arch: process.arch, node: nodeVersion, npm: npmVersion, toolchainPath: install || local ? bin : null, availableBytes: available, environment };
  } catch (cause) {
    pendingError = failure(phase, cause, 'Development setup failed.', effectStatus);
    throw pendingError;
  } finally {
    if (temporary) {
      try { await rm(temporary, { recursive: true, force: true }); }
      catch (cause) {
        const cleanup = failure('cleanup', cause, 'Development setup could not remove its temporary configuration.', effectStatus);
        if (pendingError) pendingError.cleanupReason = cleanup.reason;
        else throw cleanup;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).some((arg) => arg !== '--install')) {
    console.error('Usage: npm run setup:dev [-- --install]');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await prepareDevelopment({ install: process.argv.includes('--install') }))); }
    catch (error) { console.error(JSON.stringify(error instanceof DevelopmentSetupError ? error.toJSON() : { ready: false, phase: 'unknown', reason: 'command_failed' })); process.exitCode = 1; }
  }
}

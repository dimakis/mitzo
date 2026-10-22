import { execFile } from 'node:child_process';
import { readFile, statfs, mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import process from 'node:process';
import console from 'node:console';

const execute = promisify(execFile);

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
  const available = await freeBytes();
  if (available < 2 * 1024 ** 3)
    throw Error(
      'Development setup needs at least 2 GiB free for dependencies and builds. Free space in this sandbox and retry.',
    );
  const [manifest] = await Promise.all(
    ['package.json', 'package-lock.json'].map((name) => readFile(join(cwd, name), 'utf8')),
  );
  const { engines } = JSON.parse(manifest);
  // Package lifecycle code receives no inference/API tokens or host Git config.
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot'].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
  const temporary = await mkdtemp(join(tmpdir(), 'mitzo-dev-install-'));
  await writeFile(join(temporary, 'user.npmrc'), '');
  await writeFile(join(temporary, 'global.npmrc'), '');
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_0: 'ssh://git@github.com/',
    GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_1: 'git@github.com:',
    npm_config_userconfig: join(temporary, 'user.npmrc'),
    npm_config_globalconfig: join(temporary, 'global.npmrc'),
    npm_config_cache: join(temporary, 'cache'),
  });
  const options = { cwd, env, timeout: 15 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 };
  try {
    for (const tool of ['npm', 'git', 'python3', 'make', 'c++']) {
      try {
        await run(tool, ['--version'], options);
      } catch {
        throw Error(
          `Development setup is missing ${tool}. Use a sandbox image with the Node/native build toolchain.`,
        );
      }
    }
    const tools = join(cwd, '.mitzo-devtools');
    const bin = join(tools, 'node_modules', '.bin');
    let npm = 'npm',
      node = process.execPath;
    const local = await access(join(bin, 'node')).then(
      () => true,
      () => false,
    );
    if (install) {
      try {
        await run(
          'npm',
          [
            'install',
            '--prefix',
            tools,
            '--engine-strict=false',
            '--no-audit',
            '--no-fund',
            'node@24',
            'npm@11.18.0',
          ],
          { ...options, cwd: temporary },
        );
      } catch (cause) {
        throw Error(
          'Development toolchain installation failed. Allow public npm registry downloads in this sandbox and retry.',
          { cause },
        );
      }
    }
    if (install || local) {
      env.PATH = `${bin}:${env.PATH ?? ''}`;
      npm = join(bin, 'npm');
      node = join(bin, 'node');
    }
    const nodeVersion = (await run(node, ['--version'], options)).stdout.trim();
    const npmVersion = (await run(npm, ['--version'], options)).stdout.trim();
    if (!meetsMinimum(nodeVersion, engines?.node) || !meetsMinimum(npmVersion, engines?.npm)) {
      throw Error(
        `Development needs Node.js ${engines?.node} and npm ${engines?.npm}. Run npm run setup:dev -- --install to prepare them inside this workspace.`,
      );
    }
    if (install) {
      try {
        await run(npm, ['ci', '--include=dev', '--no-audit', '--no-fund'], options);
      } catch (cause) {
        throw Error(
          'Dependency installation failed. Check npm registry and GitHub network access, the pinned lockfile, and native build prerequisites in this sandbox.',
          { cause },
        );
      }
    }
    try {
      await run(npm, ['ls', '--depth=0', '--include=dev'], options);
      await run(
        node,
        [
          '-e',
          "const Database = require('better-sqlite3'); new Database(':memory:').close(); require('node-pty'); require.resolve('vitest'); require.resolve('typescript'); require.resolve('vite');",
        ],
        options,
      );
    } catch {
      throw Error(
        'Development dependencies are missing, stale, or built for another platform. Run npm run setup:dev -- --install in this sandbox.',
      );
    }
    return {
      ready: true,
      platform: process.platform,
      arch: process.arch,
      node: nodeVersion,
      npm: npmVersion,
      toolchainPath: install || local ? bin : null,
      availableBytes: available,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).some((arg) => arg !== '--install')) {
    console.error('Usage: npm run setup:dev [-- --install]');
    process.exitCode = 2;
  } else {
    try {
      console.log(
        JSON.stringify(await prepareDevelopment({ install: process.argv.includes('--install') })),
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

import { execFile } from 'node:child_process';
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import console from 'node:console';
import { prepareDevelopment, DevelopmentSetupError } from './prepare-development.mjs';

/** Offline acceptance harness for the existing setup owner. Installer effects
 * are forbidden. Injected process/cleanup seams are for offline failure tests. */
export async function qualifyDevelopmentOffline({
  cwd = process.cwd(),
  prepare = prepareDevelopment,
  execute = promisify(execFile),
  cleanup = rm,
} = {}) {
  const processes = [];
  let environment;
  let temporary;
  let phase = 'readiness';
  let pending;
  let result;
  const run = async (command, args, options) => {
    if (args[0] === 'install' || args[0] === 'ci')
      throw new Error('Offline qualification requires an already verified setup.');
    environment = options.env;
    processes.push(args[0] === 'ls' ? 'dependency-probe' : 'toolchain-or-native-probe');
    return execute(command, args, {
      ...options,
      env: { ...options.env, NODE_OPTIONS: '--max-old-space-size=1024' },
      encoding: 'utf8',
    });
  };
  try {
    const ready = await prepare({ cwd, install: false, run });
    if (!ready.toolchainPath) throw new Error('Prepare a task-owned toolchain first.');
    const node = join(ready.toolchainPath, 'node');
    phase = 'headers';
    const headers = join(ready.environment.nodeGyp, ready.node.replace(/^v/, ''));
    await access(join(headers, 'include', 'node', 'node.h'));
    phase = 'compiler';
    const gyp = resolve(
      ready.toolchainPath,
      '..',
      'npm',
      'node_modules',
      'node-gyp',
      'bin',
      'node-gyp.js',
    );
    await access(gyp);
    temporary = await mkdtemp(join(ready.environment.tmp, 'native-qualification-'));
    await writeFile(
      join(temporary, 'binding.gyp'),
      JSON.stringify({
        targets: [
          {
            target_name: 'offline_probe',
            sources: ['probe.cc'],
            cflags_cc: ['-std=c++20'],
            xcode_settings: { CLANG_CXX_LANGUAGE_STANDARD: 'c++20' },
          },
        ],
      }),
    );
    await writeFile(
      join(temporary, 'probe.cc'),
      `#include <node.h>
NODE_MODULE_INIT() {
  exports->Set(context, v8::String::NewFromUtf8Literal(context->GetIsolate(), "abi"),
    v8::Integer::New(context->GetIsolate(), NODE_MODULE_VERSION)).Check();
}
`,
    );
    // Setup has joined its own temporary by now. This physical phase owns a
    // fresh bytecode cache, which cannot resurrect setup's retired directory.
    const options = {
      cwd: temporary,
      env: { ...environment, PYTHONPYCACHEPREFIX: join(temporary, 'python-cache') },
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    };
    phase = 'compile';
    const start = performance.now();
    await run(node, [gyp, 'rebuild', `--nodedir=${headers}`, '--jobs=1'], options);
    const compilationMs = performance.now() - start;
    phase = 'load';
    const loaded = await run(
      node,
      [
        '-e',
        'console.log(require(process.argv[1]).abi)',
        join(temporary, 'build', 'Release', 'offline_probe.node'),
      ],
      options,
    );
    if (loaded.stdout.trim() !== ready.abi) throw new Error('Compiled native ABI does not match.');
    const beforeReuse = processes.length;
    phase = 'reuse';
    const reused = await prepare({ cwd, install: true, run });
    if (!reused.reused || reused.installationIdentity !== ready.installationIdentity)
      throw new Error('Unchanged setup did not reuse the existing installation.');
    result = {
      ready: true,
      platform: ready.platform,
      arch: ready.arch,
      node: ready.node,
      npm: ready.npm,
      abi: ready.abi,
      nativeCompilation: true,
      compilationMs,
      setupInstallCalls: 0,
      reuseProbeProcesses: processes.length - beforeReuse,
      taskOwnedEnvironment: true,
      headersDownloaded: false,
    };
  } catch (error) {
    pending =
      error instanceof DevelopmentSetupError
        ? error
        : new DevelopmentSetupError(
            phase,
            'qualification_unavailable',
            'Offline native qualification failed.',
            'may_have_changed',
          );
  } finally {
    if (temporary) {
      try {
        await cleanup(temporary, { recursive: true, force: true });
      } catch (error) {
        const reason = ['EACCES', 'EPERM'].includes(error.code)
          ? 'filesystem_denied'
          : 'command_failed';
        if (pending) pending.cleanupReason = reason;
        else
          pending = new DevelopmentSetupError(
            'cleanup',
            reason,
            'Offline native qualification cleanup failed.',
            'may_have_changed',
          );
      }
    }
  }
  if (pending) throw pending;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2)
      throw new DevelopmentSetupError(
        'arguments',
        'invalid_arguments',
        'Run in a prepared task without arguments.',
      );
    console.log(JSON.stringify(await qualifyDevelopmentOffline()));
  } catch (error) {
    console.error(
      JSON.stringify(
        error instanceof DevelopmentSetupError
          ? error.toJSON()
          : { ready: false, phase: 'unknown', reason: 'qualification_unavailable' },
      ),
    );
    process.exitCode = 1;
  }
}

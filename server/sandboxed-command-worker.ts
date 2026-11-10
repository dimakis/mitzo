import { privateRepositoryCheckoutCommand } from './private-repository-checkout.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  SandboxManager,
  SandboxRuntimeConfigSchema,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';
import { AuthoritySnapshot, type SerializedAuthority } from './sandbox-authority.js';
import {
  privateNativeFileHelperCommand,
  privateNativeFileProgramCommand,
  nativeFileHelperProgram,
  projectPrivateNativeFileHelperRequest,
} from './native-file-operation.js';

export interface SandboxWorkerPayload {
  cwd: string;
  command: string;
  config: SandboxRuntimeConfig;
  authority: SerializedAuthority;
  /** Optional target environment; bootstrap always runs with a trusted host environment. */
  env?: NodeJS.ProcessEnv;
  /** Trusted SDK runtime-only enrollment fences files without changing network policy. */
  filesystemOnly?: boolean;
  /** Trusted parent has approved this command's general network effects. */
  networkAccess?: 'approved-command' | 'loopback';
  /** Fixed private helper only, never arbitrary Bash's authority bypass. */
  privateNativeFileRequestJson?: string;
  privateNativeFileProgram?: { programPath: string; requestPath: string };
  privateRepositoryCheckoutJson?: string;
}

interface WorkerDependencies {
  manager: Pick<
    typeof SandboxManager,
    'initialize' | 'wrapWithSandbox' | 'reset' | 'checkDependencies'
  >;
  spawn: typeof spawn;
  platform?: NodeJS.Platform;
  wrapFilesystem?: (command: string, config: SandboxRuntimeConfig) => Promise<string>;
  wrapPrivateFile?: (command: string, config: SandboxRuntimeConfig) => Promise<string>;
}

async function macOSWrapper() {
  const require = createRequire(import.meta.url);
  const directory = dirname(require.resolve('@anthropic-ai/sandbox-runtime'));
  return import(pathToFileURL(join(directory, 'sandbox', 'macos-sandbox-utils.js')).href);
}

async function wrapFilesystemOnly(command: string, config: SandboxRuntimeConfig): Promise<string> {
  const { wrapCommandWithSandboxMacOS } = await macOSWrapper();
  return wrapCommandWithSandboxMacOS({
    command,
    commandId: randomUUID(),
    binShell: '/bin/sh',
    needsNetworkRestriction: false,
    allowAllUnixSockets: true,
    allowLocalBinding: true,
    allowMachLookup: ['*'],
    // Delegating to another application escapes this worker's file/process fence.
    allowAppleEvents: false,
    allowPty: true,
    allowGitConfig: true,
    readConfig: {
      denyOnly: config.filesystem.denyRead,
      allowWithinDeny: config.filesystem.allowRead,
    },
    writeConfig: {
      allowOnly: config.filesystem.allowWrite,
      denyWithinAllow: config.filesystem.denyWrite,
    },
  });
}

/** Fixed file operations need no proxy, listener or general network capability.
 * Use the same SRT macOS policy generator as the private repository reader,
 * with all networking denied. The worker still owns byte/custody verification
 * after wrapping, and the parent still joins and revalidates the original owner.
 */
async function wrapPrivateFile(command: string, config: SandboxRuntimeConfig): Promise<string> {
  const { wrapCommandWithSandboxMacOS } = await macOSWrapper();
  return wrapCommandWithSandboxMacOS({
    command,
    commandId: randomUUID(),
    binShell: '/bin/sh',
    needsNetworkRestriction: true,
    allowAllUnixSockets: false,
    allowLocalBinding: false,
    allowAppleEvents: false,
    allowPty: false,
    enableWeakerNetworkIsolation: false,
    readConfig: {
      denyOnly: config.filesystem.denyRead,
      allowWithinDeny: config.filesystem.allowRead,
    },
    writeConfig: {
      allowOnly: config.filesystem.allowWrite,
      denyWithinAllow: config.filesystem.denyWrite,
    },
  });
}

/** Each invocation runs in a fresh trusted process; SRT singleton state is never
 * shared between chats. The parent owns this process group and its time/output limits.
 */
export async function runSandboxedWorker(
  payload: SandboxWorkerPayload,
  dependencies: WorkerDependencies = { manager: SandboxManager, spawn },
): Promise<number> {
  const { manager, spawn: spawnCommand } = dependencies;
  if (
    payload.networkAccess !== undefined &&
    !['approved-command', 'loopback'].includes(payload.networkAccess)
  )
    throw new Error('Invalid command network authorization');
  if (payload.networkAccess && payload.filesystemOnly)
    throw new Error('Command network authorization cannot change SDK isolation');
  if (
    payload.privateNativeFileRequestJson !== undefined &&
    (payload.filesystemOnly ||
      payload.networkAccess ||
      (payload.privateNativeFileProgram
        ? payload.command !==
            privateNativeFileProgramCommand(
              payload.privateNativeFileProgram.programPath,
              payload.privateNativeFileProgram.requestPath,
            ) ||
          projectPrivateNativeFileHelperRequest(payload.privateNativeFileRequestJson) !==
            payload.privateNativeFileRequestJson
        : payload.command !== privateNativeFileHelperCommand(payload.privateNativeFileRequestJson)))
  )
    throw Error('Invalid private native file helper');
  if (
    payload.privateRepositoryCheckoutJson !== undefined &&
    (payload.filesystemOnly ||
      payload.networkAccess ||
      payload.privateNativeFileRequestJson !== undefined ||
      payload.command !== privateRepositoryCheckoutCommand(payload.privateRepositoryCheckoutJson))
  )
    throw Error('Invalid private repository checkout');
  if (payload.filesystemOnly !== undefined && typeof payload.filesystemOnly !== 'boolean')
    throw new Error('Invalid filesystem-only sandbox mode');
  if (payload.filesystemOnly && (dependencies.platform ?? process.platform) !== 'darwin')
    throw new Error('Filesystem-only SDK isolation requires macOS');
  const authority = AuthoritySnapshot.restore(payload.authority);
  if (payload.privateNativeFileProgram) {
    const { programPath, requestPath } = payload.privateNativeFileProgram;
    const root = dirname(process.env.HOME ?? '');
    if (
      !payload.privateNativeFileRequestJson ||
      dirname(programPath) !== root ||
      dirname(requestPath) !== root ||
      programPath !== join(root, 'helper.py') ||
      requestPath !== join(root, 'request.json')
    )
      throw Error('Invalid private native helper program');
    authority.verify();
    if (
      readFileSync(programPath, 'utf8') !== nativeFileHelperProgram ||
      readFileSync(requestPath, 'utf8') !== payload.privateNativeFileRequestJson
    )
      throw Error('Invalid private native helper program');
  }

  const config = SandboxRuntimeConfigSchema.parse(payload.config);
  const directPrivateFile =
    payload.privateNativeFileRequestJson !== undefined &&
    (dependencies.platform ?? process.platform) === 'darwin';
  if (
    directPrivateFile &&
    (payload.env !== undefined ||
      config.network.allowedDomains.length > 0 ||
      config.network.allowLocalBinding ||
      config.network.allowAllUnixSockets ||
      (config.network.allowUnixSockets?.length ?? 0) > 0 ||
      config.network.httpProxyPort !== undefined ||
      config.network.socksProxyPort !== undefined ||
      config.credentials !== undefined ||
      config.filesystem.disabled ||
      config.enableWeakerNetworkIsolation ||
      config.enableWeakerNestedSandbox ||
      config.allowAppleEvents)
  )
    throw Error('Invalid private native file isolation');
  const useManager = !payload.filesystemOnly && !directPrivateFile;
  const dependenciesCheck = manager.checkDependencies();
  if (dependenciesCheck.errors.length || dependenciesCheck.warnings.length)
    throw new Error('Complete OS sandbox dependencies are unavailable');
  try {
    if (useManager) {
      if (payload.networkAccess === 'approved-command')
        // This is a general network command grant, not a hostname-only security
        // boundary. SRT retains its proxy, explicit deny rules and socket policy.
        await manager.initialize(config, async () => true);
      else await manager.initialize(config);
    }
    authority.verify();
    // The outer shell starts before the OS sandbox. Transfer target argv/env
    // over a dedicated pipe to a tiny launcher AFTER crossing that boundary.
    // Neither provider secrets nor injected loader variables enter bootstrap
    // environment, shell arguments, SRT command attribution or violation logs.
    const quote = (part: string) => "'" + part.replaceAll("'", "'\\''") + "'";
    const launcher = `
      const net = require('node:net'), cp = require('node:child_process');
      const transfer = new net.Socket({ fd: 3, readable: true, writable: false });
      const chunks = [];
      let bytes = 0;
      transfer.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1048576) { process.stderr.write('SDK launch payload exceeds its limit\\n'); process.exit(1); }
        chunks.push(chunk);
      });
      transfer.once('error', error => { process.stderr.write(error.message + '\\n'); process.exit(1); });
      transfer.once('end', () => {
      transfer.destroy();
      let target;
      try {
        target = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!target || typeof target.command !== 'string' || !target.command ||
            !target.env || typeof target.env !== 'object' || Array.isArray(target.env) ||
            Object.values(target.env).some(value => typeof value !== 'string'))
          throw new Error('Invalid SDK launch payload');
      } catch { process.stderr.write('Invalid SDK launch payload\\n'); process.exit(1); }
      for (const name of ${JSON.stringify(['SANDBOX_RUNTIME', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'GRPC_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'grpc_proxy', 'GIT_SSH_COMMAND', 'GIT_CONFIG_PARAMETERS', 'JAVA_TOOL_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'])})
        if (process.env[name] !== undefined) target.env[name] = process.env[name];
      const child = cp.spawn('/bin/sh', ['-c', target.command], { env: target.env, stdio: 'inherit' });
      child.once('error', error => { process.stderr.write(error.message + '\\n'); process.exit(1); });
      // Reserve a high status for missing or signalled termination. The parent
      // treats all high statuses conservatively because shells also encode
      // signals as 128 + signal, indistinguishable from an explicit high exit.
      child.once('exit', (code, signal) => process.exit(signal ? 255 : (code ?? 255)));
      });
    `;
    const command = payload.env
      ? [process.execPath, '-e', launcher].map(quote).join(' ')
      : payload.command;
    const wrapped = payload.filesystemOnly
      ? await (dependencies.wrapFilesystem ?? wrapFilesystemOnly)(command, config)
      : directPrivateFile
        ? await (dependencies.wrapPrivateFile ?? wrapPrivateFile)(command, config)
        : await manager.wrapWithSandbox(command, undefined, undefined, undefined, {
            commandId: randomUUID(),
          });
    // Wrapping initializes network/mount policy asynchronously. Recheck only
    // after it completes, with no await before the actual sandboxed command spawn.
    authority.verify();
    return await new Promise<number>((resolve, reject) => {
      const child = spawnCommand('/bin/sh', ['-c', wrapped], {
        cwd: payload.cwd,
        detached: false,
        stdio: payload.env ? ['inherit', 'inherit', 'inherit', 'pipe'] : 'inherit',
        env: process.env,
      });
      child.once('error', reject);
      if (payload.env) {
        const transfer = child.stdio[3] as Writable;
        transfer.on('error', () => {});
        transfer.end(JSON.stringify({ command: payload.command, env: payload.env }));
      }
      child.once('close', (code, signal) => resolve(signal ? 255 : (code ?? 255)));
    });
  } finally {
    if (useManager) await manager.reset();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const payload = JSON.parse(readFileSync(process.argv[2], 'utf8')) as SandboxWorkerPayload;
    process.exitCode = await runSandboxedWorker(payload);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    // Startup/cleanup exceptions do not establish the target command's outcome.
    process.exitCode = 255;
  }
}

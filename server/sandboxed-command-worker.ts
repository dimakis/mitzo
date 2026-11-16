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
import { AuthoritySnapshot, validatePath, type SerializedAuthority } from './sandbox-authority.js';
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
  /** Controller-selected SDK launch workspace; never supplied by provider tools. */
  sdkGitWorkRoot?: string;
  /** Trusted parent has approved this command's general network effects. */
  networkAccess?: 'approved-command' | 'loopback';
  /** Fixed private helper only, never arbitrary Bash's authority bypass. */
  privateNativeFileRequestJson?: string;
  privateNativeFileProgram?: { programPath: string; requestPath: string };
  privateRepositoryCheckoutJson?: string;
  /** The opted-in SDK launch receives the host GitHub login over the bootstrap
   * transfer variable, never from this on-disk payload. */
  hostGithubToken?: true;
}

/** Bootstrap-only variable carrying the host GitHub login to this worker. Declared
 * here so the worker's compiled module closure gains no controller-side import;
 * host-github-credential.ts mirrors it and a test pins the two together. */
export const HOST_GITHUB_TOKEN_TRANSFER = 'MITZO_SDK_HOST_GITHUB_TOKEN_TRANSFER';

/** Remove the host GitHub transfer from the worker's own environment before
 * anything else runs, so neither the bootstrap shell nor SRT ever sees it. */
export function takeHostGithubTransfer(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env[HOST_GITHUB_TOKEN_TRANSFER];
  delete env[HOST_GITHUB_TOKEN_TRANSFER];
  return token;
}

/** Deliver the transferred login only when the trusted payload requested it. */
export function admitHostGithubToken(
  payload: Pick<SandboxWorkerPayload, 'env' | 'hostGithubToken'>,
  token: string | undefined,
) {
  if (payload.hostGithubToken === undefined && token === undefined) return;
  if (payload.hostGithubToken !== true || !token || !payload.env)
    throw Error('Invalid host GitHub launch transfer');
  payload.env = { ...payload.env, GH_TOKEN: token };
}

/** Add deny-only rules to the pinned SRT Seatbelt policy. Its allowGitConfig is global; the
 * SDK must only gain config writes for repositories created below its workspace.
 * macOS cannot apply a second sandbox_init after entering the first sandbox.
 * Decode only SRT's literal single-quote encoding, never execute a shell parser,
 * and fail closed if its invocation contract changes. Retain every argv value
 * and append restrictions to its original profile; do not reconstruct its policy.
 */
export function wrapSdkGitMetadata(command: string, root: string): string {
  validatePath(root);
  const argv: string[] = [];
  let offset = 0;
  while (offset < command.length) {
    if (/\s/.test(command[offset]!)) {
      offset++;
      continue;
    }
    let value = '';
    while (offset < command.length && !/\s/.test(command[offset]!)) {
      if (command[offset] === "'") {
        const end = command.indexOf("'", offset + 1);
        if (end < 0) throw Error('Unsupported SRT SDK sandbox invocation');
        value += command.slice(offset + 1, end);
        offset = end + 1;
      } else if (command.startsWith('"\'"', offset)) {
        value += "'";
        offset += 3;
      } else {
        const literal = /^[A-Za-z0-9_./:=@+,-]+/.exec(command.slice(offset));
        if (!literal) throw Error('Unsupported SRT SDK sandbox invocation');
        value += literal[0];
        offset += literal[0].length;
      }
    }
    argv.push(value);
  }
  const sandbox = argv.indexOf('/usr/bin/sandbox-exec');
  let prefix = 1;
  while (prefix < sandbox && argv[prefix] === '-u') {
    if (prefix + 1 >= sandbox || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(argv[prefix + 1]!))
      throw Error('Unsupported SRT SDK sandbox invocation');
    prefix += 2;
  }
  for (; prefix < sandbox; prefix++) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[prefix]!))
      throw Error('Unsupported SRT SDK sandbox invocation');
  }
  if (
    argv[0] !== 'env' ||
    sandbox < 1 ||
    argv.lastIndexOf('/usr/bin/sandbox-exec') !== sandbox ||
    argv.length !== sandbox + 6 ||
    argv[sandbox + 1] !== '-p' ||
    argv[sandbox + 4] !== '-c' ||
    !['/bin/sh', '/bin/bash', '/bin/zsh'].includes(argv[sandbox + 3]!) ||
    !argv[sandbox + 2]!.startsWith('(version 1)\n') ||
    !/\n\(deny default[ )]/.test(argv[sandbox + 2]!)
  )
    throw Error('Unsupported SRT SDK sandbox invocation');
  const string = (value: string) => JSON.stringify(value);
  const restrictions = [
    // SRT explicitly allows unlink/create beneath write roots. Seatbelt's
    // specific-operation allows beat a file-write* deny, so re-deny moves and
    // deletion explicitly as well as content/metadata writes.
    `(deny file-write* file-write-unlink file-write-create (require-all (regex ${string('.*/\\.git(/.*)?$')}) (require-not (subpath ${string(root)}))))`,
    // A standalone task owns its Git storage. Linked worktrees keep their
    // external administration denied and use the trusted commit integration.
    // Pin the selected workspace and its ancestors against replacement.
    ...(() => {
      const paths = [];
      for (let path = root; path !== '/'; path = dirname(path)) paths.push(path);
      return paths.map(
        (path) => `(deny file-write-unlink file-write-create (literal ${string(path)}))`,
      );
    })(),
  ].join('\n');
  argv[sandbox + 2] = argv[sandbox + 2]! + '\n' + restrictions;
  const quote = (part: string) => "'" + part.replaceAll("'", "'\\''") + "'";
  return argv.map(quote).join(' ');
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

async function sandboxRuntimeModule(name: 'macos-sandbox-utils.js' | 'sandbox-utils.js') {
  const require = createRequire(import.meta.url);
  const directory = dirname(require.resolve('@anthropic-ai/sandbox-runtime'));
  return import(pathToFileURL(join(directory, 'sandbox', name)).href);
}

async function wrapFilesystemOnly(command: string, config: SandboxRuntimeConfig): Promise<string> {
  const { wrapCommandWithSandboxMacOS } = await sandboxRuntimeModule('macos-sandbox-utils.js');
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
  const [{ wrapCommandWithSandboxMacOS }, { removeTrailingGlobSuffix }] = await Promise.all([
    sandboxRuntimeModule('macos-sandbox-utils.js'),
    sandboxRuntimeModule('sandbox-utils.js'),
  ]);
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
    // Match SandboxManager's preprocessing: a trailing /** includes the
    // directory itself. Passing it raw would deny descendants but allow
    // listing the denied directory. Use the pinned runtime's own normalizer.
    readConfig: {
      denyOnly: config.filesystem.denyRead.map(removeTrailingGlobSuffix),
      allowWithinDeny: (config.filesystem.allowRead ?? []).map(removeTrailingGlobSuffix),
    },
    writeConfig: {
      allowOnly: config.filesystem.allowWrite.map(removeTrailingGlobSuffix),
      denyWithinAllow: config.filesystem.denyWrite.map(removeTrailingGlobSuffix),
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
  if (payload.sdkGitWorkRoot !== undefined) {
    validatePath(payload.sdkGitWorkRoot);
    if (
      payload.sdkGitWorkRoot !== payload.cwd ||
      (dependencies.platform ?? process.platform) !== 'darwin' ||
      !payload.authority.some((entry) => entry.path === payload.sdkGitWorkRoot)
    )
      throw Error('Invalid SDK Git workspace authority');
  }
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
      // The controller-selected scratch directory is part of the write policy.
      // SRT's generic TMPDIR must not replace it after that policy was frozen.
      for (const name of ${JSON.stringify(['SANDBOX_RUNTIME', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'GRPC_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'grpc_proxy', 'GIT_SSH_COMMAND', 'GIT_CONFIG_PARAMETERS', 'JAVA_TOOL_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'])})
        if (process.env[name] !== undefined && (name !== 'TMPDIR' || target.env[name] === undefined))
          target.env[name] = process.env[name];
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
    const inner = payload.filesystemOnly
      ? await (dependencies.wrapFilesystem ?? wrapFilesystemOnly)(command, config)
      : directPrivateFile
        ? await (dependencies.wrapPrivateFile ?? wrapPrivateFile)(command, config)
        : await manager.wrapWithSandbox(command, undefined, undefined, undefined, {
            commandId: randomUUID(),
          });
    const wrapped = payload.sdkGitWorkRoot
      ? wrapSdkGitMetadata(inner, payload.sdkGitWorkRoot)
      : inner;
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
        transfer.on('error', (cause: Error) => {
          process.stderr.write(
            JSON.stringify({
              stage: 'sdk_environment_transfer',
              code: 'sdk_environment_transfer_failed',
              message: cause.message,
            }) + '\n',
          );
        });
        transfer.end(JSON.stringify({ command: payload.command, env: payload.env }));
      }
      child.once('close', (code, signal) => resolve(signal ? 255 : (code ?? 255)));
    });
  } finally {
    if (useManager) await manager.reset();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hostGithubToken = takeHostGithubTransfer();
  try {
    const payload = JSON.parse(readFileSync(process.argv[2], 'utf8')) as SandboxWorkerPayload;
    admitHostGithubToken(payload, hostGithubToken);
    process.exitCode = await runSandboxedWorker(payload);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    // Startup/cleanup exceptions do not establish the target command's outcome.
    process.exitCode = 255;
  }
}

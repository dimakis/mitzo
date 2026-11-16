import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { Readable } from 'node:stream';
import { createLogger } from './logger.js';
import {
  HOST_GITHUB_TOKEN_TRANSFER,
  hostGithubEnvironment,
  type HostGithubCredentialResolver,
} from './host-github-credential.js';
const log = createLogger('credential-sdk-boundary');
export type ProtectedSdkProcess = SpawnedProcess & {
  stderr: Readable;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
};

export interface SdkRepositoryReadProjection {
  readonly kind: 'sdk-default-read-deny-only-v1';
  readonly readableRoots: readonly string[];
  readonly workspaceRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly deniedReadPatterns: readonly string[];
  readonly policySha256: string;
  assertCurrentSync(): void;
}
const repositoryReadProjections = new WeakSet<object>();
const repositoryReadOwners = new WeakMap<object, object>();
/** Factory provenance only. Every use still requires the actual current SDK
 * callback or completed-turn owner, and enforces the complete captured policy. */
export function assertSdkRepositoryReadProjection(
  value: SdkRepositoryReadProjection,
  owner?: object,
): void {
  if (
    !repositoryReadProjections.has(value) ||
    (owner !== undefined && repositoryReadOwners.get(value) !== owner)
  )
    throw Error('Original SDK read projection required');
  value.assertCurrentSync();
}
import { canonical, AuthoritySnapshot, validatePath } from './sandbox-authority.js';
import { getCredentialConnectionsRuntime } from './credential-connections-runtime.js';
import type { SandboxWorkerPayload } from './sandboxed-command-worker.js';
import { telosPrivateStorageRoots } from './telos-private-paths.js';
import {
  workspaceRuntimeAuthorityPaths,
  workspaceRuntimePrivateFiles,
  workspaceRuntimeSelectorEntries,
} from './workspace-runtime-private-paths.js';

/** Force SRT's glob branch so it cannot follow the final selector pointer.
 * macOS Seatbelt sees the pointer's physical directory entry for unlink/create,
 * while operations below a directory link use its resolved target. Thus /tm[p]
 * protects /tmp itself without denying writes throughout /private/tmp.
 */
function selectorWritePattern(entry: string): string {
  if (!isAbsolute(entry) || resolve(entry) !== entry || /[*?[\]{}]/.test(entry))
    throw new Error('SDK runtime selector must have a literal absolute path');
  const parent = dirname(entry);
  if (parent !== '/') validatePath(parent);
  const name = basename(entry);
  let index = name.length - 1;
  while (index >= 0 && !/[a-zA-Z0-9]/.test(name[index]!)) index--;
  if (index < 0) throw new Error('SDK runtime selector requires a literal filename');
  return join(parent, name.slice(0, index) + '[' + name[index] + ']' + name.slice(index + 1));
}

function runtimeFilesystemProtection() {
  const storageRoots = telosPrivateStorageRoots().map(canonical);
  const authorityFiles = workspaceRuntimePrivateFiles().map(canonical);
  const privateFiles = [...new Set([...authorityFiles, ...storageRoots])];
  const sourceRoots = workspaceRuntimeAuthorityPaths().map(canonical);
  const selectors = workspaceRuntimeSelectorEntries();
  const writeRoots = [...new Set([...authorityFiles.map(dirname), ...sourceRoots])];
  [...privateFiles, ...writeRoots].forEach(validatePath);
  return { privateFiles, writeRoots, selectors, patterns: selectors.map(selectorWritePattern) };
}

/** The SDK's own sandbox settings are mutable provider policy. An outer OS sandbox
 * protects the whole provider process, including native Read, arbitrary Bash,
 * project hooks and stdio MCP descendants, independently of those settings. */
export function credentialSdkBoundary(
  platform: NodeJS.Platform = process.platform,
  selectedAuthorityWriteRoots: readonly string[] = [],
  selectedProviderBaseUrl?: string,
  repositoryOwner?: object,
  /** Explicit opt-in (ordinary SDK chats only): expose the host operator's own
   * github.com login to native git/gh. Resolved again for every launch. */
  hostGithubCredential?: HostGithubCredentialResolver,
) {
  return createSdkBoundary(
    platform,
    false,
    selectedAuthorityWriteRoots,
    selectedProviderBaseUrl,
    false,
    repositoryOwner,
    hostGithubCredential,
  );
}

/** Only the fixed native `auth login` supervisor may allocate a terminal.
 * Claude's manual fallback after a denied callback bind requires terminal stdin.
 * Network restrictions, including loopback access, remain unchanged.
 */
export function claudeLoginSdkBoundary(platform: NodeJS.Platform = process.platform) {
  return createSdkBoundary(platform, false, [], 'https://api.anthropic.com', true);
}

/** Controller project commands need the runtime fence for every provider, with
 * no change to their credential environment or network policy. */
export function runtimeFilesystemSdkBoundary(platform: NodeJS.Platform = process.platform) {
  return createSdkBoundary(platform, true);
}

function createSdkBoundary(
  platform: NodeJS.Platform,
  runtimeOnly: boolean,
  selectedAuthorityWriteRoots: readonly string[] = [],
  selectedProviderBaseUrl?: string,
  nativeLogin = false,
  repositoryOwner?: object,
  hostGithubCredential?: HostGithubCredentialResolver,
) {
  const selectedWriteRoots = [...new Set(selectedAuthorityWriteRoots.map(canonical))];
  selectedWriteRoots.forEach(validatePath);
  Object.freeze(selectedWriteRoots);
  const initialRuntime = runtimeFilesystemProtection();
  const storage = [
    join(homedir(), '.mitzo', 'keychain-helper'),
    join(homedir(), '.mitzo', 'credential-connections'),
    ...(process.env.MITZO_KEYCHAIN_CONNECTIONS_DIR
      ? [process.env.MITZO_KEYCHAIN_CONNECTIONS_DIR]
      : []),
  ];
  const credentialIsolation =
    !runtimeOnly &&
    (process.env.MITZO_SECRET_RELAY_ENABLED === '1' ||
      process.env.MITZO_KEYCHAIN_CONNECTIONS_ENABLED === '1' ||
      !!getCredentialConnectionsRuntime() ||
      storage.some(existsSync));
  if (
    !credentialIsolation &&
    initialRuntime.privateFiles.length === 0 &&
    initialRuntime.writeRoots.length === 0 &&
    selectedWriteRoots.length === 0
  )
    return undefined;
  const deniedRoots = [
    ...new Set(
      [
        ...initialRuntime.privateFiles,
        join(process.cwd(), '.env'),
        ...(credentialIsolation
          ? [
              ...storage,
              join(homedir(), '.mitzo'),
              join(homedir(), '.mitzo', 'internal-token'),
              join(homedir(), 'Library', 'Keychains'),
              join(homedir(), '.config', 'openshell'),
              ...(process.env.MITZO_KEYCHAIN_HELPER ? [process.env.MITZO_KEYCHAIN_HELPER] : []),
            ]
          : []),
      ].map(canonical),
    ),
  ];
  const providerBaseUrl = credentialIsolation
    ? (selectedProviderBaseUrl ?? process.env.ANTHROPIC_BASE_URL)
    : undefined;
  const providerDomain = providerBaseUrl ? new URL(providerBaseUrl).hostname : undefined;
  if (
    providerDomain &&
    (providerDomain === 'localhost' || isIP(providerDomain.replace(/^\[|\]$/g, '')))
  )
    throw new Error(
      'Keychain SDK sandbox requires a hostname provider endpoint outside local controller addresses',
    );
  const trustedExecutableRoots = [
    ...new Set((process.env.PATH ?? '').split(':').filter(isAbsolute).map(canonical)),
  ];
  trustedExecutableRoots.forEach(validatePath);
  deniedRoots.forEach(validatePath);
  Object.freeze(deniedRoots);
  // Deployment retains complete environment copies. Fixed family patterns also
  // fence interrupted/future copies across restart without scanning the directory.
  const environmentRoot = canonical(process.cwd());
  validatePath(environmentRoot);
  const privateEnvironmentPatterns = ['.env.before-runtime-*', '.env.runtime-*'].map((name) =>
    join(environmentRoot, name),
  );
  let readProjection: Readonly<SdkRepositoryReadProjection> | undefined;
  return {
    credentialIsolation,
    deniedRoots,
    /** This launch freezes writes to its workspace, scratch and account roots,
     * so a worktree created elsewhere after spawn is not writable by the provider. */
    confinesWorkspaceWrites: !runtimeOnly,
    /** Original OS-policy producer only. A current SDK callback/barrier must add
     * its own operator/account/root/query fence. Presence grants no source read.
     * Do not replace private patterns with a guessed literal-root projection. */
    captureRepositoryReadProjection() {
      if (!readProjection) throw Error('Original SDK read projection unavailable');
      readProjection.assertCurrentSync();
      return readProjection;
    },
    spawnClaudeCodeProcess(
      options: SpawnOptions & { captureStderr?: boolean },
    ): ProtectedSdkProcess {
      options.signal.throwIfAborted();
      if (platform !== 'darwin')
        throw new Error('Protected Claude SDK process isolation requires macOS');
      const dependencies = SandboxManager.checkDependencies();
      if (dependencies.errors.length || dependencies.warnings.length)
        throw new Error(
          'Protected Claude SDK requires complete OS sandbox dependencies; install them before retrying',
        );
      // A factory can be retained while a host operator changes enrollment.
      // Reconcile known authority immediately before each provider launch.
      const runtime = runtimeFilesystemProtection();
      const launchDeniedRoots = [...new Set([...deniedRoots, ...runtime.privateFiles])];
      const authority = new AuthoritySnapshot();
      const gitWorkRoot = canonical(options.cwd ?? process.cwd());
      validatePath(gitWorkRoot);
      authority.capture(gitWorkRoot);
      launchDeniedRoots.forEach((root) =>
        authority.capture(root, runtime.privateFiles.includes(root)),
      );
      runtime.writeRoots.forEach((root) => authority.capture(root));
      selectedWriteRoots.forEach((root) => authority.capture(root));
      runtime.selectors.forEach((entry) => authority.capture(dirname(entry)));
      const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-sdk-sandbox-')));
      // Keep provider/command scratch separate from the unreadable policy and
      // other sessions' temporary files. Children inherit this exact directory.
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-sdk-scratch-')));
      // Vertex retains the SDK's default history directory when no explicit
      // account directory was selected. Do not grant its entire home directory.
      const accountDirectory = canonical(
        options.env?.CLAUDE_CONFIG_DIR ?? join(options.env?.HOME ?? homedir(), '.claude'),
      );
      const writableRoots = runtimeOnly
        ? ['/']
        : [...new Set([gitWorkRoot, scratch, accountDirectory])];
      for (const root of writableRoots) if (root !== '/') validatePath(root);
      for (const root of writableRoots)
        if (root !== '/' && (root !== accountDirectory || existsSync(root)))
          authority.capture(root);
      const cleanup = () => {
        for (const path of [temporary, scratch]) {
          try {
            rmSync(path, { recursive: true, force: true });
          } catch (cause) {
            log.warn('SDK temporary cleanup failed', {
              stage: 'sdk_cleanup',
              code: 'sdk_temporary_cleanup_failed',
              err: cause,
            });
          }
        }
      };
      // SRT keeps hooks read-only. Git's stock template copies sample hooks on
      // init/clone, so give setup an empty, immutable template instead.
      const gitTemplate = join(temporary, 'git-template');
      mkdirSync(gitTemplate, { mode: 0o500 });
      const policy = join(temporary, 'policy.json');
      const bootstrapConfig = join(temporary, 'tsconfig.json');
      writeFileSync(bootstrapConfig, '{}', { mode: 0o600 });
      const worker = fileURLToPath(
        new URL(
          import.meta.url.endsWith('.ts')
            ? './sandboxed-command-worker.ts'
            : './sandboxed-command-worker.js',
          import.meta.url,
        ),
      );
      const require = createRequire(import.meta.url);
      let dependencyRoot = dirname(require.resolve('@anthropic-ai/sandbox-runtime'));
      while (
        basename(dependencyRoot) !== 'node_modules' &&
        dirname(dependencyRoot) !== dependencyRoot
      )
        dependencyRoot = dirname(dependencyRoot);
      if (basename(dependencyRoot) !== 'node_modules')
        throw new Error('Keychain SDK sandbox requires an immutable dependency installation');
      const executable = canonical(process.execPath);
      const runtimeInstallation = executable.startsWith('/opt/homebrew/')
        ? '/opt/homebrew'
        : executable.startsWith('/usr/local/')
          ? '/usr/local'
          : dirname(dirname(executable));
      const workerArgs = import.meta.url.endsWith('.ts')
        ? ['--import', require.resolve('tsx/esm'), worker]
        : [worker];
      const quote = (part: string) => "'" + part.replaceAll("'", "'\\''") + "'";
      const targetEnv: NodeJS.ProcessEnv = {
        ...options.env,
        GIT_TEMPLATE_DIR: gitTemplate,
        ...(!runtimeOnly
          ? {
              TMPDIR: scratch,
              XDG_CACHE_HOME: join(scratch, 'cache'),
              npm_config_cache: join(scratch, 'npm'),
              PIP_CACHE_DIR: join(scratch, 'pip'),
            }
          : {}),
      };
      // Source-import authority belongs to the controller in every SDK mode.
      delete targetEnv.MITZO_TELOS_IMPORT_TOKEN;
      if (credentialIsolation || selectedWriteRoots.length > 0) {
        for (const name of [
          'AUTH_PASSPHRASE',
          'AUTH_SECRET',
          'NTFY_AUTH_TOKEN',
          'GH_TOKEN',
          'GITHUB_TOKEN',
        ])
          delete targetEnv[name];
        for (const name of Object.keys(targetEnv))
          if (/^MITZO_.*(?:TOKEN|SECRET|CAPABILITY|PASSPHRASE)$/.test(name)) delete targetEnv[name];
      }
      // The controller's publisher token was removed above and is never reused.
      // Only the host operator's own login is transferred, outside the policy file.
      const hostGithub =
        !runtimeOnly && !nativeLogin && hostGithubCredential ? hostGithubCredential() : undefined;
      if (hostGithub) Object.assign(targetEnv, hostGithubEnvironment(hostGithub.gh, targetEnv));
      const payload: SandboxWorkerPayload = {
        cwd: gitWorkRoot,
        command: [options.command, ...options.args].map(quote).join(' '),
        authority: authority.serialize(),
        sdkGitWorkRoot: gitWorkRoot,
        ...(credentialIsolation ? {} : { filesystemOnly: true }),
        ...(hostGithub ? { hostGithubToken: true as const } : {}),
        env: targetEnv,
        config: {
          filesystem: {
            denyRead: [...launchDeniedRoots, ...privateEnvironmentPatterns, temporary],
            allowRead: [gitTemplate],
            allowWrite: writableRoots,
            // The worker adds an immutable OS fence around Git metadata:
            // only repositories inside this launch's workspace may change.
            allowGitConfig: true,
            denyWrite: [
              ...launchDeniedRoots,
              ...privateEnvironmentPatterns,
              ...runtime.writeRoots,
              ...selectedWriteRoots,
              ...runtime.patterns,
              ...trustedExecutableRoots,
              temporary,
              dirname(worker),
              runtimeInstallation,
              worker,
              fileURLToPath(
                new URL(
                  import.meta.url.endsWith('.ts')
                    ? './sandbox-authority.ts'
                    : './sandbox-authority.js',
                  import.meta.url,
                ),
              ),
              dependencyRoot,
              process.execPath,
              ...(import.meta.url.endsWith('.ts') ? [dirname(require.resolve('tsx/esm'))] : []),
            ],
          },
          network: {
            allowedDomains: [
              'api.anthropic.com',
              'claude.ai',
              // Native Claude OAuth code exchange and token refresh.
              'platform.claude.com',
              '*.anthropic.com',
              '*.googleapis.com',
              'github.com',
              '*.github.com',
              'raw.githubusercontent.com',
              'registry.npmjs.org',
              'pypi.org',
              'files.pythonhosted.org',
              ...(providerDomain ? [providerDomain] : []),
              ...(hostGithub ? ['*.githubusercontent.com'] : []),
            ],
            deniedDomains: ['169.254.169.254', 'metadata.google.internal'],
            allowLocalBinding: false,
            allowAllUnixSockets: false,
            // gh (Go) verifies TLS through trustd. This one service is narrower
            // than SRT's weaker network isolation, which stays disabled.
            ...(hostGithub ? { allowMachLookup: ['com.apple.trustd.agent'] } : {}),
          },
          enableWeakerNestedSandbox: false,
          enableWeakerNetworkIsolation: false,
          allowAppleEvents: false,
          allowPty: nativeLogin,
        },
      };
      writeFileSync(policy, JSON.stringify(payload), { mode: 0o600 });
      let child;
      try {
        authority.verify();
        child = spawn(process.execPath, [...workerArgs, policy], {
          cwd: gitWorkRoot,
          env: {
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            HOME: homedir(),
            TMPDIR: tmpdir(),
            TSX_TSCONFIG_PATH: bootstrapConfig,
            TSX_DISABLE_CACHE: '1',
            ...(hostGithub ? { [HOST_GITHUB_TOKEN_TRANSFER]: hostGithub.token } : {}),
          },
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const literalDenials = Object.freeze([...launchDeniedRoots, temporary]);
        const patternDenials = Object.freeze([...privateEnvironmentPatterns]);
        const originalRuntime = JSON.stringify(runtime);
        const snapshot = Object.freeze({
          kind: 'sdk-default-read-deny-only-v1' as const,
          // SRT's default-read policy, exactly as constructed above. The helper
          // omits the provider's git-template re-allow, a stricter read ceiling.
          readableRoots: Object.freeze(['/']),
          workspaceRoots: Object.freeze([] as string[]),
          deniedRoots: literalDenials,
          deniedReadPatterns: patternDenials,
          policySha256: createHash('sha256')
            .update(
              JSON.stringify({
                defaultRead: true,
                denyRead: payload.config.filesystem.denyRead,
              }),
            )
            .digest('hex'),
          assertCurrentSync() {
            if (
              readProjection !== snapshot ||
              JSON.stringify(runtimeFilesystemProtection()) !== originalRuntime
            )
              throw Error('Original SDK read projection changed');
            authority.verify();
          },
        });
        repositoryReadProjections.add(snapshot);
        if (repositoryOwner) repositoryReadOwners.set(snapshot, repositoryOwner);
        readProjection = snapshot;
      } catch (error) {
        cleanup();
        throw error;
      }
      let killed = false;
      const kill = (signal: NodeJS.Signals = 'SIGTERM') => {
        killed = true;
        if (!child.pid) return false;
        try {
          process.kill(-child.pid, signal);
          return true;
        } catch (cause) {
          if (!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH'))
            log.warn('SDK process group termination failed', {
              stage: 'sdk_stop',
              code: 'sdk_process_termination_failed',
              pid: child.pid,
              err: cause,
            });
          return false;
        }
      };
      const abort = () => kill('SIGKILL');
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
      child.once('exit', () => kill('SIGKILL'));
      child.once('close', () => {
        kill('SIGKILL');
        options.signal.removeEventListener('abort', abort);
        cleanup();
      });
      // SDK protocol is confined to stdout; startup failures go to stderr.
      // Consume stderr to avoid backpressure while exposing actionable sandbox failures.
      if (!options.captureStderr)
        child.stderr.on('data', (data: Buffer) => {
          process.stderr.write(data);
        });
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        get killed() {
          return killed;
        },
        get exitCode() {
          return child.exitCode;
        },
        kill,
        on: child.on.bind(child),
        once: child.once.bind(child),
        off: child.off.bind(child),
      };
    },
  };
}

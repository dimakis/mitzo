import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isIP } from 'node:net';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { canonical, AuthoritySnapshot, validatePath } from './sandbox-authority.js';
import { getCredentialConnectionsRuntime } from './credential-connections-runtime.js';
import type { SandboxWorkerPayload } from './sandboxed-command-worker.js';

/** The SDK's own sandbox settings are mutable provider policy. An outer OS sandbox
 * protects the whole provider process, including native Read, arbitrary Bash,
 * project hooks and stdio MCP descendants, independently of those settings. */
export function credentialSdkBoundary(platform: NodeJS.Platform = process.platform) {
  const storage = [
    join(homedir(), '.mitzo', 'keychain-helper'),
    join(homedir(), '.mitzo', 'credential-connections'),
    ...(process.env.MITZO_KEYCHAIN_CONNECTIONS_DIR
      ? [process.env.MITZO_KEYCHAIN_CONNECTIONS_DIR]
      : []),
  ];
  if (
    process.env.MITZO_KEYCHAIN_CONNECTIONS_ENABLED !== '1' &&
    !getCredentialConnectionsRuntime() &&
    !storage.some(existsSync)
  )
    return undefined;
  const deniedRoots = [
    ...new Set(
      [
        ...storage,
        join(homedir(), '.mitzo'),
        join(process.cwd(), '.env'),
        join(homedir(), '.mitzo', 'internal-token'),
        join(homedir(), 'Library', 'Keychains'),
        ...(process.env.MITZO_KEYCHAIN_HELPER ? [process.env.MITZO_KEYCHAIN_HELPER] : []),
      ].map(canonical),
    ),
  ];
  const providerBaseUrl = process.env.ANTHROPIC_BASE_URL;
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
  return {
    deniedRoots,
    spawnClaudeCodeProcess(options: SpawnOptions): SpawnedProcess {
      options.signal.throwIfAborted();
      if (platform !== 'darwin')
        throw new Error('Keychain-protected Claude SDK process isolation requires macOS');
      const dependencies = SandboxManager.checkDependencies();
      if (dependencies.errors.length || dependencies.warnings.length)
        throw new Error(
          'Keychain-protected Claude SDK requires complete OS sandbox dependencies; install them before retrying',
        );
      const authority = new AuthoritySnapshot();
      deniedRoots.forEach((root) => authority.capture(root));
      const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-sdk-sandbox-')));
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
      const targetEnv = { ...options.env };
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
      const payload: SandboxWorkerPayload = {
        cwd: options.cwd ?? process.cwd(),
        command: [options.command, ...options.args].map(quote).join(' '),
        authority: authority.serialize(),
        env: targetEnv,
        config: {
          filesystem: {
            denyRead: [...deniedRoots, temporary],
            allowRead: [],
            allowWrite: ['/'],
            denyWrite: [
              ...deniedRoots,
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
              '*.anthropic.com',
              '*.googleapis.com',
              'github.com',
              '*.github.com',
              'raw.githubusercontent.com',
              'registry.npmjs.org',
              'pypi.org',
              'files.pythonhosted.org',
              ...(providerDomain ? [providerDomain] : []),
            ],
            deniedDomains: ['169.254.169.254', 'metadata.google.internal'],
            allowLocalBinding: false,
            allowAllUnixSockets: false,
          },
          enableWeakerNestedSandbox: false,
          enableWeakerNetworkIsolation: false,
          allowAppleEvents: false,
        },
      };
      writeFileSync(policy, JSON.stringify(payload), { mode: 0o600 });
      let child;
      try {
        authority.verify();
        child = spawn(process.execPath, [...workerArgs, policy], {
          cwd: options.cwd,
          env: {
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            HOME: homedir(),
            TMPDIR: tmpdir(),
            TSX_TSCONFIG_PATH: bootstrapConfig,
            TSX_DISABLE_CACHE: '1',
          },
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        rmSync(temporary, { recursive: true, force: true });
        throw error;
      }
      let killed = false;
      const kill = (signal: NodeJS.Signals = 'SIGTERM') => {
        killed = true;
        if (!child.pid) return false;
        try {
          process.kill(-child.pid, signal);
          return true;
        } catch {
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
        rmSync(temporary, { recursive: true, force: true });
      });
      // SDK protocol is confined to stdout; startup failures go to stderr.
      // Consume stderr to avoid backpressure while exposing actionable sandbox failures.
      child.stderr.on('data', (data: Buffer) => {
        process.stderr.write(data);
      });
      return {
        stdin: child.stdin,
        stdout: child.stdout,
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

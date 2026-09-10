import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AuthoritySnapshot, identity, validatePath } from './sandbox-authority.js';
import type { SandboxWorkerPayload } from './sandboxed-command-worker.js';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export interface SandboxedCommandOptions {
  command: string;
  cwd: string;
  writableRoots: string[];
  deniedRoots: string[];
  env: Record<string, string>;
  signal: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowedDomains?: string[];
  beforeSpawn?: () => void;
}

function contains(root: string, path: string) {
  return path === root || path.startsWith(root + '/');
}

/** Verify both halves of Git's linked-worktree registration before granting its
 * metadata. A forged .git file alone must never grant an arbitrary host directory.
 * Standard repositories already hold their metadata inside the authorized root.
 */
function gitMetadataRoots(
  root: string,
  authority: AuthoritySnapshot,
): { writable: string[]; protected: string[] } {
  const marker = join(root, '.git');
  authority.capture(marker, true);
  const entry = identity(marker);
  if (!entry || entry.isDirectory()) return { writable: [], protected: [] };
  if (!entry.isFile()) throw new Error('Git worktree marker must be a regular file');
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readFileSync(marker, 'utf8'));
  if (!match) throw new Error('Invalid Git worktree marker');
  const admin = resolve(root, match[1]);
  validatePath(admin);
  authority.capture(admin);
  for (const name of ['commondir', 'gitdir', 'HEAD']) authority.capture(join(admin, name), true);
  const common = resolve(admin, readFileSync(join(admin, 'commondir'), 'utf8').trim());
  validatePath(common);
  authority.capture(common);
  if (basename(common) !== '.git' || dirname(admin) !== join(common, 'worktrees'))
    throw new Error('Unsupported Git worktree metadata layout');
  const backlink = readFileSync(join(admin, 'gitdir'), 'utf8').trim();
  if (backlink !== marker || realpathSync(backlink) !== marker)
    throw new Error('Git worktree registration does not match authorized workspace');
  // Only the current branch's ref and reflog are writable outside the worktree.
  const head = readFileSync(join(admin, 'HEAD'), 'utf8').trim();
  const branch = /^ref: (refs\/heads\/[^\s]+)$/.exec(head)?.[1];
  if (!branch) throw new Error('Sandboxed Git worktree commands require a symbolic branch HEAD');
  const paths = [admin];
  if (branch) {
    const ref = resolve(common, branch);
    if (!contains(join(common, 'refs', 'heads'), ref)) throw new Error('Invalid Git branch path');
    const log = join(common, 'logs', branch);
    paths.push(ref, ref + '.lock', log, log + '.lock');
  }
  [...paths, join(common, 'objects')].forEach(validatePath);
  return {
    writable: paths,
    // These files define the scope granted on the NEXT command. Never let this
    // command rewrite its own authority (including by atomic lock-and-rename).
    protected: [
      // The object store belongs to every linked worktree. Writable access would
      // allow arbitrary shell commands to delete or corrupt other branches.
      // Git add/commit need a separate trusted append-only object service.
      join(common, 'objects'),
      marker,
      join(admin, 'HEAD'),
      ...['commondir', 'gitdir'].flatMap((name) => [
        join(admin, name),
        join(admin, name + '.lock'),
      ]),
    ],
  };
}

/** One SRT process owns one immutable policy; no singleton policy is shared between chats.
 * Native execution stays disabled in the model runtime. This host tool never falls back
 * to unsandboxed execution when SRT, kernel support, or its dependencies are unavailable.
 */
export async function executeSandboxedCommand(
  options: SandboxedCommandOptions,
): Promise<{ content: string; isError: boolean }> {
  options.signal.throwIfAborted();
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error('OS sandbox is unavailable on this platform');
  // Copy caller-owned collections: later mutations cannot silently change grants.
  options = {
    ...options,
    writableRoots: [...options.writableRoots],
    deniedRoots: [...options.deniedRoots],
    env: { ...options.env },
    allowedDomains: options.allowedDomains ? [...options.allowedDomains] : undefined,
  };
  const authority = new AuthoritySnapshot();
  for (const path of [options.cwd, ...options.writableRoots, ...options.deniedRoots]) {
    validatePath(path);
    authority.capture(path);
  }
  const metadata = options.writableRoots.map((root) => gitMetadataRoots(root, authority));
  const metadataRoots = metadata.flatMap((entry) => entry.writable);
  const protectedMetadata = metadata.flatMap((entry) => entry.protected);
  for (const path of [...metadataRoots, ...protectedMetadata]) authority.capture(path);
  if (!options.writableRoots.some((root) => contains(root, options.cwd)))
    throw new Error('Command cwd is outside authorized workspaces');
  if (options.deniedRoots.some((root) => contains(root, options.cwd)))
    throw new Error('Command cwd is private');
  if (!options.command.trim()) throw new Error('Command is required');
  const timeout = options.timeoutMs ?? 60_000;
  const limit = options.maxOutputBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || !Number.isSafeInteger(limit) || limit <= 0)
    throw new Error('Invalid command limits');
  // SRT treats missing Linux seccomp as a warning. For a credential-isolating
  // host executor that degradation is unacceptable: Unix sockets must stay fenced.
  const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
  const dependencies = SandboxManager.checkDependencies();
  if (dependencies.errors.length || dependencies.warnings.length)
    throw new Error('Complete OS sandbox dependencies are unavailable');
  const require = createRequire(import.meta.url);
  const sourceRuntime = import.meta.url.endsWith('.ts');
  const worker = fileURLToPath(
    new URL(
      sourceRuntime ? './sandboxed-command-worker.ts' : './sandboxed-command-worker.js',
      import.meta.url,
    ),
  );
  const workerArgs = sourceRuntime ? ['--import', require.resolve('tsx/esm'), worker] : [worker];
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-shell-')));
  try {
    const home = join(temporary, 'home');
    const scratch = join(temporary, 'tmp');
    await Promise.all([mkdir(home), mkdir(scratch)]);
    const settings = join(temporary, 'policy.json');
    const payload: SandboxWorkerPayload = {
      cwd: options.cwd,
      command: options.command,
      authority: authority.serialize(),
      config: {
        filesystem: {
          denyRead: options.deniedRoots,
          allowRead: [],
          allowWrite: [...options.writableRoots, ...metadataRoots, home, scratch],
          // Override SRT's shared default scratch grants; each call has its own scratch.
          denyWrite: [
            ...options.deniedRoots,
            ...protectedMetadata,
            '/tmp/claude',
            '/private/tmp/claude',
          ],
        },
        network: {
          allowedDomains: options.allowedDomains ?? [],
          // Deny explicit local/metadata destinations even if a caller later
          // weakens hostname validation. Redirect targets remain subject to
          // this deny-first list and the exact allowlist in SRT's proxy.
          deniedDomains: [
            'localhost',
            '127.0.0.1',
            '[::1]',
            '169.254.169.254',
            'metadata.google.internal',
          ],
          allowLocalBinding: false,
          allowAllUnixSockets: false,
        },
        enableWeakerNestedSandbox: false,
        enableWeakerNetworkIsolation: false,
        allowAppleEvents: false,
      },
    };
    await writeFile(settings, JSON.stringify(payload), { mode: 0o600 });
    const env: Record<string, string> = { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' };
    for (const [name, value] of Object.entries(options.env)) {
      if (['PATH', 'LANG', 'LC_ALL'].includes(name) || /^MITZO_REPO_[A-Z0-9_]+$/.test(name))
        env[name] = value;
    }
    Object.assign(env, { HOME: home, TMPDIR: scratch, CLAUDE_CODE_TMPDIR: scratch });
    options.signal.throwIfAborted();
    return await new Promise((resolveResult) => {
      options.signal.throwIfAborted();
      options.beforeSpawn?.();
      // No await between revalidating authority and handing policy to the child.
      authority.verify();
      const child = spawn(process.execPath, [...workerArgs, settings], {
        cwd: options.cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let failure: string | undefined;
      let size = 0;
      const chunks: Buffer[] = [];
      const kill = () => {
        if (child.pid)
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* Already exited. */
          }
      };
      const stop = (reason: string) => {
        failure ??= reason;
        kill();
      };
      const onAbort = () => stop('Command cancelled');
      const timer = setTimeout(() => stop('Command timed out'), timeout);
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) onAbort();
      const collect = (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) stop('Command output limit exceeded');
        else chunks.push(chunk);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', () => {
        failure = 'Sandbox process could not start';
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', onAbort);
        // Also terminate background children that outlived a successful foreground command.
        kill();
        let output = Buffer.concat(chunks).toString('utf8');
        const isError = !!failure || code !== 0 || signal !== null;
        if (
          isError &&
          metadataRoots.length > 0 &&
          /unable to create temporary file|insufficient permission for adding an object|failed to insert into database|failed to write commit object|unable to write.*object/i.test(
            output,
          )
        ) {
          output +=
            '\nShared Git objects are read-only in this sandbox. Git add/commit that create objects require a trusted Git operation outside this command sandbox. File edits and tests remain available.\n';
        }
        resolveResult({
          content: failure ? `${failure}\n${output}` : output,
          isError,
        });
      });
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

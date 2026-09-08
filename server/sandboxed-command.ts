import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

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

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), path.slice(parent.length));
  }
}
async function validatePath(path: string): Promise<void> {
  // SRT interprets globs. Policy roots must be literal, canonical absolute paths.
  if (
    !isAbsolute(path) ||
    path === '/' ||
    /[*?[\]{}]/.test(path) ||
    resolve(path) !== path ||
    (await canonical(path)) !== path
  )
    throw new Error('Sandbox roots must be canonical absolute paths without patterns');
}
function contains(root: string, path: string) {
  return path === root || path.startsWith(root + '/');
}

/** Verify both halves of Git's linked-worktree registration before granting its
 * metadata. A forged .git file alone must never grant an arbitrary host directory.
 * Standard repositories already hold their metadata inside the authorized root.
 */
async function gitMetadataRoots(
  root: string,
): Promise<{ writable: string[]; protected: string[] }> {
  const marker = join(root, '.git');
  const entry = await lstat(marker).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry || entry.isDirectory()) return { writable: [], protected: [] };
  if (!entry.isFile()) throw new Error('Git worktree marker must be a regular file');
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(await readFile(marker, 'utf8'));
  if (!match) throw new Error('Invalid Git worktree marker');
  const admin = resolve(root, match[1]);
  await validatePath(admin);
  const common = resolve(admin, (await readFile(join(admin, 'commondir'), 'utf8')).trim());
  await validatePath(common);
  if (basename(common) !== '.git' || dirname(admin) !== join(common, 'worktrees'))
    throw new Error('Unsupported Git worktree metadata layout');
  const backlink = (await readFile(join(admin, 'gitdir'), 'utf8')).trim();
  if (backlink !== marker || (await realpath(backlink)) !== marker)
    throw new Error('Git worktree registration does not match authorized workspace');
  // Only the current branch's ref and reflog are writable outside the worktree.
  const head = (await readFile(join(admin, 'HEAD'), 'utf8')).trim();
  const branch = /^ref: (refs\/heads\/[^\s]+)$/.exec(head)?.[1];
  if (!branch) throw new Error('Sandboxed Git worktree commands require a symbolic branch HEAD');
  const paths = [join(common, 'objects'), admin];
  if (branch) {
    const ref = resolve(common, branch);
    if (!contains(join(common, 'refs', 'heads'), ref)) throw new Error('Invalid Git branch path');
    const log = join(common, 'logs', branch);
    paths.push(ref, ref + '.lock', log, log + '.lock');
  }
  await Promise.all(paths.map(validatePath));
  return {
    writable: paths,
    // These files define the scope granted on the NEXT command. Never let this
    // command rewrite its own authority (including by atomic lock-and-rename).
    protected: [
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
  await Promise.all(
    [options.cwd, ...options.writableRoots, ...options.deniedRoots].map(validatePath),
  );
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
  const metadata = await Promise.all(options.writableRoots.map(gitMetadataRoots));
  const metadataRoots = metadata.flatMap((entry) => entry.writable);
  const protectedMetadata = metadata.flatMap((entry) => entry.protected);
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve('@anthropic-ai/sandbox-runtime')), 'cli.js');
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-shell-')));
  try {
    const home = join(temporary, 'home');
    const scratch = join(temporary, 'tmp');
    await Promise.all([mkdir(home), mkdir(scratch)]);
    const settings = join(temporary, 'policy.json');
    await writeFile(
      settings,
      JSON.stringify({
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
          deniedDomains: [],
          allowLocalBinding: false,
          allowAllUnixSockets: false,
        },
        enableWeakerNestedSandbox: false,
        enableWeakerNetworkIsolation: false,
        allowAppleEvents: false,
      }),
      { mode: 0o600 },
    );
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
      const child = spawn(process.execPath, [cli, '--settings', settings, '-c', options.command], {
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
        const output = Buffer.concat(chunks).toString('utf8');
        resolveResult({
          content: failure ? `${failure}\n${output}` : output,
          isError: !!failure || code !== 0 || signal !== null,
        });
      });
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

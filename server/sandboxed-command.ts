import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AuthoritySnapshot, identity, validatePath } from './sandbox-authority.js';
import type { SandboxWorkerPayload } from './sandboxed-command-worker.js';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  freezeNativeReadExclusions,
  privateNativeFileHelperCommand,
  projectPrivateNativeFileHelperRequest,
  type NativeReadAnchor,
} from './native-file-operation.js';

export interface SandboxedCommandOptions {
  command: string;
  cwd: string;
  writableRoots: string[];
  deniedRoots: string[];
  /** Optional deny-by-default read scope for development runners. Host-owned paths only. */
  readableRoots?: string[];
  env: Record<string, string>;
  /** General proxy egress, only after the caller's network-aware command approval. */
  networkAccess?: 'approved-command';
  signal: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Private structured-helper transport; does not change policy or output limits. */
  privateOutput?: 'separate';
  beforeSpawn?: () => void;
  beforeSpawnAsync?: () => Promise<void>;
}

/** Private actor facts only, not a permission grant. Actual callers derive the
 * exact roots from consumed scope plus phase-owned/original pinned identities. */
export interface PrivateNativeFileHelperOptions {
  readonly requestJson: string;
  readonly cwd: string;
  readonly writableRoots: readonly Readonly<{ path: string; parentAnchor: NativeReadAnchor }>[];
  readonly deniedRoots: readonly string[];
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  assertCurrentSync(): void;
  revalidate(): Promise<void>;
}
interface PrivateHelperScope {
  readonly requestJson: string;
  readonly deadline: number;
  readonly cwdIdentity: Readonly<{ dev: string; ino: string }>;
}
const privateLiteral = (path: unknown): path is string =>
  typeof path === 'string' &&
  isAbsolute(path) &&
  path !== '/' &&
  resolve(path) === path &&
  !path.includes('\0') &&
  !/[*?[\]{}]/.test(path) &&
  Buffer.byteLength(path) <= 4096 &&
  path.split('/').length <= 129;
function privateData(value: unknown, key: string): unknown {
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error('Private helper scope unavailable');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor)) throw Error('Private helper scope unavailable');
  return descriptor.value;
}
function privateArray(value: unknown, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max
  )
    throw Error('Private helper scope unavailable');
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) throw Error('Private helper scope unavailable');
    items.push(descriptor.value);
  }
  return items;
}

/** SAME runner, fixed private file program only. This is deliberately not a
 * public Bash option to skip Git/authority checks. No source/Git path is passed
 * to host AuthoritySnapshot or gitMetadataRoots. SRT itself normalizes literal
 * roots: the caller must already hold original/phase custody of those roots and
 * each nearest existing parent, under the current original owner. */
export async function executePrivateNativeFileHelper(options: PrivateNativeFileHelperOptions) {
  const original = options;
  const sync = privateData(options, 'assertCurrentSync');
  const async = privateData(options, 'revalidate');
  const signal = privateData(options, 'signal') as AbortSignal;
  const timeoutMs = privateData(options, 'timeoutMs');
  if (
    typeof sync !== 'function' ||
    typeof async !== 'function' ||
    typeof timeoutMs !== 'number' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 30000
  )
    throw Error('Private helper owner unavailable');
  const deadline = Date.now() + timeoutMs;
  const current = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw Error('Private helper owner unavailable');
    const returned: unknown = Reflect.apply(sync, original, []);
    if (returned !== undefined) {
      void Promise.resolve(returned).catch(() => {});
      throw Error('Private helper owner unavailable');
    }
  };
  const revalidate = async () => {
    current();
    const pending: unknown = Reflect.apply(async, original, []);
    if (!(pending instanceof Promise)) throw Error('Private helper owner unavailable');
    if ((await pending) !== undefined) throw Error('Private helper owner unavailable');
    current();
  };
  // Capture immutable plain data before awaiting either owner. No source path
  // lookup/normalization happens in this validation phase.
  const suppliedRequestJson = privateData(options, 'requestJson');
  if (typeof suppliedRequestJson !== 'string') throw Error('Private helper input unavailable');
  const requestJson = projectPrivateNativeFileHelperRequest(suppliedRequestJson);
  const command = privateNativeFileHelperCommand(requestJson);
  const request = JSON.parse(requestJson);
  const cwd = privateData(options, 'cwd');
  const inputRoots = privateArray(privateData(options, 'writableRoots'), 2);
  const maxOutputBytes = privateData(options, 'maxOutputBytes');
  const deniedRoots = freezeNativeReadExclusions(
    privateArray(privateData(options, 'deniedRoots'), 256) as string[],
  );
  if (
    !privateLiteral(cwd) ||
    !Array.isArray(inputRoots) ||
    inputRoots.length !== 2 ||
    typeof maxOutputBytes !== 'number' ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 32768
  )
    throw Error('Private helper scope unavailable');
  const roots = Object.freeze(
    inputRoots.map((value) => {
      const path = privateData(value, 'path');
      const parent = privateData(value, 'parentAnchor');
      const parentPath = privateData(parent, 'rootPath');
      const id = privateData(parent, 'identity');
      const dev = privateData(id, 'dev'),
        ino = privateData(id, 'ino');
      if (
        !privateLiteral(path) ||
        !privateLiteral(parentPath) ||
        (path !== parentPath && dirname(path) !== parentPath) ||
        typeof dev !== 'string' ||
        !/^\d{1,32}$/.test(dev) ||
        typeof ino !== 'string' ||
        !/^\d{1,32}$/.test(ino)
      )
        throw Error('Private helper parent custody unavailable');
      return Object.freeze({
        path,
        parentAnchor: Object.freeze({
          rootPath: parentPath,
          identity: Object.freeze({ dev, ino }),
        }),
      });
    }),
  );
  if (
    new Set(roots.map((root) => root.path)).size !== roots.length ||
    !roots.some((root) => root.path === cwd && root.parentAnchor.rootPath === cwd) ||
    !roots.some(
      (root) =>
        root.path === request.file_path &&
        root.parentAnchor.rootPath === dirname(request.file_path) &&
        root.parentAnchor.identity.dev === request.parentIdentity.dev &&
        root.parentAnchor.identity.ino === request.parentIdentity.ino,
    ) ||
    JSON.stringify(deniedRoots) !==
      JSON.stringify(freezeNativeReadExclusions(request.deniedRoots)) ||
    roots.some((root) =>
      deniedRoots.some(
        (denied) =>
          root.path === denied || root.path.startsWith(denied === '/' ? '/' : denied + '/'),
      ),
    ) ||
    (request.operation === 'CreateFile' &&
      (request.payload.rootAnchor.rootPath !== cwd ||
        !roots.some(
          (root) =>
            root.path === cwd &&
            root.parentAnchor.identity.dev === request.payload.rootAnchor.identity.dev &&
            root.parentAnchor.identity.ino === request.payload.rootAnchor.identity.ino,
        )))
  )
    throw Error('Private helper scope unavailable');
  await revalidate(); // Full actual owner BEFORE any scope-touching host setup.
  let failed = false;
  let result: Awaited<ReturnType<typeof runSandboxedCommand>> | undefined;
  try {
    result = await runSandboxedCommand(
      {
        command,
        cwd,
        writableRoots: roots.map((root) => root.path),
        deniedRoots: [...deniedRoots],
        env: { PATH: '/usr/bin:/bin' },
        signal,
        privateOutput: 'separate',
        timeoutMs: Math.max(1, deadline - Date.now()),
        maxOutputBytes,
        beforeSpawnAsync: revalidate,
        beforeSpawn: current,
      },
      {
        requestJson,
        deadline,
        cwdIdentity: roots.find((root) => root.path === cwd)!.parentAnchor.identity,
      },
    );
  } catch {
    // Joining/cleanup can fail after a real effect. Never retry or erase it.
    failed = true;
  }
  try {
    await revalidate(); // ALSO after rejected joined-worker/cleanup awaits.
    current();
  } catch {
    throw Error('Private native file helper unavailable');
  }
  if (failed || !result) throw Error('Private native file helper unavailable');
  return result;
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
  if (!entry) return { writable: [], protected: [] };
  if (entry.isDirectory()) {
    if (realpathSync(marker) !== marker)
      throw new Error('Git metadata must be a real directory inside the workspace');
    return { writable: [], protected: [marker] };
  }
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
): Promise<{ content: string; isError: boolean; stdout?: string; stderr?: string }> {
  return runSandboxedCommand(options);
}

async function runSandboxedCommand(
  options: SandboxedCommandOptions,
  privateHelper?: PrivateHelperScope,
): Promise<{ content: string; isError: boolean; stdout?: string; stderr?: string }> {
  options.signal.throwIfAborted();
  if (options.privateOutput !== undefined && options.privateOutput !== 'separate')
    throw new Error('Invalid private command output transport');
  if (options.networkAccess !== undefined && options.networkAccess !== 'approved-command')
    throw new Error('Invalid command network authorization');
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error('OS sandbox is unavailable on this platform');
  // Copy caller-owned collections: later mutations cannot silently change grants.
  options = {
    ...options,
    writableRoots: [...options.writableRoots],
    deniedRoots: [...options.deniedRoots],
    ...(options.readableRoots ? { readableRoots: [...options.readableRoots] } : {}),
    env: { ...options.env },
  };
  const authority = new AuthoritySnapshot();
  for (const path of privateHelper
    ? [options.cwd, process.execPath]
    : [
        options.cwd,
        ...options.writableRoots,
        ...options.deniedRoots,
        ...(options.readableRoots ?? []),
      ]) {
    validatePath(path);
    authority.capture(path);
  }
  if (privateHelper) {
    const current = identity(options.cwd);
    if (
      !current?.isDirectory() ||
      current.dev.toString() !== privateHelper.cwdIdentity.dev ||
      current.ino.toString() !== privateHelper.cwdIdentity.ino
    )
      throw Error('Private helper scratch custody changed');
  }
  if (
    options.readableRoots &&
    [...options.readableRoots, ...options.writableRoots].some((readable) =>
      options.deniedRoots.some(
        (denied) => contains(readable, denied) || contains(denied, readable),
      ),
    )
  )
    throw Error('Sandbox readable scope overlaps private storage');
  const metadata = privateHelper
    ? []
    : options.writableRoots.map((root) => gitMetadataRoots(root, authority));
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
      ...(privateHelper ? { privateNativeFileRequestJson: privateHelper.requestJson } : {}),
      ...(options.networkAccess ? { networkAccess: options.networkAccess } : {}),
      authority: authority.serialize(),
      config: {
        filesystem: {
          denyRead: options.readableRoots ? ['/', ...options.deniedRoots] : options.deniedRoots,
          allowRead: options.readableRoots ? [...options.readableRoots, home, scratch] : [],
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
          allowedDomains: [],
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
          allowLocalBinding: options.networkAccess === 'approved-command',
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
    await options.beforeSpawnAsync?.();
    return await new Promise((resolveResult) => {
      options.signal.throwIfAborted();
      if (!privateHelper) options.beforeSpawn?.();
      // No await between revalidating authority and handing policy to the child.
      authority.verify();
      if (privateHelper) options.beforeSpawn?.();
      const child = spawn(process.execPath, [...workerArgs, settings], {
        cwd: options.cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let failure: string | undefined;
      let size = 0;
      const chunks: Buffer[] = [];
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
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
      const timer = setTimeout(
        () => stop('Command timed out'),
        privateHelper ? Math.max(1, privateHelper.deadline - Date.now()) : timeout,
      );
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) onAbort();
      const collect = (chunk: Buffer, stream: Buffer[]) => {
        size += chunk.length;
        if (size > limit) stop('Command output limit exceeded');
        else if (options.privateOutput) stream.push(chunk);
        else chunks.push(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => collect(chunk, stdout));
      child.stderr.on('data', (chunk: Buffer) => collect(chunk, stderr));
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
        if (options.privateOutput) {
          resolveResult({
            content: failure ?? '',
            isError,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          });
          return;
        }
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

import {
  validateRepositoryTaskCheckout,
  type RepositoryTaskCheckout,
} from './repository-task-checkout.js';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import {
  constants,
  lstatSync,
  realpathSync,
  unlinkSync,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
} from 'node:fs';
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

const pathEnv = '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin';

async function run(
  file: string,
  args: readonly string[],
  options: {
    cwd?: string;
    signal: AbortSignal;
    timeoutMs: number;
    maxOutputBytes: number;
    env?: Record<string, string>;
    input?: Buffer;
    assertRuntimeCurrent?: () => void;
    assertRuntimeCurrentAsync?: () => Promise<void>;
    onStart?: () => void;
  },
): Promise<string> {
  await options.assertRuntimeCurrentAsync?.();
  options.signal.throwIfAborted();
  return new Promise((resolveRun, reject) => {
    options.assertRuntimeCurrent?.();
    options.onStart?.();
    const child = execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        env: { PATH: pathEnv, ...options.env },
        signal: options.signal,
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error((stderr || stdout || error.message).trim()));
        else resolveRun(stdout.trim());
      },
    );
    if (options.input) child.stdin?.end(options.input);
  });
}

export async function executeTrustedGitHubRead(
  endpoint: string,
  signal: AbortSignal,
  timeoutMs = 30_000,
  maxOutputBytes = 64 * 1024,
): Promise<string> {
  const home = process.env.HOME;
  if (!home) throw new Error('Trusted GitHub credentials are unavailable');
  const request = trustedGitHubReadRequest(endpoint);
  return run(request.file, request.args, {
    signal,
    timeoutMs,
    maxOutputBytes,
    env: { HOME: home, GH_HOST: 'github.com' },
  });
}

export function isTrustedGitHubEndpoint(endpoint: string) {
  const queryIndex = endpoint.indexOf('?');
  const path = queryIndex === -1 ? endpoint : endpoint.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : endpoint.slice(queryIndex + 1);
  try {
    return (
      decodeURIComponent(path) === path &&
      !path.includes('..') &&
      !path.includes('//') &&
      (/^\/user$/.test(path) ||
        /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./+-]*)?$/.test(path)) &&
      /^[A-Za-z0-9_.~=&%+-]*$/.test(query)
    );
  } catch {
    return false;
  }
}

export function trustedGitHubReadRequest(endpoint: string) {
  if (!isTrustedGitHubEndpoint(endpoint)) throw new Error('Invalid trusted GitHub endpoint');
  return {
    file: 'gh',
    args: ['api', '--hostname', 'github.com', '--method', 'GET', endpoint],
  } as const;
}

type Identity = { dev: bigint; ino: bigint };
export type ApprovedGitFileIdentity = { dev: number; ino: number; sha256: string } | null;
const identity = async (path: string): Promise<Identity> => {
  const stat = await lstat(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
};
const sameIdentity = async (path: string, expected: Identity) => {
  const actual = await identity(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino)
    throw new Error('Git metadata changed during the approved operation');
};

async function promoteQuarantinedObjects(
  quarantine: string,
  objectStore: string,
  assertCurrent: () => Promise<void>,
  assertPhysical: () => void,
) {
  for (const fanout of await readdir(quarantine, { withFileTypes: true })) {
    if (!/^[0-9a-f]{2}$/.test(fanout.name) || !fanout.isDirectory())
      throw new Error('Unexpected entry in quarantined Git object store');
    const sourceDirectory = join(quarantine, fanout.name);
    const targetDirectory = join(objectStore, fanout.name);
    await assertCurrent();
    assertPhysical();
    await mkdir(targetDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const directoryIdentity = await lstat(targetDirectory, { bigint: true });
    const assertDirectory = () => {
      assertPhysical();
      const current = lstatSync(targetDirectory, { bigint: true });
      if (
        !current.isDirectory() ||
        current.dev !== directoryIdentity.dev ||
        current.ino !== directoryIdentity.ino ||
        realpathSync(targetDirectory) !== targetDirectory
      )
        throw Error(
          'Git object fanout must be a real directory inside the object store; authority changed',
        );
    };
    assertDirectory();
    for (const object of await readdir(sourceDirectory, { withFileTypes: true })) {
      if (!/^(?:[0-9a-f]{38}|[0-9a-f]{62})$/.test(object.name) || !object.isFile())
        throw new Error('Unexpected quarantined Git object');
      const content = await readFile(join(sourceDirectory, object.name));
      const target = join(targetDirectory, object.name);
      const verifyExisting = async () => {
        const existing = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!(await existing.stat()).isFile())
            throw Error('Existing Git object must be a real file');
          const bytes = await existing.readFile();
          if (!bytes.equals(content)) {
            const expected = inflateSync(content);
            if (!inflateSync(bytes, { maxOutputLength: expected.length }).equals(expected))
              throw Error('Existing Git object content does not match the approved object');
          }
        } finally {
          await existing.close();
        }
      };
      if (
        await lstat(target).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return false;
          },
        )
      ) {
        await verifyExisting();
        continue;
      }
      // Only a fully written immutable inode is published under an object hash.
      const temporaryPath = join(targetDirectory, `.mitzo-object-${randomUUID()}`);
      await assertCurrent();
      assertDirectory();
      const temporary = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const temporaryIdentity = await temporary.stat({ bigint: true });
      let operationFailed = false,
        operationError: unknown,
        cleanupError: unknown;
      try {
        await assertCurrent();
        await temporary.writeFile(content);
        await temporary.sync();
        await temporary.chmod(0o444);
        await assertCurrent();
        assertDirectory();
        const currentTemporary = lstatSync(temporaryPath, { bigint: true });
        if (
          !currentTemporary.isFile() ||
          currentTemporary.dev !== temporaryIdentity.dev ||
          currentTemporary.ino !== temporaryIdentity.ino ||
          currentTemporary.size !== BigInt(content.length)
        )
          throw Error('Prepared Git object authority changed');
        await link(temporaryPath, target).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
          await verifyExisting();
        });
      } catch (error) {
        operationFailed = true;
        operationError = error;
      } finally {
        await temporary.close().catch((error: unknown) => {
          cleanupError = error;
        });
        // Never remove a foreign/replaced temporary or a published object hash.
        try {
          assertDirectory();
          const current = lstatSync(temporaryPath, { bigint: true });
          if (current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino)
            unlinkSync(temporaryPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupError = error;
        }
      }
      if (operationFailed && cleanupError)
        throw new AggregateError(
          [operationError, cleanupError],
          'Git object publication failed; owned temporary cleanup is unconfirmed',
        );
      if (operationFailed) throw operationError;
      if (cleanupError)
        throw Error('Owned Git object temporary cleanup is unconfirmed', { cause: cleanupError });
    }
  }
}

async function requireRealDirectoryChain(root: string, directory: string) {
  const suffix = relative(root, directory);
  if (!suffix || suffix.startsWith('..') || resolve(root, suffix) !== directory)
    throw new Error('Git metadata path is outside the common Git directory');
  let current = root;
  for (const component of suffix.split('/')) {
    current = join(current, component);
    const info = await lstat(current);
    if (!info.isDirectory() || (await realpath(current)) !== current)
      throw new Error('Git ref and reflog paths must be real metadata entries');
  }
}

async function requireRealFileIfPresent(path: string) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (info && (!info.isFile() || (await realpath(path)) !== path))
    throw new Error('Git ref and reflog paths must be real metadata entries');
}

async function validateRefUpdatePaths(common: string, branch: string) {
  const ref = join(common, branch);
  const reflog = join(common, 'logs', branch);
  await Promise.all([
    requireRealDirectoryChain(common, dirname(ref)),
    requireRealDirectoryChain(common, dirname(reflog)),
    requireRealFileIfPresent(ref),
    requireRealFileIfPresent(reflog),
  ]);
}

async function linkedMetadata(cwd: string, task?: RepositoryTaskCheckout) {
  const marker = join(cwd, '.git');
  const markerInfo = await lstat(marker, { bigint: true });
  let admin: string, common: string;
  // Retained tasks can be standalone checkouts or registered local worktrees.
  // Validate their captured shape and identities before resolving write paths.
  if (task || markerInfo.isDirectory()) {
    await validateRepositoryTaskCheckout(cwd, task);
    if (markerInfo.dev !== BigInt(task!.git.dev) || markerInfo.ino !== BigInt(task!.git.ino))
      throw new Error('Retained repository task metadata changed');
  }
  if (markerInfo.isDirectory()) {
    if ((await realpath(marker)) !== marker)
      throw new Error('Standalone Git metadata must remain inside the workspace');
    admin = common = marker;
    // Standalone checkouts own their storage, but must not turn a commit into
    // access to an external Git directory, object database or filesystem alias.
    for (const name of [
      'commondir',
      'gitdir',
      'objects/info/alternates',
      'objects/info/http-alternates',
    ]) {
      const present = await lstat(join(marker, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (present) throw new Error('External standalone Git storage is unavailable');
    }
    let count = 0;
    const pending = [marker];
    while (pending.length) {
      const directory = pending.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++count > 100000 || entry.isSymbolicLink())
          throw new Error('Standalone Git metadata aliases are unavailable');
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (!entry.isFile() || (await lstat(path)).nlink !== 1)
          throw new Error('Standalone Git metadata aliases are unavailable');
      }
    }
  } else {
    if (!markerInfo.isFile())
      throw new Error('Trusted commits require a regular Git repository marker');
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(await readFile(marker, 'utf8'));
    if (!match) throw new Error('Invalid linked-worktree marker');
    admin = await realpath(resolve(cwd, match[1]));
    common = await realpath(
      resolve(admin, (await readFile(join(admin, 'commondir'), 'utf8')).trim()),
    );
    if (basename(common) !== '.git' || dirname(admin) !== join(common, 'worktrees'))
      throw new Error('Unsupported linked-worktree metadata layout');
    const backlink = (await readFile(join(admin, 'gitdir'), 'utf8')).trim();
    if (backlink !== marker || (await realpath(backlink)) !== marker)
      throw new Error('Git worktree registration does not match the approved workspace');
    if (task) {
      const adminInfo = await lstat(admin, { bigint: true });
      const commonInfo = await lstat(common, { bigint: true });
      if (
        !task.localSource ||
        !task.linkedGit ||
        admin !== task.linkedGit.directory ||
        common !== task.localSource.commonDirectory ||
        adminInfo.dev !== BigInt(task.linkedGit.identity.dev) ||
        adminInfo.ino !== BigInt(task.linkedGit.identity.ino) ||
        commonInfo.dev !== BigInt(task.localSource.commonRoot.dev) ||
        commonInfo.ino !== BigInt(task.localSource.commonRoot.ino)
      )
        throw new Error('Retained repository task metadata changed');
    }
  }
  const objects = join(common, 'objects');
  const objectsInfo = await lstat(objects, { bigint: true });
  if (!objectsInfo.isDirectory() || (await realpath(objects)) !== objects)
    throw new Error('Git object store must be a real directory inside the common Git directory');
  const head = (await readFile(join(admin, 'HEAD'), 'utf8')).trim();
  const branch = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
  if (!branch || branch.includes('..') || branch.includes('//'))
    throw new Error('Trusted commits require a valid symbolic branch');
  if (task && branch !== `refs/heads/${task.featureBranch}`)
    throw new Error('Repository task branch changed');
  await validateRefUpdatePaths(common, branch);
  return {
    marker,
    admin,
    common,
    branch,
    index: join(admin, 'index'),
    identities: {
      marker: { dev: markerInfo.dev, ino: markerInfo.ino },
      admin: await identity(admin),
      common: await identity(common),
      objects: { dev: objectsInfo.dev, ino: objectsInfo.ino },
    },
  };
}

function validateCommitFiles(files: string[]) {
  for (const file of files) {
    const name = basename(file).toLowerCase();
    if (
      name === '.env' ||
      name.startsWith('.env.') ||
      name === '.envrc' ||
      name.startsWith('.envrc.') ||
      name === 'auth.json' ||
      name === 'credentials.json' ||
      name === '.npmrc' ||
      name === '.pypirc' ||
      name === '.netrc' ||
      name === 'id_rsa' ||
      name === 'id_ed25519' ||
      name.endsWith('.token') ||
      name.endsWith('.pem') ||
      name.endsWith('.key')
    )
      throw new Error('Credential-like files cannot be committed by this operation');
  }
}

export async function executeTrustedGitCommit(
  cwd: string,
  files: string[],
  message: string,
  signal: AbortSignal,
  timeoutMs = 30_000,
  maxOutputBytes = 64 * 1024,
  approvedIdentities?: ReadonlyMap<string, ApprovedGitFileIdentity>,
  task?: RepositoryTaskCheckout,
  assertRuntimeCurrent?: () => void,
  assertRuntimeCurrentAsync?: () => Promise<void>,
): Promise<string> {
  const assertCurrent = async () => {
    signal.throwIfAborted();
    await assertRuntimeCurrentAsync?.();
    signal.throwIfAborted();
    assertRuntimeCurrent?.();
  };
  cwd = await realpath(cwd);
  validateCommitFiles(files);
  const metadata = await linkedMetadata(cwd, task);
  const headPath = join(metadata.admin, 'HEAD');
  const headDescriptor = openSync(headPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const headIdentity = fstatSync(headDescriptor, { bigint: true });
  try {
    if (
      !headIdentity.isFile() ||
      readFileSync(headDescriptor, 'utf8').trim() !== `ref: ${metadata.branch}`
    )
      throw Error('Original Git checkout branch authority changed');
  } finally {
    closeSync(headDescriptor);
  }
  const assertPhysical = () => {
    for (const [path, expected] of [
      [metadata.marker, metadata.identities.marker],
      [metadata.admin, metadata.identities.admin],
      [metadata.common, metadata.identities.common],
      [join(metadata.common, 'objects'), metadata.identities.objects],
    ] as const) {
      const current = lstatSync(path, { bigint: true });
      if (
        current.dev !== expected.dev ||
        current.ino !== expected.ino ||
        realpathSync(path) !== path
      )
        throw Error('Git metadata changed during the approved operation');
    }
    const descriptor = openSync(headPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = fstatSync(descriptor, { bigint: true });
      if (
        !current.isFile() ||
        current.dev !== headIdentity.dev ||
        current.ino !== headIdentity.ino ||
        realpathSync(headPath) !== headPath ||
        readFileSync(descriptor, 'utf8').trim() !== `ref: ${metadata.branch}`
      )
        throw Error('Original Git checkout branch authority changed');
    } finally {
      closeSync(descriptor);
    }
  };
  await assertCurrent();
  assertPhysical();
  const indexLock = metadata.index + '.lock';
  const lock = await open(indexLock, 'wx', 0o600).catch(() => {
    throw new Error('Git index is busy; retry after the other operation finishes');
  });
  const lockIdentity = await lock.stat({ bigint: true });
  let ownsIndexLock = true;
  let retainIndexLock = false;
  const temporary = await mkdtemp(join(tmpdir(), 'mitzo-trusted-git-'));
  try {
    const gitDir = join(temporary, 'git');
    const hooks = join(temporary, 'hooks');
    const index = join(temporary, 'index');
    const originalIndex = join(temporary, 'original-index');
    const quarantineObjects = join(temporary, 'objects');
    await Promise.all([mkdir(gitDir), mkdir(hooks)]);
    await Promise.all([
      mkdir(join(gitDir, 'objects')),
      mkdir(join(gitDir, 'refs')),
      mkdir(quarantineObjects),
    ]);
    const symbolicHead = (await readFile(join(metadata.admin, 'HEAD'), 'utf8')).trim();
    if (symbolicHead !== `ref: ${metadata.branch}`)
      throw new Error('Git branch changed before commit');
    const baseEnv = {
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
    };
    const oldCommit = await run(
      'git',
      ['-c', `core.hooksPath=${hooks}`, '--git-dir', metadata.admin, 'rev-parse', 'HEAD'],
      {
        cwd,
        signal,
        timeoutMs,
        maxOutputBytes,
        env: baseEnv,
      },
    );
    const objectFormat = await run(
      'git',
      ['--git-dir', metadata.admin, 'rev-parse', '--show-object-format'],
      { cwd, signal, timeoutMs, maxOutputBytes, env: baseEnv },
    );
    if (!['sha1', 'sha256'].includes(objectFormat))
      throw new Error('Unsupported Git object format');
    await writeFile(join(gitDir, 'HEAD'), `${oldCommit}\n`);
    await writeFile(
      join(gitDir, 'config'),
      objectFormat === 'sha256'
        ? '[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tobjectFormat = sha256\n'
        : '[core]\n\tbare = false\n',
    );
    const isolated = {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: cwd,
      GIT_INDEX_FILE: index,
      GIT_OBJECT_DIRECTORY: quarantineObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(metadata.common, 'objects'),
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      HOME: temporary,
    };
    const opts = { cwd, signal, timeoutMs, maxOutputBytes, env: isolated, assertRuntimeCurrent };
    await run('git', ['read-tree', oldCommit], opts);
    const baselineTree = await run('git', ['write-tree'], opts);
    await writeFile(originalIndex, await readFile(metadata.index));
    const realIndexTree = await run('git', ['write-tree'], {
      ...opts,
      env: { ...isolated, GIT_INDEX_FILE: originalIndex },
    });
    if (realIndexTree !== baselineTree)
      throw new Error('Git index already contains staged changes; commit them separately');
    // Hash and index each approved regular file explicitly. This never asks Git
    // to traverse a directory and bypasses repository attributes and filters.
    for (const file of files) {
      const absolute = resolve(cwd, file);
      if (absolute === cwd || !absolute.startsWith(cwd + '/'))
        throw new Error('Git commit path is outside the approved workspace');
      let handle;
      const hasApprovedIdentity = approvedIdentities?.has(file) === true;
      const approvedIdentity = approvedIdentities?.get(file);
      try {
        handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          if (hasApprovedIdentity && approvedIdentity !== null)
            throw new Error('Git commit path changed after approval', { cause: error });
          await run('git', ['update-index', '--remove', '--', file], opts);
          continue;
        }
        throw error;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error('Git commit paths must be regular files without aliases');
        if (
          hasApprovedIdentity &&
          (approvedIdentity === null ||
            approvedIdentity?.dev !== stat.dev ||
            approvedIdentity.ino !== stat.ino)
        )
          throw new Error('Git commit path changed after approval');
        const currentPath = await realpath(absolute);
        const current = await lstat(absolute);
        if (
          currentPath !== absolute ||
          !current.isFile() ||
          current.dev !== stat.dev ||
          current.ino !== stat.ino
        )
          throw new Error('Git commit path changed after approval');
        const content = await handle.readFile();
        if (
          hasApprovedIdentity &&
          approvedIdentity !== null &&
          approvedIdentity !== undefined &&
          createHash('sha256').update(content).digest('hex') !== approvedIdentity.sha256
        )
          throw new Error('Git commit content changed after approval');
        const hash = await run('git', ['hash-object', '-w', '--stdin'], {
          ...opts,
          input: content,
        });
        const mode = stat.mode & 0o111 ? '100755' : '100644';
        await run('git', ['update-index', '--add', '--cacheinfo', `${mode},${hash},${file}`], opts);
      } finally {
        await handle.close();
      }
    }
    const tree = await run('git', ['write-tree'], opts);
    if (tree === baselineTree) throw new Error('Approved files contain no changes');
    const commit = await run('git', ['commit-tree', tree, '-p', oldCommit, '-m', message], {
      ...opts,
      env: {
        ...isolated,
        GIT_AUTHOR_NAME: 'Mitzo',
        GIT_AUTHOR_EMAIL: 'mitzo@localhost',
        GIT_COMMITTER_NAME: 'Mitzo',
        GIT_COMMITTER_EMAIL: 'mitzo@localhost',
      },
    });
    await Promise.all([
      sameIdentity(metadata.marker, metadata.identities.marker),
      sameIdentity(metadata.admin, metadata.identities.admin),
      sameIdentity(metadata.common, metadata.identities.common),
      sameIdentity(join(metadata.common, 'objects'), metadata.identities.objects),
    ]);
    await assertCurrent();
    await promoteQuarantinedObjects(
      quarantineObjects,
      join(metadata.common, 'objects'),
      assertCurrent,
      assertPhysical,
    );
    await sameIdentity(join(metadata.common, 'objects'), metadata.identities.objects);
    await validateRefUpdatePaths(metadata.common, metadata.branch);
    const promotedIndex = await readFile(index);
    await assertCurrent();
    await lock.writeFile(promotedIndex);
    await lock.sync();
    let refStarted = false;
    let refError: unknown;
    try {
      await run(
        'git',
        [
          '-c',
          `core.hooksPath=${hooks}`,
          '--git-dir',
          metadata.admin,
          'update-ref',
          metadata.branch,
          commit,
          oldCommit,
        ],
        {
          assertRuntimeCurrent,
          assertRuntimeCurrentAsync,
          onStart: () => {
            refStarted = true;
            retainIndexLock = true;
            assertPhysical();
          },
          cwd,
          signal,
          timeoutMs,
          maxOutputBytes,
          env: baseEnv,
        },
      );
    } catch (error) {
      refError = error;
    }
    if (refError) {
      if (!refStarted) throw refError;
      let observed: string | undefined;
      try {
        assertPhysical();
        await validateRefUpdatePaths(metadata.common, metadata.branch);
        observed = await run(
          'git',
          ['--git-dir', metadata.admin, 'rev-parse', '--verify', metadata.branch],
          {
            signal: new AbortController().signal,
            timeoutMs,
            maxOutputBytes,
            env: baseEnv,
            assertRuntimeCurrent: assertPhysical,
          },
        );
        assertPhysical();
      } catch {
        /* Unconfirmed ref outcome retains its original owned prepared index. */
      }
      if (observed === oldCommit) {
        retainIndexLock = false;
        throw refError;
      }
      if (observed !== commit)
        throw Error('Git ref outcome is unconfirmed; original prepared index.lock retained', {
          cause: refError,
        });
    }
    // Once the exact ref effect is confirmed, installing its already prepared
    // index is consistency finalization under original physical custody.
    try {
      await validateRefUpdatePaths(metadata.common, metadata.branch);
      const finalRef = await run(
        'git',
        ['--git-dir', metadata.admin, 'rev-parse', '--verify', metadata.branch],
        {
          signal: new AbortController().signal,
          timeoutMs,
          maxOutputBytes,
          env: baseEnv,
          assertRuntimeCurrent: assertPhysical,
        },
      );
      if (finalRef !== commit)
        throw Error(
          'Git ref changed before consistency finalization; original prepared index.lock retained',
        );
      await sameIdentity(indexLock, { dev: lockIdentity.dev, ino: lockIdentity.ino });
      if (!(await readFile(indexLock)).equals(promotedIndex))
        throw Error('Prepared Git index authority changed');
      assertPhysical();
      const currentLock = lstatSync(indexLock, { bigint: true });
      if (currentLock.dev !== lockIdentity.dev || currentLock.ino !== lockIdentity.ino)
        throw Error('Prepared Git index authority changed');
      await rename(indexLock, metadata.index);
      ownsIndexLock = false;
      retainIndexLock = false;
    } catch (error) {
      throw Error(
        'Git ref was published; prepared index consistency is unconfirmed and requires explicit recovery',
        { cause: error },
      );
    }
    if (refError)
      throw Error(
        'Git ref was published and its prepared index finalized; update-ref response was unconfirmed',
        { cause: refError },
      );
    return `[${metadata.branch} ${commit.slice(0, 7)}] ${message}`;
  } finally {
    await lock.close().catch(() => {});
    if (ownsIndexLock && !retainIndexLock) {
      const current = await lstat(indexLock, { bigint: true }).catch(() => null);
      if (current && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino)
        await rm(indexLock, { force: true }).catch(() => {});
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const pathEnv = '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin';

function run(
  file: string,
  args: readonly string[],
  options: {
    cwd?: string;
    signal: AbortSignal;
    timeoutMs: number;
    maxOutputBytes: number;
    env?: Record<string, string>;
    input?: Buffer;
  },
): Promise<string> {
  return new Promise((resolveRun, reject) => {
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

export function trustedGitHubReadRequest(endpoint: string) {
  return {
    file: 'gh',
    args: ['api', '--hostname', 'github.com', '--method', 'GET', endpoint],
  } as const;
}

type Identity = { dev: bigint; ino: bigint };
const identity = async (path: string): Promise<Identity> => {
  const stat = await lstat(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
};
const sameIdentity = async (path: string, expected: Identity) => {
  const actual = await identity(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino)
    throw new Error('Git metadata changed during the approved operation');
};

async function linkedMetadata(cwd: string) {
  const marker = join(cwd, '.git');
  const markerInfo = await lstat(marker, { bigint: true });
  if (!markerInfo.isFile()) throw new Error('Trusted commits require a linked Git worktree');
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(await readFile(marker, 'utf8'));
  if (!match) throw new Error('Invalid linked-worktree marker');
  const admin = await realpath(resolve(cwd, match[1]));
  const common = await realpath(
    resolve(admin, (await readFile(join(admin, 'commondir'), 'utf8')).trim()),
  );
  if (basename(common) !== '.git' || dirname(admin) !== join(common, 'worktrees'))
    throw new Error('Unsupported linked-worktree metadata layout');
  const objects = join(common, 'objects');
  const objectsInfo = await lstat(objects, { bigint: true });
  if (!objectsInfo.isDirectory() || (await realpath(objects)) !== objects)
    throw new Error('Git object store must be a real directory inside the common Git directory');
  const backlink = (await readFile(join(admin, 'gitdir'), 'utf8')).trim();
  if (backlink !== marker || (await realpath(backlink)) !== marker)
    throw new Error('Git worktree registration does not match the approved workspace');
  const head = (await readFile(join(admin, 'HEAD'), 'utf8')).trim();
  const branch = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
  if (!branch || branch.includes('..') || branch.includes('//'))
    throw new Error('Trusted commits require a valid symbolic branch');
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
): Promise<string> {
  cwd = await realpath(cwd);
  validateCommitFiles(files);
  const metadata = await linkedMetadata(cwd);
  const indexLock = metadata.index + '.lock';
  const lock = await open(indexLock, 'wx', 0o600).catch(() => {
    throw new Error('Git index is busy; retry after the other operation finishes');
  });
  const temporary = await mkdtemp(join(tmpdir(), 'mitzo-trusted-git-'));
  try {
    const gitDir = join(temporary, 'git');
    const hooks = join(temporary, 'hooks');
    const index = join(temporary, 'index');
    const originalIndex = join(temporary, 'original-index');
    await Promise.all([mkdir(gitDir), mkdir(hooks)]);
    await Promise.all([mkdir(join(gitDir, 'objects')), mkdir(join(gitDir, 'refs'))]);
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
    await writeFile(join(gitDir, 'HEAD'), `${oldCommit}\n`);
    await writeFile(join(gitDir, 'config'), '[core]\n\tbare = false\n');
    const isolated = {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: cwd,
      GIT_INDEX_FILE: index,
      GIT_OBJECT_DIRECTORY: join(metadata.common, 'objects'),
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      HOME: temporary,
    };
    const opts = { cwd, signal, timeoutMs, maxOutputBytes, env: isolated };
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
      try {
        handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          await run('git', ['update-index', '--remove', '--', file], opts);
          continue;
        }
        throw error;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error('Git commit paths must be regular files without aliases');
        const hash = await run('git', ['hash-object', '-w', '--stdin'], {
          ...opts,
          input: await handle.readFile(),
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
    await lock.writeFile(await readFile(index));
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
        cwd,
        signal,
        timeoutMs,
        maxOutputBytes,
        env: baseEnv,
      },
    );
    await rename(indexLock, metadata.index);
    return `[${metadata.branch} ${commit.slice(0, 7)}] ${message}`;
  } finally {
    await lock.close().catch(() => {});
    await rm(indexLock, { force: true }).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LocalRepositoryGitMetadata } from './local-repository-git-inspection.js';
import type { LocalRepositoryReadAccess } from './local-repository-read-access.js';

const execute = promisify(execFile);
const unavailable = () => Error('Preparation objects unavailable');
const environment = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
  GIT_ATTR_NOSYSTEM: '1',
});
export interface LocalRepositoryPreparationObjectOptions {
  readonly readAccess: LocalRepositoryReadAccess;
  readonly baseOid: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}
export interface LocalRepositoryPreparationObjectView {
  readonly coverage: 'preparation-required-objects-v1';
  readonly scratch: string;
  readonly gitDirectory: string;
  readonly baseOid: string;
  readonly treeOid: string;
}
/** Private actor support, NOT source-effective status or complete storage
 * qualification. Only bounded canonical loose/pack bytes enter an independently
 * owned Git directory. objects/info is unconsumed: no alternates, commit graphs,
 * promisor setup or source configuration can become execution/read authority.
 * The exact current reader remains authoritative; caller owns its disposal. */
export async function withLocalRepositoryPreparationObjects<T>(
  metadata: LocalRepositoryGitMetadata,
  options: LocalRepositoryPreparationObjectOptions,
  action: (view: LocalRepositoryPreparationObjectView) => Promise<T>,
): Promise<T> {
  const access = options.readAccess;
  const baseOid = options.baseOid;
  const signal = options.signal;
  const commonDirectory = metadata.commonDirectory;
  const objectFormat = metadata.objectFormat;
  const oidLength = objectFormat === 'sha1' ? 40 : objectFormat === 'sha256' ? 64 : 0;
  if (
    !access ||
    !oidLength ||
    !new RegExp(`^[a-f0-9]{${oidLength}}$`).test(baseOid) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 30000
  )
    throw unavailable();
  const deadline = Date.now() + options.timeoutMs;
  const check = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw unavailable();
  };
  let scratch: string | undefined;
  let total = 0,
    files = 0;
  let completed = false;
  let result!: T;
  try {
    check();
    await access.assertPath(commonDirectory);
    scratch = await mkdtemp(join(tmpdir(), 'mitzo-preparation-objects-'));
    scratch = await realpath(scratch);
    const gitDirectory = join(scratch, 'git-admin');
    const gitBytes = async (args: string[], input?: Buffer) => {
      check();
      const pending = execute('/usr/bin/git', ['--git-dir', gitDirectory, ...args], {
        cwd: scratch,
        env: environment,
        signal: signal,
        timeout: Math.max(1, deadline - Date.now()),
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'buffer',
      });
      if (input !== undefined) pending.child.stdin?.end(input);
      const result = await pending;
      check();
      await access.assertPath(commonDirectory);
      return result.stdout;
    };
    const git = async (args: string[], input?: Buffer) => {
      const output = await gitBytes(args, input);
      if (output.length > 8 * 1024 * 1024) throw unavailable();
      return output.toString('utf8');
    };
    await git([
      'init',
      '--bare',
      '--quiet',
      '--template=',
      `--object-format=${objectFormat}`,
      gitDirectory,
    ]);
    const objects = join(commonDirectory, 'objects');
    const root = await access.stat(objects);
    if (root?.kind !== 'directory') throw unavailable();
    const copy = async (
      source: string,
      destination: string,
      entry: { kind: string; nlink: number; size: number },
    ) => {
      check();
      if (
        entry.kind !== 'file' ||
        entry.nlink !== 1 ||
        entry.size > 16 * 1024 * 1024 ||
        ++files > 4096 ||
        (total += entry.size) > 128 * 1024 * 1024
      )
        throw unavailable();
      const bytes = await access.read(source, 16 * 1024 * 1024);
      check();
      if (bytes.length !== entry.size) throw unavailable();
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    };
    for (const directory of await access.list(objects)) {
      check();
      if (directory.name === 'info') continue; // No child metadata or bytes consumed.
      if (
        directory.kind !== 'directory' ||
        !(directory.name === 'pack' || /^[a-f0-9]{2}$/.test(directory.name))
      )
        throw unavailable();
      const source = join(objects, directory.name),
        target = join(gitDirectory, 'objects', directory.name);
      await mkdir(target, { recursive: true });
      for (const entry of await access.list(source)) {
        // Optional accelerators/markers never enter the private Git context.
        // Their content or target is not consumed or required for checkout.
        if (
          directory.name === 'pack' &&
          new RegExp(`^pack-[a-f0-9]{${oidLength}}\\.(rev|bitmap|keep|promisor)$`).test(entry.name)
        )
          continue;
        const valid =
          directory.name === 'pack'
            ? new RegExp(`^pack-[a-f0-9]{${oidLength}}\\.(pack|idx)$`).test(entry.name)
            : new RegExp(`^[a-f0-9]{${oidLength - 2}}$`).test(entry.name);
        if (!valid) throw unavailable();
        await copy(join(source, entry.name), join(target, entry.name), entry);
      }
    }
    // Bound Git-declared expansion BEFORE tree walking or full integrity work.
    // This is not a new object decoder: actual Git parses the copied headers.
    const headers = (
      await git([
        'cat-file',
        '--batch-all-objects',
        '--batch-check=%(objectname) %(objecttype) %(objectsize)',
      ])
    ).trimEnd();
    const objectsChecked = headers ? headers.split('\n') : [];
    if (objectsChecked.length > 10000) throw unavailable();
    let expanded = 0;
    const objectHeaders = new Map<string, { type: string; size: number }>();
    for (const row of objectsChecked) {
      const match = /^([a-f0-9]+) (blob|tree|commit|tag) (\d+)$/.exec(row);
      const size = match ? Number(match[3]) : NaN;
      if (
        !match ||
        match[1].length !== oidLength ||
        !Number.isSafeInteger(size) ||
        size > 16 * 1024 * 1024 ||
        (expanded += size) > 128 * 1024 * 1024
      )
        throw unavailable();
      objectHeaders.set(match[1], { type: match[2], size });
    }
    // Fixed private inputs only. Required content is hashed by actual Git below;
    // no unrelated parent history is required for a shallow checkout.
    await git(['cat-file', '-e', `${baseOid}^{commit}`]);
    const treeOid = (await git(['rev-parse', '--verify', `${baseOid}^{tree}`])).trim();
    if (!new RegExp(`^[a-f0-9]{${oidLength}}$`).test(treeOid)) throw unavailable();
    const rows = (await git(['ls-tree', '-r', '-t', '-z', baseOid])).split('\0').filter(Boolean);
    if (rows.length > 10000) throw unavailable();
    const required = new Map<string, string>([
      [baseOid, 'commit'],
      [treeOid, 'tree'],
    ]);
    for (const row of rows) {
      // Gitlinks are superproject entries only. Never resolve, initialize or
      // fetch their external commit; ordinary checkout leaves them uninitialized.
      if (new RegExp(`^160000 commit [a-f0-9]{${oidLength}}\\t`).test(row)) continue;
      const match = /^(100644|100755|120000|040000) (blob|tree) ([a-f0-9]+)\t/.exec(row);
      if (
        !match ||
        match[3].length !== oidLength ||
        (match[1] === '040000') !== (match[2] === 'tree')
      )
        throw unavailable();
      required.set(match[3], match[2]);
    }
    for (const [oid, type] of required) {
      const header = objectHeaders.get(oid);
      if (!header || header.type !== type) throw unavailable();
      const bytes = await gitBytes(['cat-file', type, oid]);
      if (
        bytes.length !== header.size ||
        (await git(['hash-object', '-t', type, '--stdin'], bytes)).trim() !== oid
      )
        throw unavailable();
    }
    await access.verify();
    check();
    result = await action(
      Object.freeze({
        coverage: 'preparation-required-objects-v1',
        scratch,
        gitDirectory,
        baseOid,
        treeOid,
      }),
    );
    check();
    completed = true;
  } catch {
    // All diagnostics are private; cleanup and the outward owner fence still run.
  }
  try {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  } catch {
    completed = false;
  }
  try {
    check();
    await access.verify();
    check();
  } catch {
    completed = false;
  }
  if (!completed) {
    signal?.throwIfAborted();
    throw unavailable();
  }
  return result;
}

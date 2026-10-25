import { constants } from 'node:fs';
import type { PreparationObjectStoreCapture } from './native-repository-object-store.js';
import { createHash } from 'node:crypto';
import { validNativeRepositoryTreeRelativePath } from './native-tree-publication.js';
import { AuthoritySnapshot, type SerializedAuthority } from './sandbox-authority.js';
import {
  privateRepositoryCheckoutConfig,
  privateRepositoryCheckoutAttributes,
} from './private-repository-checkout.js';
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { LocalRepositoryGitMetadata } from './local-repository-git-inspection.js';
import type { LocalRepositoryReadAccess } from './local-repository-read-access.js';
import {
  preparationReadStageMs,
  preparationCommandTimeout,
} from './local-repository-preparation-read-policy.js';

const execute = promisify(execFile);
const unavailable = () => Error('Preparation objects unavailable');

function ownedScratchDisposer(
  root: string,
  expected: { dev: bigint; ino: bigint },
  parent: { dev: bigint; ino: bigint },
) {
  let pending: Promise<void> | undefined;
  return () =>
    (pending ??= (async () => {
      const [actual, ancestor] = await Promise.all([
        lstat(root, { bigint: true }),
        lstat(dirname(root), { bigint: true }),
      ]);
      if (
        !actual.isDirectory() ||
        actual.dev !== expected.dev ||
        actual.ino !== expected.ino ||
        !ancestor.isDirectory() ||
        ancestor.dev !== parent.dev ||
        ancestor.ino !== parent.ino
      )
        throw unavailable();
      // Only retained owned scratch is removable. A controlled replacement is
      // preserved; this is not exclusion of arbitrary concurrent host mutators.
      await rm(root, { recursive: true, force: true });
    })());
}
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
async function copyOwnedObjectStore(
  capture: Readonly<PreparationObjectStoreCapture>,
  destination: string,
  check: () => void,
) {
  const root = await lstat(capture.directory, { bigint: true });
  if (
    !root.isDirectory() ||
    String(root.dev) !== capture.identity.dev ||
    String(root.ino) !== capture.identity.ino
  )
    throw unavailable();
  const copied: string[] = [];
  for (const file of capture.files) {
    check();
    const target = join(destination, file.path);
    await mkdir(dirname(target), { recursive: true });
    const input = await open(
      join(capture.directory, file.path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let output: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const original = await input.stat({ bigint: true });
      if (
        !original.isFile() ||
        original.nlink !== 1n ||
        original.size !== BigInt(file.size) ||
        String(original.dev) !== file.identity.dev ||
        String(original.ino) !== file.identity.ino
      )
        throw unavailable();
      output = await open(target, 'wx', 0o600);
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(65536);
      let remaining = file.size;
      while (remaining) {
        check();
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, remaining), null);
        if (!bytesRead) throw unavailable();
        hash.update(buffer.subarray(0, bytesRead));
        remaining -= bytesRead;
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset);
          if (!bytesWritten) throw unavailable();
          offset += bytesWritten;
        }
      }
      const after = await input.stat({ bigint: true });
      if (
        after.dev !== original.dev ||
        after.ino !== original.ino ||
        after.nlink !== 1n ||
        after.size !== original.size ||
        after.mtimeNs !== original.mtimeNs ||
        after.ctimeNs !== original.ctimeNs ||
        hash.digest('hex') !== file.sha256
      )
        throw unavailable();
      copied.push(target);
    } finally {
      await input.close();
      await output?.close();
    }
  }
  const after = await lstat(capture.directory, { bigint: true });
  if (after.dev !== root.dev || after.ino !== root.ino || !after.isDirectory()) throw unavailable();
  return copied;
}

/** One fixed Git batch decodes only the required closure. Hash incrementally;
 * neither a process per object nor a full expanded tree buffer is needed. */
async function hashRequiredObjects(
  gitDirectory: string,
  required: ReadonlyMap<string, string>,
  headers: ReadonlyMap<string, { type: string; size: number }>,
  objectFormat: string,
  signal: AbortSignal | undefined,
  deadline: number,
  check: () => void,
) {
  const objects = [...required];
  const child = spawn('/usr/bin/git', ['--git-dir', gitDirectory, 'cat-file', '--batch'], {
    cwd: dirname(gitDirectory),
    env: environment,
    signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let failed = false,
    stderrBytes = 0;
  const completion = new Promise<number | null>((resolve) => {
    child.once('error', () => {
      failed = true;
    });
    child.once('close', (code) => resolve(code));
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 65536) {
      failed = true;
      child.kill('SIGKILL');
    }
  });
  child.stdin.on('error', () => {
    failed = true;
  });
  child.stdin.end(objects.map(([oid]) => oid).join('\n') + '\n');
  const timer = setTimeout(
    () => {
      failed = true;
      child.kill('SIGKILL');
    },
    Math.max(1, deadline - Date.now()),
  );
  const hashes = new Map<string, string>();
  let header = Buffer.alloc(0),
    index = 0,
    remaining = -1,
    delimiter = false;
  let objectHash: ReturnType<typeof createHash> | undefined,
    blobHash: ReturnType<typeof createHash> | undefined;
  try {
    for await (const input of child.stdout) {
      check();
      const chunk = input as Buffer;
      let offset = 0;
      while (offset < chunk.length) {
        if (index >= objects.length) throw unavailable();
        if (delimiter) {
          if (chunk[offset++] !== 10 || objectHash!.digest('hex') !== objects[index][0])
            throw unavailable();
          if (blobHash) hashes.set(objects[index][0], blobHash.digest('hex'));
          index++;
          remaining = -1;
          delimiter = false;
          continue;
        }
        if (remaining === -1) {
          const newline = chunk.indexOf(10, offset);
          const end = newline === -1 ? chunk.length : newline;
          header = Buffer.concat([header, chunk.subarray(offset, end)]);
          if (header.length > 256) throw unavailable();
          offset = end + (newline === -1 ? 0 : 1);
          if (newline === -1) continue;
          const [oid, type] = objects[index],
            expected = headers.get(oid)!;
          if (header.toString('ascii') !== `${oid} ${type} ${expected.size}`) throw unavailable();
          header = Buffer.alloc(0);
          remaining = expected.size;
          objectHash = createHash(objectFormat).update(`${type} ${remaining}\0`);
          blobHash = type === 'blob' ? createHash('sha256') : undefined;
          if (!remaining) delimiter = true;
          continue;
        }
        const end = Math.min(chunk.length, offset + remaining),
          bytes = chunk.subarray(offset, end);
        objectHash!.update(bytes);
        blobHash?.update(bytes);
        remaining -= bytes.length;
        offset = end;
        if (!remaining) delimiter = true;
      }
    }
    if (
      (await completion) !== 0 ||
      failed ||
      index !== objects.length ||
      header.length ||
      delimiter
    )
      throw unavailable();
    check();
    return hashes;
  } catch (error) {
    child.kill('SIGKILL');
    await completion;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export interface LocalRepositoryPreparationObjectOptions {
  readonly readAccess: LocalRepositoryReadAccess;
  readonly baseOid: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}
export interface LocalRepositoryPreparationObjectView {
  readonly coverage: 'preparation-required-objects-v1';
  readonly scratch: string;
  readonly scratchIdentity: Readonly<{ dev: string; ino: string }>;
  readonly scratchParentIdentity: Readonly<{ dev: string; ino: string }>;
  readonly gitDirectory: string;
  readonly baseOid: string;
  readonly treeOid: string;
  readonly privateAuthority: SerializedAuthority;
  readonly entries: readonly Readonly<{
    path: string;
    mode: '040000' | '100644' | '100755' | '120000';
    size: number;
    sha256: string;
  }>[];
}
/** Private actor support, NOT source-effective status or complete storage
 * qualification. Only bounded canonical loose/pack bytes enter an independently
 * owned Git directory. objects/info is unconsumed: no alternates, commit graphs,
 * promisor setup or source configuration can become execution/read authority.
 * The exact current reader remains authoritative; caller owns its disposal. */
export async function captureLocalRepositoryPreparationObjects(
  metadata: LocalRepositoryGitMetadata,
  options: LocalRepositoryPreparationObjectOptions,
): Promise<Readonly<{ view: LocalRepositoryPreparationObjectView; dispose(): Promise<void> }>> {
  const access = options.readAccess;
  if (access?.preparationObservationOnly) throw unavailable();
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
    options.timeoutMs > preparationReadStageMs
  )
    throw unavailable();
  const deadline = Date.now() + options.timeoutMs;
  const check = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw unavailable();
  };
  let scratch: string | undefined;
  let dispose: (() => Promise<void>) | undefined;
  const copied: string[] = [];
  let total = 0,
    files = 0;
  let completed = false;
  let view!: LocalRepositoryPreparationObjectView;
  try {
    check();
    await access.assertPath(commonDirectory);
    scratch = await mkdtemp(join(tmpdir(), 'mitzo-preparation-objects-'));
    scratch = await realpath(scratch);
    const [owned, parent] = await Promise.all([
      lstat(scratch, { bigint: true }),
      lstat(dirname(scratch), { bigint: true }),
    ]);
    dispose = ownedScratchDisposer(scratch, owned, parent);
    const gitDirectory = join(scratch, 'git-admin');
    const gitBytes = async (args: string[], input?: Buffer) => {
      check();
      const pending = execute('/usr/bin/git', ['--git-dir', gitDirectory, ...args], {
        cwd: scratch,
        env: environment,
        signal: signal,
        timeout: preparationCommandTimeout(deadline, signal),
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
    await writeFile(
      join(gitDirectory, 'config'),
      privateRepositoryCheckoutConfig(objectFormat as 'sha1' | 'sha256'),
      { mode: 0o600 },
    );
    await mkdir(join(gitDirectory, 'info'), { recursive: true });
    await writeFile(join(gitDirectory, 'info', 'attributes'), privateRepositoryCheckoutAttributes, {
      flag: 'wx',
      mode: 0o600,
    });
    const nativeStore = await access.capturePreparationObjectStore(
      commonDirectory,
      objectFormat as 'sha1' | 'sha256',
    );
    if (nativeStore) {
      copied.push(
        ...(await copyOwnedObjectStore(nativeStore, join(gitDirectory, 'objects'), check)),
      );
      await access.assertPath(commonDirectory);
    } else {
      const objects = join(commonDirectory, 'objects');
      const root = await access.stat(objects);
      if (root?.kind !== 'directory') throw unavailable();
      // Discover and validate the original parent frontier before byte waves.
      // No read races directory-cache creation or infers an absent/source root.
      const directories = (await access.list(objects)).filter((entry) => entry.name !== 'info');
      for (const directory of directories) {
        check();
        if (
          directory.kind !== 'directory' ||
          !(directory.name === 'pack' || /^[a-f0-9]{2}$/.test(directory.name))
        )
          throw unavailable();
      }
      // Retain ordinary directory limits: even 4096 valid fixed shard names
      // can exceed the batch helper's conservative 2 MiB pre-allocation guard.
      // A directory inode/size is not a bound on its children. All listings finish
      // before byte waves; no generic-limit/authorization fallback is needed.
      const inputs: Array<{ source: string; destination: string; size: number }> = [];
      for (const directory of directories) {
        const source = join(objects, directory.name),
          target = join(gitDirectory, 'objects', directory.name);
        await mkdir(target, { recursive: true });
        for (const entry of await access.list(source)) {
          // Optional accelerators/markers never enter the private Git context.
          if (
            directory.name === 'pack' &&
            new RegExp(`^pack-[a-f0-9]{${oidLength}}\\.(rev|bitmap|keep|promisor)$`).test(
              entry.name,
            )
          )
            continue;
          const valid =
            directory.name === 'pack'
              ? new RegExp(`^pack-[a-f0-9]{${oidLength}}\\.(pack|idx)$`).test(entry.name)
              : new RegExp(`^[a-f0-9]{${oidLength - 2}}$`).test(entry.name);
          if (
            !valid ||
            entry.kind !== 'file' ||
            entry.nlink !== 1 ||
            entry.size > 16 * 1024 * 1024 ||
            ++files > 4096 ||
            (total += entry.size) > 128 * 1024 * 1024
          )
            throw unavailable();
          inputs.push({
            source: join(source, entry.name),
            destination: join(target, entry.name),
            size: entry.size,
          });
        }
      }
      // The aggregate read budget reserves both in-flight inputs synchronously.
      // Join every started operation, stage results, then process original order.
      for (let index = 0; index < inputs.length; index += 2) {
        check();
        const wave = inputs.slice(index, index + 2);
        const results = await Promise.allSettled(
          wave.map((input) => access.read(input.source, 16 * 1024 * 1024)),
        );
        check();
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        for (let offset = 0; offset < results.length; offset++) {
          const result = results[offset];
          if (result.status !== 'fulfilled' || result.value.length !== wave[offset].size)
            throw unavailable();
          await writeFile(wave[offset].destination, result.value, { flag: 'wx', mode: 0o600 });
          copied.push(wave[offset].destination);
        }
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
    // Container header output remains bounded independently of checkout size.
    if (objectsChecked.length > 200000) throw unavailable();
    const objectHeaders = new Map<string, { type: string; size: number }>();
    for (const row of objectsChecked) {
      const match = /^([a-f0-9]+) (blob|tree|commit|tag) (\d+)$/.exec(row);
      const size = match ? Number(match[3]) : NaN;
      if (
        !match ||
        match[1].length !== oidLength ||
        !Number.isSafeInteger(size) ||
        size > 128 * 1024 * 1024
      )
        throw unavailable();
      objectHeaders.set(match[1], { type: match[2], size });
    }
    // Fixed private inputs only. Required content is hashed by actual Git below;
    // no unrelated parent history is required for a shallow checkout.
    await git(['cat-file', '-e', `${baseOid}^{commit}`]);
    const treeOid = (await git(['rev-parse', '--verify', `${baseOid}^{tree}`])).trim();
    if (!new RegExp(`^[a-f0-9]{${oidLength}}$`).test(treeOid)) throw unavailable();
    const rows = new TextDecoder('utf-8', { fatal: true })
      .decode(await gitBytes(['ls-tree', '-r', '-t', '-z', baseOid]))
      .split('\0')
      .filter(Boolean);
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
    let expanded = 0;
    for (const [oid, type] of required) {
      const header = objectHeaders.get(oid);
      if (
        !header ||
        header.type !== type ||
        header.size > 16 * 1024 * 1024 ||
        (expanded += header.size) > 128 * 1024 * 1024
      )
        throw unavailable();
    }
    const hashes = await hashRequiredObjects(
      gitDirectory,
      required,
      objectHeaders,
      objectFormat,
      signal,
      deadline,
      check,
    );
    await access.assertPath(commonDirectory);
    let checkoutBytes = 0;
    const entries = rows.map((row) => {
      const match =
        /^(100644|100755|120000|040000|160000) (?:blob|tree|commit) ([a-f0-9]+)\t(.*)$/s.exec(row);
      if (!match || !validNativeRepositoryTreeRelativePath(match[3])) throw unavailable();
      const directory = ['040000', '160000'].includes(match[1]);
      const size = directory ? 0 : objectHeaders.get(match[2])?.size;
      const sha256 = directory
        ? createHash('sha256').update('').digest('hex')
        : hashes.get(match[2]);
      if (size === undefined || !sha256 || (checkoutBytes += size) > 128 * 1024 * 1024)
        throw unavailable();
      return Object.freeze({
        path: match[3],
        mode: (directory ? '040000' : match[1]) as '040000' | '100644' | '100755' | '120000',
        size,
        sha256,
      });
    });
    Object.freeze(entries);
    await access.verify();
    check();
    const privateAuthority = new AuthoritySnapshot();
    for (const file of [
      ...copied,
      join(gitDirectory, 'config'),
      join(gitDirectory, 'HEAD'),
      join(gitDirectory, 'info', 'attributes'),
    ])
      privateAuthority.capture(file, true);
    privateAuthority.capture(scratch);
    privateAuthority.capture(gitDirectory);
    // Only already-owned copied inputs, no source/config/credential roots.
    const retainedAuthority = privateAuthority
      .serialize()
      .filter((item) => item.path === scratch || item.path.startsWith(scratch + '/'))
      .map((item) =>
        Object.freeze({ ...item, ...(item.stat ? { stat: Object.freeze({ ...item.stat }) } : {}) }),
      );
    Object.freeze(retainedAuthority);
    view = Object.freeze({
      coverage: 'preparation-required-objects-v1',
      scratch,
      scratchIdentity: Object.freeze({ dev: String(owned.dev), ino: String(owned.ino) }),
      scratchParentIdentity: Object.freeze({ dev: String(parent.dev), ino: String(parent.ino) }),
      gitDirectory,
      baseOid,
      treeOid,
      privateAuthority: retainedAuthority,
      entries,
    });
    check();
    completed = true;
  } catch {
    // All diagnostics are private; cleanup and the outward owner fence still run.
  }
  try {
    check();
    await access.verify();
    check();
  } catch {
    completed = false;
  }
  if (!completed) {
    if (dispose) await dispose();
    signal?.throwIfAborted();
    throw unavailable();
  }
  return Object.freeze({ view, dispose: dispose! });
}

/** Compatibility wrapper retains its full post-callback source/owner fence.
 * The actor instead captures/disposes its READ owner before source mutations,
 * retaining only independently-owned immutable private inputs and cleanup. */
export async function withLocalRepositoryPreparationObjects<T>(
  metadata: LocalRepositoryGitMetadata,
  options: LocalRepositoryPreparationObjectOptions,
  action: (view: LocalRepositoryPreparationObjectView) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  const held = await captureLocalRepositoryPreparationObjects(metadata, options);
  let value!: T,
    completed = false;
  try {
    value = await action(held.view);
    completed = true;
  } catch {
    /* sanitized below */
  }
  try {
    await held.dispose();
  } catch {
    completed = false;
  }
  try {
    options.signal?.throwIfAborted();
    await options.readAccess.verify();
    if (Date.now() >= deadline) throw unavailable();
  } catch {
    completed = false;
  }
  if (!completed) {
    options.signal?.throwIfAborted();
    throw unavailable();
  }
  return value;
}

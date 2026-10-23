import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import type { LocalRepositoryAllocationFacts } from './local-repository-allocation-facts.js';
import type { LocalRepositoryReadAccess } from './local-repository-read-access.js';
import type { NativeReadIdentity } from './native-file-operation.js';
import type { RepositoryTaskCheckout } from './repository-task-checkout.js';
import { inspectLocalRepositoryGitMetadata } from './local-repository-git-inspection.js';
import { readLocalRepositoryPreparationReferences } from './local-repository-git-snapshot.js';
import { freezePendingHostTaskData } from './pending-host-task.js';
import { preparationReadStageMs } from './local-repository-preparation-read-policy.js';

export interface QualifiedLocalRepositoryPublication {
  readonly version: 1;
  readonly directories: readonly {
    readonly directory: string;
    readonly identity: NativeReadIdentity;
  }[];
  readonly files: readonly {
    readonly file_path: string;
    readonly identity: NativeReadIdentity;
    readonly byteLength: number;
    readonly sha256: string;
  }[];
}
const unavailable = () => Error('Qualified repository task unavailable');
const path = (value: unknown): value is string =>
  typeof value === 'string' &&
  isAbsolute(value) &&
  resolve(value) === value &&
  Buffer.byteLength(value) <= 4096 &&
  !/[\0\r\n]/.test(value);
const data = (value: unknown, keys: readonly string[]) => {
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw unavailable();
  const names = Reflect.ownKeys(value);
  if (
    names.length !== keys.length ||
    names.some((name) => typeof name !== 'string' || !keys.includes(name))
  )
    throw unavailable();
  return Object.fromEntries(
    keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw unavailable();
      return [key, descriptor.value];
    }),
  );
};
const identity = (value: unknown): NativeReadIdentity => {
  const item = data(value, ['dev', 'ino']);
  if (![item.dev, item.ino].every((part) => typeof part === 'string' && /^\d{1,32}$/.test(part)))
    throw unavailable();
  return Object.freeze({ dev: item.dev, ino: item.ino });
};
const equal = (a: NativeReadIdentity, b: NativeReadIdentity) => a.dev === b.dev && a.ino === b.ino;
const array = (value: unknown, max: number) => {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max
  )
    throw unavailable();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) throw unavailable();
    return descriptor.value;
  });
};
/** Data receipt only. Actual actor constructs this from exclusive helper results;
 * persisted JSON is historical evidence and never becomes fresh authority. */
export function snapshotQualifiedLocalRepositoryPublication(
  input: QualifiedLocalRepositoryPublication,
): Readonly<QualifiedLocalRepositoryPublication> {
  const item = data(input, ['version', 'directories', 'files']);
  if (item.version !== 1) throw unavailable();
  const directories = array(item.directories, 10).map((value) => {
    const entry = data(value, ['directory', 'identity']);
    if (!path(entry.directory)) throw unavailable();
    return { directory: entry.directory, identity: identity(entry.identity) };
  });
  const files = array(item.files, 8).map((value) => {
    const entry = data(value, ['file_path', 'identity', 'byteLength', 'sha256']);
    if (
      !path(entry.file_path) ||
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteLength < 0 ||
      entry.byteLength > 16 * 1024 * 1024 ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw unavailable();
    return {
      file_path: entry.file_path,
      identity: identity(entry.identity),
      byteLength: entry.byteLength,
      sha256: entry.sha256,
    };
  });
  const result = { version: 1 as const, directories, files };
  if (Buffer.byteLength(JSON.stringify(result)) > 16384) throw unavailable();
  return freezePendingHostTaskData(result);
}
function numeric(value: NativeReadIdentity) {
  const dev = Number(value.dev),
    ino = Number(value.ino);
  if (!Number.isSafeInteger(dev) || dev < 0 || !Number.isSafeInteger(ino) || ino < 0)
    throw unavailable();
  return { dev, ino };
}
/** Fresh read-only phase validation. No source Git cwd/config execution, status,
 * mutation, grant, row claim or admission. Creation hashes/IDs are checked only
 * before adoption; they must not constrain later legitimate add/commit effects. */
export async function captureQualifiedLocalRepositoryTask(
  access: LocalRepositoryReadAccess,
  facts: LocalRepositoryAllocationFacts,
  publication: QualifiedLocalRepositoryPublication,
): Promise<Readonly<RepositoryTaskCheckout>> {
  try {
    const receipt = snapshotQualifiedLocalRepositoryPublication(publication);
    if (
      !facts.existingDirectories ||
      facts.existingDirectories.length > 10 ||
      facts.directories.length > 9 ||
      facts.source.referenceCoverage !== 'preparation-head-and-namespace-v1'
    )
      throw unavailable();
    const task = join(facts.taskRoot.rootPath, `repo-${facts.workspaceId}`),
      common = facts.source.commonDirectory,
      admin = join(common, 'worktrees', `repo-${facts.workspaceId}`),
      reference = join(common, 'refs', 'heads', facts.featureBranch);
    const expectedDirectories = new Set([
      ...facts.directories.map((step) => step.directory),
      admin,
    ]);
    if (
      receipt.directories.length !== expectedDirectories.size ||
      new Set(receipt.directories.map((entry) => entry.directory)).size !==
        receipt.directories.length ||
      receipt.directories.some((entry) => !expectedDirectories.has(entry.directory))
    )
      throw unavailable();
    const required = [
      join(admin, 'HEAD'),
      join(admin, 'commondir'),
      join(admin, 'gitdir'),
      join(admin, 'index'),
      reference,
      join(task, '.git'),
    ];
    const allowed = new Set([
      ...required,
      join(admin, 'locked'),
      join(common, 'logs', 'refs', 'heads', facts.featureBranch),
    ]);
    const files = new Map(receipt.files.map((entry) => [entry.file_path, entry]));
    if (
      files.size !== receipt.files.length ||
      receipt.files.some((entry) => !allowed.has(entry.file_path)) ||
      required.some((file) => !files.has(file))
    )
      throw unavailable();
    const sourceAnchor = await access.pinRoot(facts.source.path),
      taskAnchor = await access.pinRoot(facts.taskRoot.rootPath);
    if (
      !equal(sourceAnchor.identity, facts.source.sourceAnchor.identity) ||
      !equal(taskAnchor.identity, facts.taskRoot.identity)
    )
      throw unavailable();
    await access.listPinnedRoots([facts.source.path, facts.taskRoot.rootPath]);
    const commonAnchor = await access.pinRoot(common);
    if (!equal(commonAnchor.identity, facts.source.commonAnchor.identity)) throw unavailable();
    for (const directory of [...facts.existingDirectories, ...receipt.directories]) {
      const entry = await access.stat(directory.directory);
      if (entry?.kind !== 'directory' || !equal(entry.identity, directory.identity))
        throw unavailable();
    }
    const metadata = await inspectLocalRepositoryGitMetadata({
      path: facts.source.path,
      mode: 'preparation',
      readAccess: access,
      assertReadable: (target) => access.assertPath(target),
      timeoutMs: preparationReadStageMs,
    });
    if (
      metadata.gitDirectory !== facts.source.gitDirectory ||
      metadata.commonDirectory !== common ||
      metadata.objectFormat !== facts.source.objectFormat
    )
      throw unavailable();
    const ref = files.get(reference)!;
    const base = await readLocalRepositoryPreparationReferences(
      metadata,
      { readAccess: access, timeoutMs: preparationReadStageMs },
      `refs/heads/${facts.featureBranch}`,
      { identity: ref.identity, oid: facts.baseOid },
    );
    if (
      base.conflict ||
      base.head !== facts.baseOid ||
      (base.branch ?? base.head) !== facts.baseBranch
    )
      throw unavailable();
    const expectedText = new Map([
      [join(admin, 'HEAD'), `ref: refs/heads/${facts.featureBranch}\n`],
      [join(admin, 'commondir'), '../..\n'],
      [join(admin, 'gitdir'), join(task, '.git') + '\n'],
      [reference, facts.baseOid + '\n'],
      [join(task, '.git'), `gitdir: ${admin}\n`],
    ]);
    let total = 0;
    for (const file of receipt.files) {
      const entry = await access.stat(file.file_path);
      if (
        entry?.kind !== 'file' ||
        entry.nlink !== 1 ||
        !equal(entry.identity, file.identity) ||
        entry.size !== file.byteLength ||
        (total += file.byteLength) > 32 * 1024 * 1024
      )
        throw unavailable();
    }
    // All required file entries/parents are known before independent byte waves.
    // Join failures/cancellation completely; validate in original receipt order.
    for (let index = 0; index < receipt.files.length; index += 2) {
      const wave = receipt.files.slice(index, index + 2);
      const results = await Promise.allSettled(
        wave.map((file) => access.read(file.file_path, 16 * 1024 * 1024)),
      );
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      for (let offset = 0; offset < results.length; offset++) {
        const file = wave[offset],
          result = results[offset];
        if (result.status !== 'fulfilled') throw unavailable();
        const bytes = result.value;
        if (
          createHash('sha256').update(bytes).digest('hex') !== file.sha256 ||
          (expectedText.has(file.file_path) &&
            !bytes.equals(Buffer.from(expectedText.get(file.file_path)!)))
        )
          throw unavailable();
      }
    }
    await access.verify();
    const root = receipt.directories.find((entry) => entry.directory === task),
      linked = receipt.directories.find((entry) => entry.directory === admin);
    if (!root || !linked) throw unavailable();
    return freezePendingHostTaskData({
      directory: task,
      featureBranch: facts.featureBranch,
      root: numeric(root.identity),
      git: numeric(files.get(join(task, '.git'))!.identity),
      linkedGit: { directory: admin, identity: numeric(linked.identity) },
    });
  } catch {
    throw unavailable();
  }
}

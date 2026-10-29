import { lstatSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { RepositoryTaskCheckout } from './repository-task-checkout.js';
import type { LocalRepositoryReadAccess } from './local-repository-read-access.js';
import { inspectLocalRepositoryGitMetadata } from './local-repository-git-inspection.js';
import { freezePendingHostTaskData } from './pending-host-task.js';
import { restoredRepositoryTaskIdentity } from './repository-workspace-restoration.js';
import { readLocalRepositoryBaseReference } from './local-repository-base.js';

const unavailable = () => Error('Qualified repository task custody unavailable');
const equal = (actual: { dev: string; ino: string }, expected: { dev: number; ino: number }) =>
  actual.dev === String(expected.dev) && actual.ino === String(expected.ino);

/** Mechanism only, never custody or read authority. The actual native owner
 * supplies a fresh anchored access and independently asserts persisted adoption.
 * Validate stable topology, not creation index/ref/log identities or hashes, so
 * ordinary task edits and commits can advance after the guarded transition. */
export async function assertPreparedRepositoryTaskTopology(
  access: LocalRepositoryReadAccess,
  input: Readonly<RepositoryTaskCheckout>,
  sourceGitDirectory: string,
): Promise<void> {
  const task = structuredClone(input),
    source = task.localSource,
    linked = task.linkedGit;
  if (source && !linked) {
    const git = join(task.directory, '.git');
    if (
      !/^mitzo\/[A-Za-z0-9._/-]+$/.test(task.featureBranch) ||
      task.featureBranch.includes('..') ||
      !isAbsolute(task.directory)
    )
      throw unavailable();
    if (access.canCaptureRepositoryObservation)
      await access.captureRepositoryObservation({
        mode: 'task-topology',
        sourcePath: task.directory,
        readableRoots: [task.directory],
      });
    for (const [path, expected] of [
      [task.directory, task.root],
      [git, task.git],
    ] as const)
      if (!equal((await access.pinRoot(path)).identity, expected)) throw unavailable();
    const metadata = await inspectLocalRepositoryGitMetadata({
      path: task.directory,
      mode: 'head',
      readAccess: access,
      assertReadable: (path) => access.assertPath(path),
      timeoutMs: 30000,
    });
    if (metadata.gitDirectory !== git || metadata.commonDirectory !== git) throw unavailable();
    if (
      !(await access.read(join(git, 'HEAD'), 4096)).equals(
        Buffer.from(`ref: refs/heads/${task.featureBranch}\n`),
      )
    )
      throw unavailable();
    const base = await readLocalRepositoryBaseReference(access, metadata, 'HEAD');
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(base.oid)) throw unavailable();
    for (const name of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates'])
      if (await access.stat(join(git, name))) throw unavailable();
    const shallow = await access.stat(join(git, 'shallow'));
    if (shallow) {
      if (shallow.kind !== 'file' || shallow.nlink !== 1 || shallow.size > 65536)
        throw unavailable();
      const oidLength = metadata.objectFormat === 'sha256' ? 64 : 40;
      if (
        !(await access.read(join(git, 'shallow'), 65536))
          .toString('utf8')
          .split('\n')
          .filter(Boolean)
          .every((oid) => new RegExp(`^[a-f0-9]{${oidLength}}$`).test(oid))
      )
        throw unavailable();
    }
    const index = await access.stat(join(git, 'index'));
    if (index?.kind !== 'file' || index.nlink !== 1) throw unavailable();
    await access.verify();
    return;
  }
  if (
    !source ||
    !linked ||
    !/^mitzo\/[A-Za-z0-9._/-]+$/.test(task.featureBranch) ||
    task.featureBranch.includes('..') ||
    ![
      task.directory,
      source.path,
      source.commonDirectory,
      linked.directory,
      sourceGitDirectory,
    ].every(isAbsolute) ||
    linked.directory !== join(source.commonDirectory, 'worktrees', basename(task.directory))
  )
    throw unavailable();
  const taskName = /^repo-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(
    basename(task.directory),
  );
  if (access.canCaptureRepositoryObservation && taskName)
    await access.captureRepositoryObservation({
      mode: 'topology',
      sourcePath: source.path,
      taskRoot: dirname(task.directory),
      workspaceId: taskName[1],
    });
  const roots = [
    [task.directory, task.root],
    [source.path, source.root],
    [source.commonDirectory, source.commonRoot],
    [linked.directory, linked.identity],
  ] as const;
  for (const [path, identity] of roots)
    if (!equal((await access.pinRoot(path)).identity, identity)) throw unavailable();
  // Re-resolve the retained source's gitfile/commondir through the original
  // anchored reader. Source/common inode equality alone does not pin their
  // relationship. This compact view qualifies topology only, never all refs,
  // object storage, status or new read authority.
  const metadata = await inspectLocalRepositoryGitMetadata({
    path: source.path,
    mode: 'preparation',
    readAccess: access,
    assertReadable: (path) => access.assertPath(path),
    timeoutMs: 30000,
  });
  if (
    metadata.path !== source.path ||
    metadata.gitDirectory !== sourceGitDirectory ||
    metadata.commonDirectory !== source.commonDirectory
  )
    throw unavailable();
  // The topology snapshot deliberately contains only the task's .git marker.
  // Its fixed metadata paths are already captured; never request a whole task listing.
  if (access.repositoryObservationMode !== 'topology')
    await access.preloadDirectories(roots.map(([path]) => path));
  const pointer = join(task.directory, '.git');
  const entry = await access.stat(pointer);
  if (entry?.kind !== 'file' || entry.nlink !== 1 || !equal(entry.identity, task.git))
    throw unavailable();
  for (const [path, expected] of [
    [pointer, `gitdir: ${linked.directory}\n`],
    [
      join(linked.directory, 'commondir'),
      relative(linked.directory, source.commonDirectory) + '\n',
    ],
    [join(linked.directory, 'gitdir'), pointer + '\n'],
    [join(linked.directory, 'HEAD'), `ref: refs/heads/${task.featureBranch}\n`],
  ]) {
    if (!(await access.read(path, 4096)).equals(Buffer.from(expected))) throw unavailable();
  }
  const index = await access.stat(join(linked.directory, 'index'));
  if (index?.kind !== 'file' || index.nlink !== 1) throw unavailable();
  const reference = await access.read(
    join(source.commonDirectory, 'refs', 'heads', task.featureBranch),
    128,
  );
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?\n$/.test(reference.toString('utf8'))) throw unavailable();
  await access.verify();
}

interface PhysicalOwners {
  assertCurrentSync(): void;
  /** Actual native composition obtains a fresh selected-policy reader through
   * the SAME bootstrap credential owner. No retained pre-CAS scope qualifies. */
  withReadAccess(
    signal: AbortSignal,
    action: (access: LocalRepositoryReadAccess) => Promise<void>,
  ): Promise<void>;
}
function sync(result: unknown): void {
  if (result === undefined) return;
  void Promise.resolve(result).catch(() => {});
  throw unavailable();
}

/** Qualified post-CAS custody, separate from the creation-phase capture. The
 * persisted witness owns attachment; the fresh native reader owns bytes. */
export class PreparedRepositoryWorkspaceOwner {
  readonly kind = 'repository' as const;
  readonly #current;
  readonly #physical;
  readonly #adopted;
  constructor(
    private readonly repository: Pick<
      import('./repository-workspaces.js').RepositoryWorkspaces,
      'observePreparedRepositoryTransitionAdopted'
    >,
    private readonly facts: import('./prepared-repository-transition.js').PreparedRepositoryTransitionFacts,
    private readonly childCommandId: string,
    private readonly owners: PhysicalOwners,
  ) {
    this.#current = owners.assertCurrentSync;
    this.#physical = owners.withReadAccess;
    this.#adopted = repository.observePreparedRepositoryTransitionAdopted;
    this.facts = freezePendingHostTaskData(structuredClone(facts));
  }
  private references(): void {
    if (
      this.owners.assertCurrentSync !== this.#current ||
      this.owners.withReadAccess !== this.#physical ||
      this.repository.observePreparedRepositoryTransitionAdopted !== this.#adopted
    )
      throw unavailable();
  }
  private current(): void {
    this.references();
    sync(Reflect.apply(this.#current, this.owners, []));
    this.references();
  }
  get(): import('./repository-workspaces.js').RepositoryWorkspace {
    this.current();
    const record = Reflect.apply(this.#adopted, this.repository, [this.facts, this.childCommandId]);
    if (record instanceof Promise) {
      void record.catch(() => {});
      throw unavailable();
    }
    const next = this.facts.newWorkspace;
    if (
      !record ||
      record.id !== next.id ||
      record.conversationId !== this.facts.request.conversationId ||
      record.directory !== next.directory ||
      record.featureBranch !== next.featureBranch ||
      record.state !== 'claimed' ||
      record.sandbox ||
      !isDeepStrictEqual(record.binding, this.facts.request.binding) ||
      !isDeepStrictEqual(
        record.taskIdentity,
        restoredRepositoryTaskIdentity(record, next.taskIdentity),
      ) ||
      !record.qualifiedLocalPreparation
    )
      throw unavailable();
    this.references();
    return record;
  }
  assertCurrentSync(cwd: string): void {
    this.currentTask(cwd);
  }
  private currentTask(cwd: string) {
    const record = this.get(),
      task = record.taskIdentity!,
      source = task.localSource,
      linked = task.linkedGit;
    if (cwd !== record.directory || !source) throw unavailable();
    for (const [path, retained, file] of [
      [task.directory, task.root, false],
      [join(task.directory, '.git'), task.git, !!linked],
    ] as const) {
      const actual = lstatSync(path);
      if (
        (file ? !actual.isFile() || actual.nlink !== 1 : !actual.isDirectory()) ||
        actual.isSymbolicLink() ||
        realpathSync(path) !== path ||
        actual.dev !== retained.dev ||
        actual.ino !== retained.ino
      )
        throw unavailable();
    }
    this.current();
    return record;
  }
  async validate(cwd: string, signal = new AbortController().signal): Promise<void> {
    signal.throwIfAborted();
    const record = this.currentTask(cwd);
    const checked: unknown = await Reflect.apply(this.#physical, this.owners, [
      signal,
      async (access) => {
        signal.throwIfAborted();
        this.assertCurrentSync(cwd);
        await assertPreparedRepositoryTaskTopology(
          access,
          record.taskIdentity!,
          record.qualifiedLocalPreparation!.allocationFacts.source.gitDirectory,
        );
        signal.throwIfAborted();
        this.assertCurrentSync(cwd);
      },
    ]);
    if (checked !== undefined) throw unavailable();
    signal.throwIfAborted();
    this.assertCurrentSync(cwd);
  }
  async revalidate(signal: AbortSignal): Promise<void> {
    await this.validate(this.facts.newWorkspace.directory, signal);
  }
}

/** Private persistent policy owner from the actual chat composition, never a model input. */
export interface PreparedRepositoryNativePolicyOwner {
  readonly signal: AbortSignal;
  selectedPolicy(): import('./codex-native-execution-policy.js').CodexNativeExecutionPolicy;
  assertCurrentSync(): void;
  assertNativeExecutionCurrent?(
    policy: import('./codex-native-execution-policy.js').CodexNativeExecutionPolicy,
    commandId: string,
  ): void;
}

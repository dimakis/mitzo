import { lstatSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { RepositoryTaskCheckout } from './repository-task-checkout.js';
import type { LocalRepositoryReadAccess } from './local-repository-read-access.js';
import { inspectLocalRepositoryGitMetadata } from './local-repository-git-inspection.js';
import { freezePendingHostTaskData } from './pending-host-task.js';

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
  readonly #get;
  readonly #adopted;
  constructor(
    private readonly repository: Pick<
      import('./repository-workspaces.js').RepositoryWorkspaces,
      'getForConversation' | 'assertPreparedRepositoryTransitionAdopted'
    >,
    private readonly facts: import('./prepared-repository-transition.js').PreparedRepositoryTransitionFacts,
    private readonly childCommandId: string,
    private readonly owners: PhysicalOwners,
  ) {
    this.#current = owners.assertCurrentSync;
    this.#physical = owners.withReadAccess;
    this.#get = repository.getForConversation;
    this.#adopted = repository.assertPreparedRepositoryTransitionAdopted;
    this.facts = freezePendingHostTaskData(structuredClone(facts));
  }
  private current(): void {
    if (
      this.owners.assertCurrentSync !== this.#current ||
      this.owners.withReadAccess !== this.#physical ||
      this.repository.getForConversation !== this.#get ||
      this.repository.assertPreparedRepositoryTransitionAdopted !== this.#adopted
    )
      throw unavailable();
    sync(Reflect.apply(this.#current, this.owners, []));
    if (
      this.owners.assertCurrentSync !== this.#current ||
      this.owners.withReadAccess !== this.#physical ||
      this.repository.getForConversation !== this.#get ||
      this.repository.assertPreparedRepositoryTransitionAdopted !== this.#adopted
    )
      throw unavailable();
  }
  get(): import('./repository-workspaces.js').RepositoryWorkspace {
    this.current();
    sync(
      this.repository.assertPreparedRepositoryTransitionAdopted(this.facts, this.childCommandId),
    );
    const record = this.repository.getForConversation(this.facts.request.conversationId);
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
      !isDeepStrictEqual(record.taskIdentity, next.taskIdentity) ||
      !record.qualifiedLocalPreparation
    )
      throw unavailable();
    this.current();
    return record;
  }
  assertCurrentSync(cwd: string): void {
    const record = this.get(),
      task = record.taskIdentity!,
      source = task.localSource,
      linked = task.linkedGit;
    if (cwd !== record.directory || !source || !linked) throw unavailable();
    for (const [path, retained, file] of [
      [task.directory, task.root, false],
      [join(task.directory, '.git'), task.git, true],
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
  }
  async validate(cwd: string, signal = new AbortController().signal): Promise<void> {
    signal.throwIfAborted();
    this.assertCurrentSync(cwd);
    const record = this.get();
    const checked: unknown = await Reflect.apply(this.#physical, this.owners, [
      signal,
      async (access) => {
        signal.throwIfAborted();
        this.assertCurrentSync(cwd);
        await assertPreparedRepositoryTaskTopology(
          access,
          this.facts.newWorkspace.taskIdentity,
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

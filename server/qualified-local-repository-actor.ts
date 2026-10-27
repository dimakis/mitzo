import { repositoryGitEntrySizeLimit } from './repository-git-container-policy.js';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile, cp, readdir, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import {
  captureNativeHostReadOwner,
  type NativeHostToolContext,
} from './native-host-tool-context.js';
import { captureNativeLocalRepositoryReader } from './local-repository-native-read.js';
import type { LocalRepositoryAllocationFacts } from './local-repository-allocation-facts.js';
import {
  retainPreparationPackedRefs,
  type PreparationPackedRefs,
} from './local-repository-preparation-packed-refs.js';
import { LocalRepositoryReadAccess } from './local-repository-read-access.js';
import { preparationReadDeadline } from './local-repository-preparation-read-policy.js';
import {
  verifyLocalRepositoryPreparationObjectData,
  type LocalRepositoryPreparationObjectData,
} from './local-repository-preparation-object-data.js';
import {
  executePrivateNativeFileHelper,
  executePrivateRepositoryStagingCheckout,
} from './sandboxed-command.js';
import {
  freezeNativeReadExclusions,
  type NativeFileHelperTransport,
} from './native-file-operation.js';
import {
  publishNativePreparedRepository,
  nativePreparationPublicationWriteRoots,
  type NativePreparationPublicationPlan,
} from './native-preparation-publication.js';
import {
  captureQualifiedLocalRepositoryTask,
  snapshotQualifiedLocalRepositoryPublication,
  type QualifiedLocalRepositoryPublication,
} from './qualified-local-repository-task.js';
import { type NativeExclusiveTreeEntry } from './native-tree-publication.js';
import {
  standaloneRepositoryCheckoutConfig,
  privateRepositoryCheckoutAttributes,
} from './private-repository-checkout.js';

const unavailable = () => Error('Qualified repository materialization unavailable');
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const identity = async (path: string) => {
  const info = await lstat(path, { bigint: true });
  return Object.freeze({ dev: String(info.dev), ino: String(info.ino) });
};
/** PRIVATE consumed-operation actor. Actual service checks its unforgeable
 * original operation before calling. Data facts never independently grant this
 * function authority; every effect keeps the SAME original native owner. */
export async function materializeQualifiedLocalRepositoryTask(operation: {
  readonly context: NativeHostToolContext;
  readonly facts: LocalRepositoryAllocationFacts;
  readonly factsSha256: string;
  readonly requestSha256: string;
  readonly scopeSha256: string;
  readonly expiresAt: number;
  readonly objects?: LocalRepositoryPreparationObjectData;
  readonly publicationPackedRefs?: PreparationPackedRefs;
  assertCurrentSync(): void;
  assertCurrent(): Promise<void>;
}) {
  const { context, facts, factsSha256, expiresAt } = operation;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw unavailable();
  const owner = captureNativeHostReadOwner(context);
  if (!owner || !facts.existingDirectories || facts.existingDirectories.length > 10)
    throw unavailable();
  let deadline = expiresAt;
  const current = () => {
    context.signal.throwIfAborted();
    if (Date.now() >= deadline) throw unavailable();
    operation.assertCurrentSync();
    owner.assertCurrentSync();
  };
  const full = async () => {
    current();
    // The consumed original decision owner includes the actual source owner;
    // a still-current native read facet alone cannot substitute for that proof.
    const pending: unknown = operation.assertCurrent();
    if (!(pending instanceof Promise) || (await pending) !== undefined) throw unavailable();
    await owner.assertCurrent();
    current();
  };
  const read = async <T>(
    action: (
      access: LocalRepositoryReadAccess,
      reader: Awaited<ReturnType<typeof captureNativeLocalRepositoryReader>>,
    ) => Promise<T>,
  ) => {
    current();
    const reader = await captureNativeLocalRepositoryReader(context, {
      deadline: preparationReadDeadline(deadline, context.signal),
    });
    try {
      return await action(new LocalRepositoryReadAccess(reader), reader);
    } finally {
      try {
        await reader.dispose();
      } finally {
        await full();
      }
    }
  };
  await full();
  const artifact = operation.objects;
  const end = artifact && Object.getOwnPropertyDescriptor(artifact, 'deadline');
  const dispose = artifact && Object.getOwnPropertyDescriptor(artifact, 'dispose');
  if (
    !artifact ||
    !end ||
    !('value' in end) ||
    !Number.isSafeInteger(end.value) ||
    !dispose ||
    !('value' in dispose) ||
    typeof dispose.value !== 'function'
  )
    throw unavailable();
  deadline = Math.min(expiresAt, end.value);
  current();
  const disposeArtifact = async () => {
    const closed: unknown = Reflect.apply(dispose.value, artifact, []);
    if (!(closed instanceof Promise) || (await closed) !== undefined) throw unavailable();
  };
  let packedRefs: NativePreparationPublicationPlan['packedRefs'] | undefined;
  const task = join(facts.taskRoot.rootPath, `repo-${facts.workspaceId}`),
    common = facts.source.commonDirectory;
  const admin = join(common, 'worktrees', `repo-${facts.workspaceId}`);
  const denied = freezeNativeReadExclusions(owner.scope.deniedRoots);
  let publication: Readonly<QualifiedLocalRepositoryPublication> | undefined;
  try {
    // This is the INITIAL parser's historical witness, never a new baseline or
    // current success. The fixed helper's complete preflight checks it freshly
    // alongside every original root/parent/edge/absence BEFORE the first write.
    packedRefs = retainPreparationPackedRefs(operation.publicationPackedRefs);
    // Relocate (do not remove) the original allocation-reader disposal fence to
    // this actual artifact-use boundary. Source metadata/base is freshly checked.
    await full();
    const view = await verifyLocalRepositoryPreparationObjectData(
      artifact,
      context,
      operation.requestSha256,
      facts,
      factsSha256,
      packedRefs,
    );
    // Preserve the genuine consumed object-stage fence even though its READ
    // capture/disposal already completed before human source-effect approval.
    await full();
    const scratch = view.scratch;
    const scratchAnchor = Object.freeze({ rootPath: scratch, identity: view.scratchIdentity });
    await full();
    // The last full callback is an await too. Recheck actual private custody/
    // config/copied bytes after it, before staging setup; worker fences remain.
    await verifyLocalRepositoryPreparationObjectData(
      artifact,
      context,
      operation.requestSha256,
      facts,
      factsSha256,
      packedRefs,
    );
    await mkdir(join(scratch, 'checkout'), { mode: 0o700 });
    current();
    const staging = join(scratch, 'checkout');
    await executePrivateRepositoryStagingCheckout({
      scratchAnchor,
      gitIdentity: await identity(view.gitDirectory),
      stagingIdentity: await identity(staging),
      privateAuthority: view.privateAuthority,
      baseOid: facts.baseOid,
      objectFormat: facts.source.objectFormat as 'sha1' | 'sha256',
      deniedRoots: denied,
      signal: context.signal,
      timeoutMs: 30000,
      deadline,
      assertCurrentSync: current,
      revalidate: full,
    });
    const entries: NativeExclusiveTreeEntry[] = [];
    // Git can retain empty trees and uninitialized gitlinks. Materialize any
    // missing private directories parent-first before independent identity reads.
    const directories = view.entries
      .filter((entry) => entry.mode === '040000')
      .sort((left, right) => left.path.split('/').length - right.path.split('/').length);
    for (let index = 0; index < directories.length; index += 64) {
      current();
      const wave = directories.slice(index, index + 64);
      const results = await Promise.allSettled(
        wave.map((entry) =>
          lstat(join(staging, entry.path)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return undefined;
          }),
        ),
      );
      current();
      // Preserve the depth ordering for effects; only observations overlap.
      for (let offset = 0; offset < wave.length; offset++) {
        const result = results[offset];
        if (result.status !== 'fulfilled') throw result.reason;
        if (!result.value) {
          current();
          await mkdir(join(staging, wave[offset].path), { mode: 0o700 });
          current();
        } else if (!result.value.isDirectory()) throw unavailable();
      }
    }
    // These immutable, independently owned PRIVATE staging facts are neither
    // source reads nor publication effects. Join each bounded wave before use.
    // Bound in-flight observations without multiplying the complete consumed
    // owner fence enough to exhaust its unchanged approval lifetime on large trees.
    for (let index = 0; index < view.entries.length; index += 256) {
      current();
      const results = await Promise.allSettled(
        view.entries.slice(index, index + 256).map(async (entry) => {
          context.signal.throwIfAborted();
          if (Date.now() >= deadline) throw unavailable();
          return Object.freeze({ ...entry, identity: await identity(join(staging, entry.path)) });
        }),
      );
      current();
      for (const result of results) {
        if (result.status !== 'fulfilled') throw result.reason;
        entries.push(result.value);
      }
    }
    current();
    if (facts.layout === 'standalone') {
      const git = join(scratch, 'standalone-git');
      await mkdir(git, { mode: 0o700 });
      await cp(join(view.gitDirectory, 'objects'), join(git, 'objects'), {
        recursive: true,
        dereference: false,
        force: false,
        errorOnExist: true,
      });
      await mkdir(join(git, 'refs', 'heads', 'mitzo'), { recursive: true });
      await mkdir(join(git, 'info'), { recursive: true });
      await writeFile(join(git, 'HEAD'), `ref: refs/heads/${facts.featureBranch}\n`, {
        flag: 'wx',
      });
      await writeFile(join(git, 'refs', 'heads', facts.featureBranch), facts.baseOid + '\n', {
        flag: 'wx',
      });
      await writeFile(
        join(git, 'config'),
        standaloneRepositoryCheckoutConfig(facts.source.objectFormat, facts.remote),
        { flag: 'wx' },
      );
      if (facts.shallow) await writeFile(join(git, 'shallow'), facts.shallow, { flag: 'wx' });
      await writeFile(join(git, 'info', 'attributes'), privateRepositoryCheckoutAttributes, {
        flag: 'wx',
      });
      await cp(join(view.gitDirectory, 'index'), join(git, 'index'), {
        force: false,
        errorOnExist: true,
      });
      const gitEntries: NativeExclusiveTreeEntry[] = [];
      let gitBytes = 0;
      const walk = async (directory: string, prefix = '') => {
        for (const name of await readdir(directory)) {
          current();
          const file = join(directory, name),
            path = prefix ? `${prefix}/${name}` : name;
          const info = await lstat(file);
          if (gitEntries.length >= 10000 || info.isSymbolicLink()) throw unavailable();
          if (info.isDirectory()) {
            gitEntries.push({
              path,
              mode: '040000',
              identity: await identity(file),
              size: 0,
              sha256: sha(''),
            });
            await walk(file, path);
          } else {
            if (
              !info.isFile() ||
              info.nlink !== 1 ||
              info.size > repositoryGitEntrySizeLimit(path) ||
              (gitBytes += info.size) > 128 * 1024 * 1024
            )
              throw unavailable();
            await chmod(file, 0o644);
            const bytes = await readFile(file);
            gitEntries.push({
              path,
              mode: '100644',
              identity: await identity(file),
              size: bytes.length,
              sha256: sha(bytes),
            });
          }
        }
      };
      await walk(git);
      const plan: NativePreparationPublicationPlan = {
        version: 'prepared-repository-publication-v1',
        layout: 'standalone',
        ...(facts.remote ? { remote: facts.remote } : {}),
        ...(facts.shallow ? { shallow: facts.shallow } : {}),
        requestSha256: operation.requestSha256,
        allocationFactsSha256: factsSha256,
        scopeSha256: operation.scopeSha256,
        workspaceId: facts.workspaceId,
        baseOid: facts.baseOid,
        sourcePath: facts.source.path,
        sourceAnchor: facts.source.sourceAnchor,
        commonAnchor: facts.source.commonAnchor,
        taskRoot: facts.taskRoot,
        directories: [],
        existingDirectories: [
          { directory: facts.taskRoot.rootPath, identity: facts.taskRoot.identity },
        ],
        packedRefs: { kind: 'absent' },
        tree: {
          payload: {
            file_path: staging,
            rootAnchor: scratchAnchor,
            parentIdentity: scratchAnchor.identity,
            identity: await identity(staging),
          },
          entries,
        },
        standaloneGit: {
          payload: {
            file_path: git,
            rootAnchor: scratchAnchor,
            parentIdentity: scratchAnchor.identity,
            identity: await identity(git),
          },
          entries: gitEntries,
        },
        metadata: [],
        deniedRoots: denied,
      };
      const roots = nativePreparationPublicationWriteRoots(plan);
      const transport: NativeFileHelperTransport = async (invocation) => {
        current();
        const result = await executePrivateNativeFileHelper({
          requestJson: invocation.requestJson,
          cwd: scratch,
          writableRoots: roots,
          deniedRoots: denied,
          signal: context.signal,
          timeoutMs: invocation.timeoutMs,
          deadline,
          maxOutputBytes: invocation.maxOutputBytes,
          assertCurrentSync: current,
          revalidate: full,
        });
        current();
        return { stdout: result.stdout ?? '', isError: result.isError };
      };
      publication = snapshotQualifiedLocalRepositoryPublication(
        await publishNativePreparedRepository(plan, context.signal, 30000, transport),
      );
    } else {
      const metadataFiles: NativePreparationPublicationPlan['metadata'][number][] = [];
      const publish = async (bytes: Buffer) => {
        current();
        const payload = join(scratch, `publication-${metadataFiles.length}`);
        await writeFile(payload, bytes, { flag: 'wx', mode: 0o600 });
        current();
        metadataFiles.push(
          Object.freeze({
            file_path: payload,
            rootAnchor: scratchAnchor,
            parentIdentity: scratchAnchor.identity,
            identity: await identity(payload),
            size: bytes.length,
            sha256: sha(bytes),
          }),
        );
      };
      // The generated index is an owned private output, never source index bytes.
      const indexFile = await open(
        join(view.gitDirectory, 'index'),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let index: Buffer;
      try {
        const before = await indexFile.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > 16 * 1024 * 1024)
          throw unavailable();
        index = await indexFile.readFile();
        const after = await indexFile.stat();
        if (
          index.length !== before.size ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw unavailable();
      } finally {
        await indexFile.close();
      }
      await publish(Buffer.from(`ref: refs/heads/${facts.featureBranch}\n`));
      await publish(Buffer.from('../..\n'));
      await publish(Buffer.from(join(task, '.git') + '\n'));
      await publish(index);
      await publish(Buffer.from(facts.baseOid + '\n'));
      await publish(Buffer.from(`gitdir: ${admin}\n`));
      if (!packedRefs) throw unavailable();
      const plan: NativePreparationPublicationPlan = {
        version: 'prepared-repository-publication-v1',
        requestSha256: operation.requestSha256,
        allocationFactsSha256: factsSha256,
        scopeSha256: operation.scopeSha256,
        workspaceId: facts.workspaceId,
        baseOid: facts.baseOid,
        sourcePath: facts.source.path,
        sourceAnchor: facts.source.sourceAnchor,
        commonAnchor: facts.source.commonAnchor,
        taskRoot: facts.taskRoot,
        directories: facts.directories,
        existingDirectories: facts.existingDirectories,
        packedRefs,
        tree: {
          payload: {
            file_path: staging,
            rootAnchor: scratchAnchor,
            parentIdentity: scratchAnchor.identity,
            identity: await identity(staging),
          },
          entries,
        },
        metadata: metadataFiles,
        deniedRoots: denied,
      };
      const roots = nativePreparationPublicationWriteRoots(plan);
      const transport: NativeFileHelperTransport = async (invocation) => {
        current();
        const result = await executePrivateNativeFileHelper({
          requestJson: invocation.requestJson,
          cwd: scratch,
          writableRoots: roots,
          deniedRoots: denied,
          signal: context.signal,
          timeoutMs: invocation.timeoutMs,
          deadline,
          maxOutputBytes: invocation.maxOutputBytes,
          assertCurrentSync: current,
          revalidate: full,
        });
        current();
        return { stdout: result.stdout ?? '', isError: result.isError };
      };
      publication = snapshotQualifiedLocalRepositoryPublication(
        await publishNativePreparedRepository(plan, context.signal, 30000, transport),
      );
    }
  } finally {
    try {
      await disposeArtifact();
    } finally {
      await full();
    }
  }
  if (!publication) throw unavailable();
  const taskIdentity = await read(async (access) =>
    captureQualifiedLocalRepositoryTask(access, facts, publication!),
  );
  await full();
  current();
  return Object.freeze({ publication, taskIdentity });
}

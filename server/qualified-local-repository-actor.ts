import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  captureNativeHostReadOwner,
  type NativeHostToolContext,
} from './native-host-tool-context.js';
import { captureNativeLocalRepositoryReader } from './local-repository-native-read.js';
import {
  captureLocalRepositoryAllocationFacts,
  type LocalRepositoryAllocationFacts,
} from './local-repository-allocation-facts.js';
import { LocalRepositoryReadAccess } from './local-repository-read-access.js';
import { captureLocalRepositoryPreparationObjects } from './local-repository-preparation-objects.js';
import {
  executePrivateNativeFileHelper,
  executePrivateRepositoryStagingCheckout,
} from './sandboxed-command.js';
import {
  freezeNativeReadExclusions,
  type NativeFileHelperTransport,
  type NativeReadIdentity,
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
import type { NativeExclusiveTreeEntry } from './native-tree-publication.js';

const unavailable = () => Error('Qualified repository materialization unavailable');
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const identity = async (path: string) => {
  const info = await lstat(path, { bigint: true });
  return Object.freeze({ dev: String(info.dev), ino: String(info.ino) });
};
const same = (a: NativeReadIdentity, b: NativeReadIdentity) => a.dev === b.dev && a.ino === b.ino;
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
  assertCurrentSync(): void;
  assertCurrent(): Promise<void>;
}) {
  const { context, facts, factsSha256, expiresAt } = operation;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw unavailable();
  const owner = captureNativeHostReadOwner(context);
  if (!owner || !facts.existingDirectories || facts.existingDirectories.length > 10)
    throw unavailable();
  const current = () => {
    context.signal.throwIfAborted();
    if (Date.now() >= expiresAt) throw unavailable();
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
      deadline: Date.now() + 30000,
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
  // The original immutable facts are genuinely recaptured AFTER approval, before
  // effects. No pre-approval reader lifetime or absence cache is extended.
  let packedRefs: NativePreparationPublicationPlan['packedRefs'] | undefined;
  await read(async (access, reader) => {
    const fresh = await captureLocalRepositoryAllocationFacts(reader, {
      workspaceId: facts.workspaceId,
      sourcePath: facts.source.path,
      taskRoot: facts.taskRoot.rootPath,
    });
    if (fresh.factsSha256 !== factsSha256) throw unavailable();
    packedRefs = fresh.publicationPackedRefs; // Exact parser-consumed bytes/absence, already verified by its original access.
  });
  let artifact: Awaited<ReturnType<typeof captureLocalRepositoryPreparationObjects>> | undefined;
  const task = join(facts.taskRoot.rootPath, `repo-${facts.workspaceId}`),
    common = facts.source.commonDirectory;
  const admin = join(common, 'worktrees', `repo-${facts.workspaceId}`);
  const denied = freezeNativeReadExclusions(owner.scope.deniedRoots);
  let publication: Readonly<QualifiedLocalRepositoryPublication> | undefined;
  try {
    await read(async (access, reader) => {
      const anchor = await access.pinRoot(common);
      if (!same(anchor.identity, facts.source.commonAnchor.identity)) throw unavailable();
      artifact = await captureLocalRepositoryPreparationObjects(facts.source, {
        readAccess: access,
        baseOid: facts.baseOid,
        signal: reader.signal,
        timeoutMs: Math.max(1, Math.min(30000, reader.deadline - Date.now())),
      });
    });
    if (!artifact) throw unavailable();
    const view = artifact.view,
      scratch = view.scratch;
    const scratchAnchor = Object.freeze({ rootPath: scratch, identity: await identity(scratch) });
    await full();
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
      deadline: expiresAt,
      assertCurrentSync: current,
      revalidate: full,
    });
    const entries: NativeExclusiveTreeEntry[] = [];
    for (const entry of view.entries) {
      current();
      const path = join(staging, entry.path);
      if (entry.mode === '040000') {
        // Gitlinks stay empty and uninitialized. No external commit is read.
        const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        });
        if (!existing) await mkdir(path, { mode: 0o700 });
        else if (!existing.isDirectory()) throw unavailable();
      }
      entries.push(Object.freeze({ ...entry, identity: await identity(path) }));
    }
    current();
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
        deadline: expiresAt,
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
  } finally {
    try {
      if (artifact) await artifact.dispose();
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

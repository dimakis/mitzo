import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { LocalRepositoryReadAccess } from './local-repository-read-access.js';
import type { NativeReadIdentity } from './native-file-operation.js';
import {
  isLocalRepositoryCredentialPath,
  LocalRepositoryGitInspectionError,
  type LocalRepositoryGitMetadata,
} from './local-repository-git-inspection.js';

const execute = promisify(execFile);
const env = {
  PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
};
export interface LocalRepositorySnapshotOptions {
  readAccess: LocalRepositoryReadAccess;
  signal?: AbortSignal;
  timeoutMs: number;
}
const failure = (reason: string) => new LocalRepositoryGitInspectionError('unsafe', reason);
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
function sourceReader(options: LocalRepositorySnapshotOptions) {
  const deadline = Date.now() + Math.max(1, Math.min(options.timeoutMs, 30000));
  const access = options.readAccess;
  if (!access) throw failure('read-anchor-required');
  const check = () => {
    options.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new LocalRepositoryGitInspectionError('limit', 'timeout');
  };
  const physical = async (path: string) => {
    check();
    const entry = await access.stat(path);
    if (!entry) throw Object.assign(Error('Git metadata unavailable'), { code: 'ENOENT' });
    if (entry.kind === 'unsupported') throw failure('snapshot-regular-file-required');
    return { isDirectory: () => entry.kind === 'directory' };
  };
  const read = async (path: string, limit = 16 * 1024 * 1024) => {
    check();
    const entry = await access.stat(path);
    return { buffer: await access.read(path, limit), mode: (entry?.mode ?? 0) & 0o777 };
  };
  const optional = async (path: string, limit?: number) => {
    try {
      return await read(path, limit);
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
      return undefined;
    }
  };
  return {
    check,
    authorize: (path: string) => access.assertPath(path),
    physical,
    read,
    optional,
    list: async (path: string) => (await access.list(path)).map((entry) => entry.name),
    deadline,
  };
}

type Reader = ReturnType<typeof sourceReader>;
/** A lexical omission is not physical absence on case/normalization-insensitive
 * filesystems. The existing current owner may prove missing with its same
 * nofollow directory capture; files/aliases/denials/specials are refusals. */
async function assertPhysicalReferenceAbsent(access: LocalRepositoryReadAccess, path: string) {
  try {
    await access.assertAbsent(path);
  } catch {
    throw failure('snapshot-reference-absence-unavailable');
  }
}
async function copyTree(
  source: string,
  destination: string,
  reader: Reader,
  objects = false,
  references = false,
) {
  await mkdir(destination, { recursive: true });
  for (const name of await reader.list(source)) {
    const path = join(source, name);
    // Git must never see source object-store indirections, even if introduced
    // after metadata preflight. The approved bytes are not copied at all.
    if (objects && ['alternates', 'http-alternates'].includes(name)) {
      const value = await reader.read(path, 65536);
      if (value.buffer.toString('utf8').trim()) throw failure('alternate-storage-unavailable');
      continue;
    }
    const stat = await reader.physical(path);
    if (stat.isDirectory())
      await copyTree(path, join(destination, name), reader, objects, references);
    else {
      const value = await reader.read(path);
      if (references) headValue(value.buffer);
      await writeFile(join(destination, name), value.buffer, { mode: value.mode });
    }
  }
}

async function privateContext<T>(
  metadata: LocalRepositoryGitMetadata,
  options: LocalRepositorySnapshotOptions,
  action: (context: {
    scratch: string;
    gitDirectory: string;
    reader: Reader;
    git: (...args: string[]) => Promise<string>;
  }) => Promise<T>,
  referenceView: 'all' | 'preparation' = 'all',
) {
  if (options.readAccess.preparationObservationOnly && referenceView !== 'preparation')
    throw failure('preparation-observation-only');
  if (
    referenceView !== 'preparation' &&
    (metadata.referenceCoverage || metadata.qualification === 'preparation')
  )
    throw failure('preparation-reference-view-unavailable');
  if (
    referenceView === 'preparation' &&
    !['references', 'preparation'].includes(metadata.qualification ?? '')
  )
    throw failure('preparation-reference-view-required');
  const reader = sourceReader(options);
  let scratch: string | undefined;
  try {
    await reader.authorize(metadata.path);
    scratch = await mkdtemp(join(tmpdir(), 'mitzo-git-inspection-'));
    const gitDirectory = join(scratch, '.git');
    const git = async (...args: string[]) => {
      reader.check();
      try {
        const { stdout } = await execute('git', args, {
          cwd: scratch,
          env: {
            ...env,
            GIT_DIR: gitDirectory,
            GIT_WORK_TREE: scratch,
            GIT_OBJECT_DIRECTORY: join(gitDirectory, 'objects'),
          },
          encoding: 'utf8',
          signal: options.signal,
          timeout: Math.max(1, reader.deadline - Date.now()),
          maxBuffer: 262144,
        });
        await reader.authorize(metadata.path);
        return stdout;
      } catch (error) {
        options.signal?.throwIfAborted();
        if (error instanceof LocalRepositoryGitInspectionError) throw error;
        // Subprocess diagnostics may contain copied private metadata or scratch
        // paths. Only bounded product-owned reasons cross this boundary.
        throw failure(
          code(error) === 'ENOENT' ? 'snapshot-git-unavailable' : 'snapshot-git-rejected',
        );
      }
    };
    if (!['sha1', 'sha256'].includes(metadata.objectFormat))
      throw failure('object-format-unsupported');
    await git(
      'init',
      '--quiet',
      '--template=',
      '--initial-branch=mitzo-inspect',
      `--object-format=${metadata.objectFormat}`,
      scratch,
    );
    const head = await reader.optional(join(metadata.gitDirectory, 'HEAD'), 4096);
    if (!head) throw failure('snapshot-head-unavailable');
    headValue(head.buffer);
    await writeFile(join(gitDirectory, 'HEAD'), head.buffer);
    const refs = join(metadata.commonDirectory, 'refs');
    if (referenceView === 'all') {
      if (await options.readAccess.stat(refs))
        await copyTree(refs, join(gitDirectory, 'refs'), reader, false, true);
    } else {
      // Copy only the actual bounded symbolic chain. Existing Git below still
      // resolves/validates the final HEAD/branch/OID; no unrelated ref OID is
      // fabricated, inferred or read. Packed refs remain independently bounded.
      let reference = headValue(head.buffer).ref;
      const seen = new Set<string>();
      while (reference) {
        if (seen.has(reference) || seen.size >= 16) throw failure('snapshot-reference-unsupported');
        seen.add(reference);
        const value = await reader.optional(join(metadata.commonDirectory, reference), 4096);
        if (!value) {
          await assertPhysicalReferenceAbsent(
            options.readAccess,
            join(metadata.commonDirectory, reference),
          );
          break;
        }
        const next = headValue(value.buffer);
        const destination = join(gitDirectory, reference);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, value.buffer, { mode: value.mode });
        reference = next.ref;
      }
    }
    const packed = await reader.optional(
      join(metadata.commonDirectory, 'packed-refs'),
      16 * 1024 * 1024,
    );
    if (packed) {
      for (const line of packed.buffer.toString('utf8').split('\n').filter(Boolean)) {
        if (line.startsWith('#')) continue;
        if (/^\^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(line)) continue;
        const match = /^([a-f0-9]{40}(?:[a-f0-9]{24})?) (refs\/[^\r\n\0]+)$/.exec(line);
        if (!match) throw failure('snapshot-reference-unsupported');
        headValue(Buffer.from(`ref: ${match[2]}`));
      }
      await writeFile(join(gitDirectory, 'packed-refs'), packed.buffer);
    } else if (referenceView === 'preparation')
      await assertPhysicalReferenceAbsent(
        options.readAccess,
        join(metadata.commonDirectory, 'packed-refs'),
      );
    const result = await action({ scratch, gitDirectory, reader, git });
    await reader.authorize(metadata.path);
    return result;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof LocalRepositoryGitInspectionError) throw error;
    throw failure('snapshot-unavailable');
  } finally {
    if (scratch) {
      await rm(scratch, { recursive: true, force: true }).catch(() => {
        throw failure('snapshot-cleanup-unavailable');
      });
    }
  }
}

function headValue(buffer: Buffer) {
  const value = buffer.toString('utf8').trimEnd();
  if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) return { oid: value };
  const ref = /^ref: (refs\/[^\r\n\0]+)$/.exec(value)?.[1];
  if (
    !ref ||
    ref.length > 4096 ||
    Buffer.byteLength(ref) > 4096 ||
    /[~^:?*\\]/.test(ref) ||
    ref
      .split('')
      .some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) ||
    ref.includes('[') ||
    ref.includes('@{') ||
    ref.endsWith('.') ||
    ref.includes('..') ||
    ref.includes('//') ||
    ref.endsWith('/') ||
    ref.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
  )
    throw failure('snapshot-reference-unsupported');
  return { ref };
}

async function resolveHeadFacts(
  metadata: LocalRepositoryGitMetadata,
  options: LocalRepositorySnapshotOptions,
  git: (...args: string[]) => Promise<string>,
  reader: Reader,
) {
  const value = headValue((await reader.read(join(metadata.gitDirectory, 'HEAD'), 4096)).buffer);
  const branch = (await git('branch', '--show-current')).trim() || null;
  let head: string | null = null;
  try {
    head = (await git('rev-parse', '--verify', 'HEAD')).trim();
  } catch (error) {
    if (!value.ref || (await options.readAccess.stat(join(metadata.commonDirectory, value.ref))))
      throw error; // Only a missing symbolic ref is unborn.
  }
  if (head !== null && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head))
    throw failure('snapshot-reference-unsupported');
  return { branch, head };
}

export async function readLocalRepositoryGitFacts(
  metadata: LocalRepositoryGitMetadata,
  options: LocalRepositorySnapshotOptions,
) {
  return privateContext(metadata, options, ({ git, reader }) =>
    resolveHeadFacts(metadata, options, git, reader),
  );
}

export interface LocalRepositoryOwnedPreparationReference {
  readonly identity: NativeReadIdentity;
  readonly oid: string;
}
function ownedPreparationReference(value: LocalRepositoryOwnedPreparationReference) {
  const data = (object: unknown, keys: string[]) => {
    if (
      !object ||
      typeof object !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(object))
    )
      throw failure('snapshot-reference-unsupported');
    const descriptors = Object.getOwnPropertyDescriptors(object);
    if (
      Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => !descriptors[key] || !('value' in descriptors[key]))
    )
      throw failure('snapshot-reference-unsupported');
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  };
  const captured = data(value, ['identity', 'oid']);
  const identity = data(captured.identity, ['dev', 'ino']);
  if (
    typeof captured.oid !== 'string' ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(captured.oid) ||
    ![identity.dev, identity.ino].every(
      (entry) => typeof entry === 'string' && /^\d{1,32}$/.test(entry),
    )
  )
    throw failure('snapshot-reference-unsupported');
  return Object.freeze({
    oid: captured.oid as string,
    identity: Object.freeze({ dev: identity.dev as string, ino: identity.ino as string }),
  });
}

/** Narrow physical base observation only. The existing private copy/parser
 * still resolves Git's actual HEAD; no branch namespace coverage is returned. */
export async function readLocalRepositoryPreparationBaseReferences(
  metadata: LocalRepositoryGitMetadata,
  options: LocalRepositorySnapshotOptions,
) {
  if (
    !options.readAccess.preparationObservationOnly ||
    metadata.baseObservationCoverage !== 'preparation-base-observation-v1'
  )
    throw failure('preparation-observation-required');
  return privateContext(
    metadata,
    options,
    async ({ git, reader }) =>
      Object.freeze({
        ...(await resolveHeadFacts(metadata, options, git, reader)),
        referenceCoverage: 'preparation-base-observation-v1' as const,
      }),
    'preparation',
  );
}

/** Explicit preparation-only coverage. Unrelated loose ref CONTENT is not
 * consumed; no arbitrary-ref OID/all-ref/object/status qualification is made. */
export async function readLocalRepositoryPreparationReferences(
  metadata: LocalRepositoryGitMetadata,
  options: LocalRepositorySnapshotOptions,
  candidateReference?: string,
  expectedOwned?: LocalRepositoryOwnedPreparationReference,
) {
  if (options.readAccess.preparationObservationOnly) throw failure('preparation-observation-only');
  const owned = expectedOwned === undefined ? undefined : ownedPreparationReference(expectedOwned);
  if (owned && candidateReference === undefined) throw failure('snapshot-reference-unsupported');
  if (
    candidateReference !== undefined &&
    (!candidateReference.startsWith('refs/heads/') ||
      headValue(Buffer.from(`ref: ${candidateReference}`)).ref !== candidateReference)
  )
    throw failure('snapshot-reference-unsupported');
  return privateContext(
    metadata,
    options,
    async ({ git, reader }) => {
      const facts = await resolveHeadFacts(metadata, options, git, reader);
      let conflict = false;
      if (candidateReference !== undefined) {
        const names = (await git('for-each-ref', '--format=%(refname)', 'refs/heads'))
          .split('\n')
          .filter(Boolean);
        for (const name of names) headValue(Buffer.from(`ref: ${name}`));
        conflict = names.some(
          (name) =>
            name === candidateReference ||
            name.startsWith(candidateReference + '/') ||
            candidateReference.startsWith(name + '/'),
        );
        const candidate = join(metadata.commonDirectory, candidateReference);
        await options.readAccess.assertPath(candidate);
        let directory = join(metadata.commonDirectory, 'refs', 'heads');
        const base = await options.readAccess.stat(directory);
        if (!base) await assertPhysicalReferenceAbsent(options.readAccess, directory);
        if (base && base.kind !== 'directory') throw failure('snapshot-reference-unsupported');
        if (base) {
          const parts = candidateReference.slice('refs/heads/'.length).split('/');
          for (let index = 0; index < parts.length; index++) {
            const path = join(directory, parts[index]);
            await options.readAccess.assertPath(path);
            const entry = await options.readAccess.stat(path);
            if (!entry) {
              await assertPhysicalReferenceAbsent(options.readAccess, path);
              break;
            }
            if (entry.kind === 'unsupported') throw failure('snapshot-reference-unsupported');
            // Ordinary ancestor directories are legitimate namespaces. Existing
            // ancestor files or ANY exact target entry cannot be adopted/removed.
            if (entry.kind === 'file' || index === parts.length - 1) {
              // A phase may recognize ONLY the exact loose file it exclusively
              // created. Existing packed names remain conflicts; this never
              // clears them or turns foreign directories/files into custody.
              const ours =
                index === parts.length - 1 &&
                entry.kind === 'file' &&
                owned &&
                entry.identity.dev === owned.identity.dev &&
                entry.identity.ino === owned.identity.ino &&
                (await options.readAccess.read(path, 4096)).equals(Buffer.from(owned.oid + '\n'));
              if (!ours) conflict = true;
              break;
            }
            directory = path;
          }
        }
      }
      return Object.freeze({
        ...facts,
        conflict,
        referenceCoverage: 'preparation-head-and-namespace-v1' as const,
      });
    },
    'preparation',
  );
}

/** Private copied-ref qualification only. The source paths/config never enter Git. */
export async function hasLocalRepositoryReferenceConflict(
  metadata: LocalRepositoryGitMetadata,
  options: LocalRepositorySnapshotOptions,
  reference: string,
) {
  if (headValue(Buffer.from(`ref: ${reference}`)).ref !== reference)
    throw failure('snapshot-reference-unsupported');
  return privateContext(metadata, options, async ({ git }) => {
    const names = (await git('for-each-ref', '--format=%(refname)', 'refs/heads'))
      .split('\n')
      .filter(Boolean);
    for (const name of names) headValue(Buffer.from(`ref: ${name}`));
    return names.some(
      (name) =>
        name === reference || name.startsWith(reference + '/') || reference.startsWith(name + '/'),
    );
  });
}

/** Registry pointer strings are facts only. Git never receives those source
 * paths or probes another worktree through them. No ownership claim is made. */
export async function readLocalRepositoryWorktrees(
  metadata: LocalRepositoryGitMetadata,
  options: LocalRepositorySnapshotOptions,
) {
  return privateContext(metadata, options, async ({ git, reader }) => {
    const facts = async (directory: string, path: string) => {
      const value = headValue((await reader.read(join(directory, 'HEAD'), 4096)).buffer);
      let head = value.oid;
      if (value.ref) {
        try {
          head = (await git('rev-parse', '--verify', value.ref)).trim();
        } catch {
          options.signal?.throwIfAborted();
        }
      }
      const locked = !!(await reader.optional(join(directory, 'locked'), 65536));
      await reader.authorize(path);
      return { path, head, ...(value.ref ? { branch: value.ref } : {}), locked };
    };
    const worktrees = [
      await facts(
        metadata.commonDirectory,
        metadata.commonDirectory === metadata.gitDirectory
          ? metadata.path
          : basename(metadata.commonDirectory) === '.git'
            ? dirname(metadata.commonDirectory)
            : metadata.path,
      ),
    ];
    const registry = join(metadata.commonDirectory, 'worktrees');
    let names: string[];
    try {
      // Only authorized definite absence may retain the current worktree alone.
      // ListDirectory refuses nonexistent/non-directory targets without ENOENT.
      if (!(await reader.physical(registry)).isDirectory())
        throw failure('snapshot-worktree-registry-unsupported');
      names = await reader.list(registry);
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
      return worktrees;
    }
    for (const name of names) {
      const directory = join(registry, name);
      const pointer = (await reader.read(join(directory, 'gitdir'), 4096)).buffer.toString('utf8');
      if (!/^[^\r\n\0]+\r?\n?$/.test(pointer))
        throw failure('snapshot-worktree-pointer-unsupported');
      const gitdir = resolve(directory, pointer.trimEnd());
      if (basename(gitdir) !== '.git' || isLocalRepositoryCredentialPath(gitdir))
        throw failure('snapshot-worktree-pointer-unsupported');
      worktrees.push(await facts(directory, dirname(gitdir)));
    }
    return worktrees;
  });
}

/** Full bounded copies are required for status: even stat/hash/ignore reads may
 * not bypass the current per-path owner. Any incomplete copy fails closed. */
export async function readLocalRepositorySnapshotStatus(
  metadata: LocalRepositoryGitMetadata,
  options: LocalRepositorySnapshotOptions,
) {
  if (options.readAccess.preparationObservationOnly) throw failure('preparation-observation-only');
  if (metadata.qualification) throw failure('reference-only-metadata');
  if (metadata.comparisonConfig.unsupported) throw failure('comparison-configuration-unsupported');
  return privateContext(metadata, options, async ({ scratch, gitDirectory, reader, git }) => {
    if (await options.readAccess.stat(join(metadata.gitDirectory, 'info', 'sparse-checkout')))
      throw failure('snapshot-sparse-index-unavailable');
    await copyTree(
      join(metadata.commonDirectory, 'objects'),
      join(gitDirectory, 'objects'),
      reader,
      true,
    );
    for (const entry of await options.readAccess.list(metadata.gitDirectory)) {
      if (entry.name.startsWith('sharedindex.')) throw failure('snapshot-split-index-unavailable');
    }
    for (const name of ['index', 'shallow']) {
      const value = await reader.optional(
        join(name === 'index' ? metadata.gitDirectory : metadata.commonDirectory, name),
        16 * 1024 * 1024,
      );
      if (value) await writeFile(join(gitDirectory, name), value.buffer);
    }
    // Preserve the approved nonzero timestamp fix: copied cached stat data must
    // never hide same-size edits on coarse-stat Git builds/filesystems.
    try {
      await utimes(join(gitDirectory, 'index'), 1, 1);
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
    }
    const excluded = await reader.optional(
      join(metadata.commonDirectory, 'info', 'exclude'),
      65536,
    );
    if (excluded) {
      await mkdir(join(gitDirectory, 'info'), { recursive: true });
      await writeFile(join(gitDirectory, 'info', 'exclude'), excluded.buffer);
    }
    const staged = (await git('ls-files', '--cached', '--stage', '-z')).split('\0').filter(Boolean);
    const gitlinks = new Set<string>();
    for (const entry of staged) {
      const tab = entry.indexOf('\t');
      const path = entry.slice(tab + 1);
      const suffix = relative(scratch, resolve(scratch, path));
      if (
        tab < 0 ||
        isAbsolute(path) ||
        suffix === '..' ||
        suffix.startsWith(`..${sep}`) ||
        suffix.split(sep).includes('.git')
      )
        throw failure('snapshot-index-path-unsupported');
      if (entry.startsWith('040000 ')) throw failure('snapshot-sparse-index-unavailable');
      if (entry.startsWith('160000 ')) gitlinks.add(path);
    }
    const copyWorktree = async (source: string, destination: string) => {
      for (const name of await reader.list(source)) {
        // Even a tracked attribute file can refer to a filter provided only by
        // deliberately omitted global config. No local filter key proves its
        // absence. Refuse comparison rather than execute or parse attributes.
        if (name === '.gitattributes') throw failure('comparison-attributes-unsupported');
        if (name === '.git' && source === metadata.path) continue;
        if (name === '.git') throw failure('snapshot-nested-repository-unavailable');
        const path = join(source, name);
        const stat = await reader.physical(path);
        if (stat.isDirectory()) {
          await mkdir(join(destination, name));
          // Tracked gitlinks are ignored without entering their repository,
          // loading their configuration or granting any authority to them.
          if (gitlinks.has(relative(metadata.path, path))) continue;
          await copyWorktree(path, join(destination, name));
        } else {
          const value = await reader.read(path);
          await writeFile(join(destination, name), value.buffer, { mode: value.mode });
        }
      }
    };
    await copyWorktree(metadata.path, scratch);
    return git(
      '-c',
      'core.fsmonitor=false',
      ...(metadata.comparisonConfig.coreAutocrlf !== undefined
        ? ['-c', `core.autocrlf=${metadata.comparisonConfig.coreAutocrlf}`]
        : []),
      ...(metadata.comparisonConfig.coreFileMode !== undefined
        ? ['-c', `core.filemode=${metadata.comparisonConfig.coreFileMode}`]
        : []),
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.attributesFile=/dev/null',
      '-c',
      'core.excludesFile=/dev/null',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
      '--ignore-submodules=all',
    );
  });
}

import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { standaloneRepositoryCheckoutConfig } from './private-repository-checkout.js';
import {
  validateLocalRepositoryRemote,
  validateLocalRepositoryShallow,
} from './local-repository-base.js';
import { isDeepStrictEqual } from 'node:util';
import type { LocalRepositoryAllocationFacts } from './local-repository-allocation-facts.js';
import type {
  NativeExclusiveFilePayload,
  NativeFileHelperTransport,
  NativeReadAnchor,
  NativeReadIdentity,
} from './native-file-operation.js';
import {
  projectNativeRepositoryTreeEntries,
  projectNativeRepositoryGitTreeEntries,
  rejectNativeTreeExclusions,
  type NativeExclusiveTreeRequest,
} from './native-tree-publication.js';
import type { QualifiedLocalRepositoryPublication } from './qualified-local-repository-task.js';

export interface NativePreparationPublicationPlan {
  readonly version: 'prepared-repository-publication-v1';
  readonly layout?: 'standalone';
  readonly standaloneGit?: NativePreparationPublicationPlan['tree'];
  readonly remote?: string;
  readonly shallow?: string;
  readonly requestSha256: string;
  readonly allocationFactsSha256: string;
  readonly scopeSha256: string;
  readonly workspaceId: string;
  readonly baseOid: string;
  readonly sourcePath: string;
  readonly sourceAnchor: NativeReadAnchor;
  readonly commonAnchor: NativeReadAnchor;
  readonly taskRoot: NativeReadAnchor;
  readonly directories: readonly LocalRepositoryAllocationFacts['directories'][number][];
  readonly existingDirectories: readonly NonNullable<
    LocalRepositoryAllocationFacts['existingDirectories']
  >[number][];
  readonly packedRefs:
    | { readonly kind: 'absent' }
    | {
        readonly kind: 'file';
        readonly identity: NativeReadIdentity;
        readonly size: number;
        readonly sha256: string;
      };
  readonly tree: {
    readonly payload: NativeExclusiveTreeRequest['payload'];
    readonly entries: NativeExclusiveTreeRequest['entries'];
  };
  /** Fixed order HEAD, commondir, gitdir, index, owned branch ref, task .git. */
  readonly metadata: readonly NativeExclusiveFilePayload[];
  readonly deniedRoots: readonly string[];
}
const unavailable = (cause?: unknown) =>
  Error('Prepared repository publication unavailable', { cause });
const within = (child: string, parent: string) =>
  child === parent || child.startsWith(parent === '/' ? '/' : parent + '/');
function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
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
}
function array(value: unknown, max: number): unknown[] {
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
}
function path(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value === '/' ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    Buffer.byteLength(value) > 4096 ||
    value.split('/').length > 128 ||
    /[\0\r\n]/.test(value)
  )
    throw unavailable();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw unavailable();
  return value;
}
function identity(value: unknown): NativeReadIdentity {
  const item = data(value, ['dev', 'ino']);
  if (![item.dev, item.ino].every((part) => typeof part === 'string' && /^\d{1,32}$/.test(part)))
    throw unavailable();
  return Object.freeze(item as unknown as NativeReadIdentity);
}
function anchor(value: unknown): NativeReadAnchor {
  const item = data(value, ['rootPath', 'identity']);
  return Object.freeze({ rootPath: path(item.rootPath), identity: identity(item.identity) });
}
function payload(value: unknown, max: number): NativeExclusiveFilePayload {
  const item = data(value, [
    'file_path',
    'rootAnchor',
    'parentIdentity',
    'identity',
    'size',
    'sha256',
  ]);
  if (!Number.isSafeInteger(item.size) || (item.size as number) < 0 || (item.size as number) > max)
    throw unavailable();
  const root = anchor(item.rootAnchor),
    file = path(item.file_path),
    parent = identity(item.parentIdentity);
  if (dirname(file) !== root.rootPath || !isDeepStrictEqual(parent, root.identity))
    throw unavailable();
  return Object.freeze({
    file_path: file,
    rootAnchor: root,
    parentIdentity: parent,
    identity: identity(item.identity),
    size: item.size as number,
    sha256: digest(item.sha256),
  });
}
export function nativePreparationPublicationTargets(
  plan: Readonly<NativePreparationPublicationPlan>,
) {
  if (plan.layout === 'standalone') {
    const task = join(plan.taskRoot.rootPath, `repo-${plan.workspaceId}`);
    return Object.freeze({
      task,
      admin: join(task, '.git'),
      reference: join(task, '.git', 'refs', 'heads', 'mitzo', `repo-${plan.workspaceId}`),
      files: Object.freeze([] as string[]),
    });
  }
  const common = plan.commonAnchor.rootPath,
    task = join(plan.taskRoot.rootPath, `repo-${plan.workspaceId}`),
    admin = join(common, 'worktrees', `repo-${plan.workspaceId}`),
    reference = join(common, 'refs', 'heads', 'mitzo', `repo-${plan.workspaceId}`);
  return Object.freeze({
    task,
    admin,
    reference,
    files: Object.freeze([
      join(admin, 'HEAD'),
      join(admin, 'commondir'),
      join(admin, 'gitdir'),
      join(admin, 'index'),
      reference,
      join(task, '.git'),
    ]),
  });
}
function directorySteps(plan: Readonly<NativePreparationPublicationPlan>) {
  if (plan.layout === 'standalone') return [];
  const { admin } = nativePreparationPublicationTargets(plan),
    parentPath = dirname(admin);
  const existing = plan.existingDirectories.find((entry) => entry.directory === parentPath);
  return [
    ...plan.directories,
    Object.freeze({
      directory: admin,
      rootAnchor: plan.commonAnchor,
      parent: existing
        ? Object.freeze({
            kind: 'existing' as const,
            directory: parentPath,
            identity: existing.identity,
          })
        : Object.freeze({ kind: 'created' as const, directory: parentPath }),
    }),
  ];
}
function pythonJson(value: unknown): string {
  if (typeof value === 'string')
    return JSON.stringify(value).replace(
      /[\u007f-\uffff]/g,
      (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'),
    );
  if (Array.isArray(value)) return '[' + value.map(pythonJson).join(', ') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .map(([key, item]) => pythonJson(key) + ': ' + pythonJson(item))
        .join(', ') +
      '}'
    );
  return JSON.stringify(value);
}
function projectStandalonePlan(input: unknown): Readonly<NativePreparationPublicationPlan> {
  const remoteProperty =
    input && typeof input === 'object'
      ? Object.getOwnPropertyDescriptor(input, 'remote')
      : undefined;
  if (remoteProperty && (!('value' in remoteProperty) || typeof remoteProperty.value !== 'string'))
    throw unavailable();
  const shallowProperty =
    input && typeof input === 'object'
      ? Object.getOwnPropertyDescriptor(input, 'shallow')
      : undefined;
  if (
    shallowProperty &&
    (!('value' in shallowProperty) || typeof shallowProperty.value !== 'string')
  )
    throw unavailable();
  const item = data(input, [
    'version',
    'layout',
    'standaloneGit',
    'requestSha256',
    'allocationFactsSha256',
    'scopeSha256',
    'workspaceId',
    'baseOid',
    'sourcePath',
    'sourceAnchor',
    'commonAnchor',
    'taskRoot',
    'directories',
    'existingDirectories',
    'packedRefs',
    'tree',
    'metadata',
    'deniedRoots',
    ...(remoteProperty ? ['remote'] : []),
    ...(shallowProperty ? ['shallow'] : []),
  ]);
  const remote = remoteProperty ? validateLocalRepositoryRemote(remoteProperty.value) : undefined;
  if (
    item.version !== 'prepared-repository-publication-v1' ||
    typeof item.workspaceId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      item.workspaceId,
    ) ||
    typeof item.baseOid !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.baseOid)
  )
    throw unavailable();
  const sourcePath = path(item.sourcePath),
    sourceAnchor = anchor(item.sourceAnchor),
    commonAnchor = anchor(item.commonAnchor),
    taskRoot = anchor(item.taskRoot);
  if (
    sourcePath !== sourceAnchor.rootPath ||
    within(taskRoot.rootPath, sourcePath) ||
    within(taskRoot.rootPath, commonAnchor.rootPath) ||
    array(item.directories, 0).length ||
    array(item.metadata, 0).length
  )
    throw unavailable();
  const existing = array(item.existingDirectories, 1).map((value) => {
    const entry = data(value, ['directory', 'identity']);
    return Object.freeze({ directory: path(entry.directory), identity: identity(entry.identity) });
  });
  if (
    existing.length !== 1 ||
    existing[0].directory !== taskRoot.rootPath ||
    !isDeepStrictEqual(existing[0].identity, taskRoot.identity)
  )
    throw unavailable();
  const deniedRoots = Object.freeze(
    array(item.deniedRoots, 256).map((value) => (value === '/' ? '/' : path(value))),
  );
  const projectTree = (value: unknown, gitContainers = false) => {
    const tree = data(value, ['payload', 'entries']),
      staged = data(tree.payload, ['file_path', 'rootAnchor', 'parentIdentity', 'identity']);
    const root = anchor(staged.rootAnchor),
      directory = path(staged.file_path),
      parent = identity(staged.parentIdentity);
    if (
      dirname(directory) !== root.rootPath ||
      !isDeepStrictEqual(parent, root.identity) ||
      [sourcePath, commonAnchor.rootPath, taskRoot.rootPath].some(
        (target) => within(root.rootPath, target) || within(target, root.rootPath),
      )
    )
      throw unavailable();
    rejectNativeTreeExclusions(
      [sourcePath, commonAnchor.rootPath, taskRoot.rootPath, directory],
      deniedRoots,
    );
    return Object.freeze({
      payload: Object.freeze({
        file_path: directory,
        rootAnchor: root,
        parentIdentity: parent,
        identity: identity(staged.identity),
      }),
      entries: gitContainers
        ? projectNativeRepositoryGitTreeEntries(tree.entries)
        : projectNativeRepositoryTreeEntries(tree.entries),
    });
  };
  const tree = projectTree(item.tree),
    standaloneGit = projectTree(item.standaloneGit, true);
  if (
    !isDeepStrictEqual(tree.payload.rootAnchor, standaloneGit.payload.rootAnchor) ||
    tree.payload.file_path === standaloneGit.payload.file_path
  )
    throw unavailable();
  const shallow = shallowProperty
    ? validateLocalRepositoryShallow(
        shallowProperty.value,
        (item.baseOid as string).length === 64 ? 'sha256' : 'sha1',
      )
    : standaloneGit.entries.some((entry) => entry.path === 'shallow')
      ? item.baseOid + '\n'
      : undefined;
  if (shallowProperty && shallow !== shallowProperty.value) throw unavailable();
  const branch = `refs/heads/mitzo/repo-${item.workspaceId}`;
  const expected = new Map([
    ['HEAD', `ref: ${branch}\n`],
    [branch, item.baseOid + '\n'],
    [
      'config',
      standaloneRepositoryCheckoutConfig(item.baseOid.length === 64 ? 'sha256' : 'sha1', remote),
    ],
  ]);
  if (shallow) expected.set('shallow', shallow);
  const allowedDirectory = (name: string) =>
    [
      'refs',
      'refs/heads',
      'refs/heads/mitzo',
      'objects',
      'objects/pack',
      'objects/info',
      'info',
    ].includes(name) || /^objects\/[a-f0-9]{2}$/.test(name);
  for (const entry of standaloneGit.entries) {
    if (
      entry.mode === '040000'
        ? !allowedDirectory(entry.path)
        : entry.mode !== '100644' ||
          !(
            expected.has(entry.path) ||
            ['index', 'info/attributes'].includes(entry.path) ||
            /^objects\/(?:[a-f0-9]{2}\/[a-f0-9]{38,62}|pack\/pack-[a-f0-9]{40,64}\.(?:pack|idx))$/.test(
              entry.path,
            )
          )
    )
      throw unavailable();
    const text = expected.get(entry.path);
    if (
      text !== undefined &&
      (entry.size !== Buffer.byteLength(text) ||
        entry.sha256 !== createHash('sha256').update(text).digest('hex'))
    )
      throw unavailable();
  }
  if (
    [...expected.keys()].some((name) => !standaloneGit.entries.some((entry) => entry.path === name))
  )
    throw unavailable();
  const plan: NativePreparationPublicationPlan = Object.freeze({
    version: 'prepared-repository-publication-v1',
    layout: 'standalone',
    standaloneGit,
    ...(remote ? { remote } : {}),
    ...(shallow ? { shallow } : {}),
    requestSha256: digest(item.requestSha256),
    allocationFactsSha256: digest(item.allocationFactsSha256),
    scopeSha256: digest(item.scopeSha256),
    workspaceId: item.workspaceId,
    baseOid: item.baseOid,
    sourcePath,
    sourceAnchor,
    commonAnchor,
    taskRoot,
    directories: Object.freeze([]),
    existingDirectories: Object.freeze(existing),
    packedRefs: Object.freeze({ kind: 'absent' }),
    tree,
    metadata: Object.freeze([]),
    deniedRoots,
  });
  if (Buffer.byteLength(JSON.stringify(plan)) > 2 * 1024 * 1024) throw unavailable();
  return plan;
}
/** Plain bounded fixed phase DATA, not an operation list or authority producer. */
export function projectNativePreparationPublicationPlan(
  input: unknown,
): Readonly<NativePreparationPublicationPlan> {
  const layout =
    input && typeof input === 'object'
      ? Object.getOwnPropertyDescriptor(input, 'layout')
      : undefined;
  if (layout) {
    if (!('value' in layout) || layout.value !== 'standalone') throw unavailable();
    return projectStandalonePlan(input);
  }
  const item = data(input, [
    'version',
    'requestSha256',
    'allocationFactsSha256',
    'scopeSha256',
    'workspaceId',
    'baseOid',
    'sourcePath',
    'sourceAnchor',
    'commonAnchor',
    'taskRoot',
    'directories',
    'existingDirectories',
    'packedRefs',
    'tree',
    'metadata',
    'deniedRoots',
  ]);
  if (
    item.version !== 'prepared-repository-publication-v1' ||
    typeof item.workspaceId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      item.workspaceId,
    ) ||
    typeof item.baseOid !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.baseOid)
  )
    throw unavailable();
  const commonAnchor = anchor(item.commonAnchor),
    taskRoot = anchor(item.taskRoot),
    sourceAnchor = anchor(item.sourceAnchor),
    sourcePath = path(item.sourcePath);
  if (
    sourcePath !== sourceAnchor.rootPath ||
    within(taskRoot.rootPath, sourcePath) ||
    within(taskRoot.rootPath, commonAnchor.rootPath)
  )
    throw unavailable();
  const deniedRoots = Object.freeze(
    array(item.deniedRoots, 256).map((value) => (value === '/' ? '/' : path(value))),
  );
  if (Buffer.byteLength(JSON.stringify(deniedRoots)) > 65536) throw unavailable();
  const existingDirectories = Object.freeze(
    array(item.existingDirectories, 10).map((value) => {
      const entry = data(value, ['directory', 'identity']);
      return Object.freeze({
        directory: path(entry.directory),
        identity: identity(entry.identity),
      });
    }),
  );
  const known = new Map(existingDirectories.map((entry) => [entry.directory, entry.identity]));
  if (
    known.size !== existingDirectories.length ||
    !isDeepStrictEqual(known.get(commonAnchor.rootPath), commonAnchor.identity) ||
    !isDeepStrictEqual(known.get(taskRoot.rootPath), taskRoot.identity)
  )
    throw unavailable();
  const created = new Set<string>();
  const allowed = new Set([
    join(taskRoot.rootPath, `repo-${item.workspaceId}`),
    ...[
      'worktrees',
      'refs',
      'refs/heads',
      'refs/heads/mitzo',
      'logs',
      'logs/refs',
      'logs/refs/heads',
      'logs/refs/heads/mitzo',
    ].map((name) => join(commonAnchor.rootPath, name)),
  ]);
  if (
    existingDirectories.some(
      (entry) =>
        ![commonAnchor.rootPath, taskRoot.rootPath].includes(entry.directory) &&
        !allowed.has(entry.directory),
    )
  )
    throw unavailable();
  const directories = Object.freeze(
    array(item.directories, 9).map((value) => {
      const entry = data(value, ['directory', 'rootAnchor', 'parent']),
        directory = path(entry.directory),
        root = anchor(entry.rootAnchor);
      const kind = Object.getOwnPropertyDescriptor(entry.parent, 'kind');
      if (!kind || !('value' in kind) || !['existing', 'created'].includes(kind.value))
        throw unavailable();
      const parent = data(
        entry.parent,
        kind.value === 'existing' ? ['kind', 'directory', 'identity'] : ['kind', 'directory'],
      );
      if (
        !allowed.has(directory) ||
        known.has(directory) ||
        created.has(directory) ||
        path(parent.directory) !== dirname(directory) ||
        !isDeepStrictEqual(
          root,
          directory === join(taskRoot.rootPath, `repo-${item.workspaceId}`)
            ? taskRoot
            : commonAnchor,
        )
      )
        throw unavailable();
      if (
        parent.kind === 'existing'
          ? !isDeepStrictEqual(known.get(parent.directory as string), identity(parent.identity))
          : !created.has(parent.directory as string)
      )
        throw unavailable();
      created.add(directory);
      return Object.freeze({
        directory,
        rootAnchor: root,
        parent: Object.freeze(
          parent.kind === 'existing'
            ? {
                kind: 'existing' as const,
                directory: parent.directory as string,
                identity: identity(parent.identity),
              }
            : { kind: 'created' as const, directory: parent.directory as string },
        ),
      });
    }),
  );
  if (
    !created.has(join(taskRoot.rootPath, `repo-${item.workspaceId}`)) ||
    (!known.has(join(commonAnchor.rootPath, 'worktrees')) &&
      !created.has(join(commonAnchor.rootPath, 'worktrees')))
  )
    throw unavailable();
  const packedKind = Object.getOwnPropertyDescriptor(item.packedRefs, 'kind');
  if (!packedKind || !('value' in packedKind)) throw unavailable();
  let packedRefs: NativePreparationPublicationPlan['packedRefs'];
  if (packedKind.value === 'absent') {
    data(item.packedRefs, ['kind']);
    packedRefs = Object.freeze({ kind: 'absent' });
  } else {
    const packed = data(item.packedRefs, ['kind', 'identity', 'size', 'sha256']);
    if (
      packed.kind !== 'file' ||
      !Number.isSafeInteger(packed.size) ||
      (packed.size as number) < 0 ||
      (packed.size as number) > 16 * 1024 * 1024
    )
      throw unavailable();
    packedRefs = Object.freeze({
      kind: 'file',
      identity: identity(packed.identity),
      size: packed.size as number,
      sha256: digest(packed.sha256),
    });
  }
  const tree = data(item.tree, ['payload', 'entries']),
    staged = data(tree.payload, ['file_path', 'rootAnchor', 'parentIdentity', 'identity']);
  const stagingRoot = anchor(staged.rootAnchor),
    staging = path(staged.file_path),
    stagingParent = identity(staged.parentIdentity);
  if (
    dirname(staging) !== stagingRoot.rootPath ||
    !isDeepStrictEqual(stagingParent, stagingRoot.identity)
  )
    throw unavailable();
  rejectNativeTreeExclusions(
    [sourcePath, commonAnchor.rootPath, taskRoot.rootPath, staging],
    deniedRoots,
  );
  const entries = projectNativeRepositoryTreeEntries(tree.entries);
  const metadata = Object.freeze(
    array(item.metadata, 6).map((value) => payload(value, 16 * 1024 * 1024)),
  );
  if (
    metadata.length !== 6 ||
    new Set(metadata.map((entry) => entry.file_path)).size !== 6 ||
    metadata.some((entry) => !isDeepStrictEqual(entry.rootAnchor, stagingRoot)) ||
    metadata.reduce((sum, entry) => sum + entry.size, 0) > 32 * 1024 * 1024
  )
    throw unavailable();
  const plan: Readonly<NativePreparationPublicationPlan> = Object.freeze({
    version: 'prepared-repository-publication-v1',
    requestSha256: digest(item.requestSha256),
    allocationFactsSha256: digest(item.allocationFactsSha256),
    scopeSha256: digest(item.scopeSha256),
    workspaceId: item.workspaceId,
    baseOid: item.baseOid,
    sourcePath,
    sourceAnchor,
    commonAnchor,
    taskRoot,
    directories,
    existingDirectories,
    packedRefs,
    tree: Object.freeze({
      payload: Object.freeze({
        file_path: staging,
        rootAnchor: stagingRoot,
        parentIdentity: stagingParent,
        identity: identity(staged.identity),
      }),
      entries,
    }),
    metadata,
    deniedRoots,
  });
  const targets = nativePreparationPublicationTargets(plan);
  if (!known.has(dirname(targets.reference)) && !created.has(dirname(targets.reference)))
    throw unavailable();
  if (
    within(stagingRoot.rootPath, sourcePath) ||
    within(stagingRoot.rootPath, commonAnchor.rootPath) ||
    within(stagingRoot.rootPath, taskRoot.rootPath) ||
    [sourcePath, commonAnchor.rootPath, taskRoot.rootPath].some((target) =>
      within(target, stagingRoot.rootPath),
    )
  )
    throw unavailable();
  // Whole-plan request and complete receipt bounds include every directory,
  // tree result and metadata leaf. Nothing is omitted/truncated to fit IPC.
  const maxIdentity = { dev: '9'.repeat(32), ino: '9'.repeat(32) };
  const receipt = {
    directories: directorySteps(plan).map((step) => ({
      directory: step.directory,
      identity: maxIdentity,
    })),
    files: targets.files.map((file_path, n) => ({
      file_path,
      identity: maxIdentity,
      byteLength: metadata[n].size,
      sha256: metadata[n].sha256,
    })),
    tree: {
      directory: targets.task,
      identity: maxIdentity,
      entries: entries.length,
      byteLength: entries.reduce((sum, entry) => sum + entry.size, 0),
    },
  };
  const receiptJson = pythonJson(receipt),
    ascii = pythonJson(receiptJson);
  if (
    Buffer.byteLength(JSON.stringify(plan)) > 2 * 1024 * 1024 ||
    Buffer.byteLength(
      JSON.stringify({ version: 1, directories: receipt.directories, files: receipt.files }),
    ) > 16384 ||
    Buffer.byteLength(receiptJson) > 16384 ||
    Buffer.byteLength(ascii) + 64 > 32768
  )
    throw unavailable();
  return plan;
}
/** Exact frozen union: original planned absent directories, task tree, and the
 * six leaves only where not already beneath a newly-owned directory. */
export function nativePreparationPublicationWriteRoots(input: NativePreparationPublicationPlan) {
  const plan = projectNativePreparationPublicationPlan(input);
  if (plan.layout === 'standalone')
    return Object.freeze([
      { path: plan.tree.payload.rootAnchor.rootPath, parentAnchor: plan.tree.payload.rootAnchor },
      { path: nativePreparationPublicationTargets(plan).task, parentAnchor: plan.taskRoot },
    ]);
  const steps = directorySteps(plan),
    known = new Map(plan.existingDirectories.map((entry) => [entry.directory, entry.identity]));
  const candidates = [
    ...steps.map((step) => step.directory),
    ...nativePreparationPublicationTargets(plan).files,
  ];
  const minimal = candidates.filter(
    (path) => !candidates.some((parent) => parent !== path && within(path, parent)),
  );
  return Object.freeze([
    { path: plan.tree.payload.rootAnchor.rootPath, parentAnchor: plan.tree.payload.rootAnchor },
    ...minimal.map((path) => {
      let parent = dirname(path);
      while (!known.has(parent)) {
        if (parent === dirname(parent)) throw unavailable();
        parent = dirname(parent);
      }
      return Object.freeze({
        path,
        parentAnchor: Object.freeze({ rootPath: parent, identity: known.get(parent)! }),
      });
    }),
  ]);
}

export async function publishNativePreparedRepository(
  input: NativePreparationPublicationPlan,
  signal: AbortSignal,
  timeoutMs: number,
  privateTransport: NativeFileHelperTransport,
): Promise<Readonly<QualifiedLocalRepositoryPublication>> {
  signal.throwIfAborted();
  try {
    if (
      typeof privateTransport !== 'function' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 30000
    )
      throw unavailable();
    const plan = projectNativePreparationPublicationPlan(input);
    const { executeNativeFileOperation } = await import('./native-file-operation.js');
    const targets = nativePreparationPublicationTargets(plan);
    const result = await executeNativeFileOperation(
      {
        operation: 'PublishPreparedRepository',
        preparationPlan: plan,
        file_path: targets.task,
        parentIdentity: plan.taskRoot.identity,
        identity: null,
        limit: 1,
        timeoutMs,
      },
      signal,
      timeoutMs,
      privateTransport,
    );
    signal.throwIfAborted();
    if (result.is_error || Buffer.byteLength(result.content) > 16384) throw unavailable();
    const parsed = JSON.parse(result.content),
      projected = data(parsed, ['directories', 'files', 'tree']);
    const { snapshotQualifiedLocalRepositoryPublication } =
      await import('./qualified-local-repository-task.js');
    const publication = snapshotQualifiedLocalRepositoryPublication({
      version: 1,
      directories: projected.directories,
      files: projected.files,
    } as QualifiedLocalRepositoryPublication);
    if (plan.layout === 'standalone') {
      if (
        publication.directories.length !== 2 ||
        publication.directories[0].directory !== targets.task ||
        publication.directories[1].directory !== targets.admin ||
        publication.files.length !== 0
      )
        throw unavailable();
      return publication;
    }
    const expected = directorySteps(plan).map((step) => step.directory);
    if (
      publication.directories.length !== expected.length ||
      publication.directories.some((entry, n) => entry.directory !== expected[n]) ||
      publication.files.length !== 6 ||
      publication.files.some(
        (entry, n) =>
          entry.file_path !== targets.files[n] ||
          entry.byteLength !== plan.metadata[n].size ||
          entry.sha256 !== plan.metadata[n].sha256,
      )
    )
      throw unavailable();
    const tree = data(projected.tree, ['directory', 'identity', 'entries', 'byteLength']);
    if (
      tree.directory !== targets.task ||
      !isDeepStrictEqual(
        identity(tree.identity),
        publication.directories.find((entry) => entry.directory === targets.task)?.identity,
      ) ||
      tree.entries !== plan.tree.entries.length ||
      tree.byteLength !== plan.tree.entries.reduce((sum, entry) => sum + entry.size, 0)
    )
      throw unavailable();
    return publication;
  } catch (cause) {
    signal.throwIfAborted();
    throw unavailable(cause);
  }
}

/** SAME descriptor helper fixed phase; no arbitrary operation list or Git. */
export const nativePreparationPublicationPython = String.raw`
def publish_prepared_repository(request):
    plan = request['preparationPlan']
    if plan.get('layout') == 'standalone': return publish_standalone_repository(request)
    deadline = time.monotonic() + request['timeoutMs'] / 1000
    exclusions = plan['deniedRoots']
    common = plan['commonAnchor']['rootPath']
    task = os.path.join(plan['taskRoot']['rootPath'], 'repo-' + plan['workspaceId'])
    admin = os.path.join(common, 'worktrees', 'repo-' + plan['workspaceId'])
    reference = os.path.join(common, 'refs', 'heads', 'mitzo', 'repo-' + plan['workspaceId'])
    paths = [os.path.join(admin, name) for name in ['HEAD', 'commondir', 'gitdir', 'index']] + [reference, os.path.join(task, '.git')]
    expected_text = [('ref: refs/heads/mitzo/repo-' + plan['workspaceId'] + '\n').encode(), b'../..\n', (os.path.join(task, '.git') + '\n').encode(), None, (plan['baseOid'] + '\n').encode(), ('gitdir: ' + admin + '\n').encode()]
    descriptors = {}
    originals = {item['directory']: item['identity'] for item in plan['existingDirectories']}
    identities = dict(originals)
    created = set()
    steps = list(plan['directories'])
    admin_parent = os.path.dirname(admin)
    steps.append({'directory': admin, 'rootAnchor': plan['commonAnchor'], 'parent': {'kind': 'existing', 'directory': admin_parent, 'identity': originals[admin_parent]} if admin_parent in originals else {'kind': 'created', 'directory': admin_parent}})
    planned = {step['directory'] for step in steps}
    results = []
    file_results = []
    def check():
        if time.monotonic() >= deadline: raise RuntimeError('Prepared publication unavailable')
    def matches(info, expected):
        return str(info.st_dev) == expected['dev'] and str(info.st_ino) == expected['ino']
    def admitted(path):
        check()
        if any(path == denied or path.startswith(denied.rstrip('/') + '/') for denied in exclusions): raise RuntimeError('Prepared publication unavailable')
    def exact_name(directory, name):
        # Names only; never child.stat/readlink and never expose this listing.
        count = size = 0
        found = False
        with os.scandir(directory) as entries:
            for entry in entries:
                check()
                count += 1; size += len(os.fsencode(entry.name))
                if count > 10000 or size > 1024 * 1024: raise RuntimeError('Prepared publication unavailable')
                if entry.name == name: found = True
        return found
    def opened(path, anchor, expected):
        admitted(path)
        parts = [part for part in path.split('/') if part]
        roots = [part for part in anchor['rootPath'].split('/') if part]
        if parts[:len(roots)] != roots: raise RuntimeError('Prepared publication unavailable')
        directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for index, part in enumerate(parts):
                check()
                if index >= len(roots) and not exact_name(directory, part): raise RuntimeError('Prepared publication unavailable')
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory); directory = child
                if index + 1 == len(roots) and not matches(os.fstat(directory), anchor['identity']): raise RuntimeError('Prepared publication unavailable')
            if not stat.S_ISDIR(os.fstat(directory).st_mode) or not matches(os.fstat(directory), expected): raise RuntimeError('Prepared publication unavailable')
            return directory
        except:
            os.close(directory); raise
    def root_for(path):
        return plan['taskRoot'] if path == plan['taskRoot']['rootPath'] or path.startswith(plan['taskRoot']['rootPath'] + '/') else plan['commonAnchor']
    def absent(path):
        admitted(path)
        parent = os.path.dirname(path)
        # Children below a planned absent node are typed edges, not fake IDs.
        if parent in planned and parent not in created: return
        if parent not in descriptors:
            candidate = parent
            while candidate not in descriptors and candidate not in planned:
                next_candidate = os.path.dirname(candidate)
                if next_candidate == candidate: raise RuntimeError('Prepared publication unavailable')
                candidate = next_candidate
            if candidate in planned and candidate not in created: return
            # A required namespace not in the exact original allocation plan is
            # not silently walked/adopted. Only a physically missing first node
            # can prove its descendants absent.
            relative = os.path.relpath(parent, candidate).split('/')
            directory = os.dup(descriptors[candidate])
            try:
                for part in relative:
                    try: entry = os.stat(part, dir_fd=directory, follow_symlinks=False)
                    except FileNotFoundError: return
                    raise RuntimeError('Prepared publication unavailable')
            finally: os.close(directory)
        try: os.stat(os.path.basename(path), dir_fd=descriptors[parent], follow_symlinks=False)
        except FileNotFoundError: return
        raise RuntimeError('Prepared publication unavailable')
    def verify_bindings():
        for path, expected in identities.items():
            check()
            directory = opened(path, root_for(path), expected)
            try:
                if not matches(os.fstat(descriptors[path]), expected): raise RuntimeError('Prepared publication unavailable')
            finally: os.close(directory)
        directory = opened(plan['sourcePath'], plan['sourceAnchor'], plan['sourceAnchor']['identity']); os.close(directory)
    def packed():
        check()
        name = 'packed-refs'; expected = plan['packedRefs']; directory = descriptors[common]
        admitted(os.path.join(common, name))
        try: before = os.stat(name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            if expected['kind'] != 'absent': raise RuntimeError('Prepared publication unavailable')
            return
        if expected['kind'] != 'file' or not exact_name(directory, name) or not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != expected['size'] or not matches(before, expected['identity']): raise RuntimeError('Prepared publication unavailable')
        file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            observed = os.fstat(file)
            if not matches(observed, expected['identity']) or observed.st_nlink != 1 or observed.st_size != expected['size'] or observed.st_mtime_ns != before.st_mtime_ns or observed.st_ctime_ns != before.st_ctime_ns: raise RuntimeError('Prepared publication unavailable')
            digest = hashlib.sha256(); size = 0
            while size < expected['size']:
                check(); chunk = os.read(file, min(65536, expected['size'] - size))
                if not chunk: raise RuntimeError('Prepared publication unavailable')
                size += len(chunk); digest.update(chunk)
            after = os.fstat(file)
            if os.read(file, 1) or digest.hexdigest() != expected['sha256'] or after.st_nlink != 1 or after.st_size != observed.st_size or after.st_mtime_ns != observed.st_mtime_ns or after.st_ctime_ns != observed.st_ctime_ns: raise RuntimeError('Prepared publication unavailable')
            binding = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if not matches(binding, expected['identity']) or binding.st_mtime_ns != after.st_mtime_ns or binding.st_ctime_ns != after.st_ctime_ns: raise RuntimeError('Prepared publication unavailable')
        finally: os.close(file)
    def file_request(index):
        path = paths[index]; parent = os.path.dirname(path)
        return {'file_path': path, 'rootAnchor': root_for(path), 'parentIdentity': identities.get(parent), 'expectedAbsent': True, 'payload': plan['metadata'][index], 'deniedRoots': exclusions, 'timeoutMs': request['timeoutMs']}
    tree = dict(plan['tree'], file_path=task, rootAnchor=plan['taskRoot'], parentIdentity=plan['taskRoot']['identity'], targetIdentity=None, originalSourcePath=plan['sourcePath'], deniedRoots=exclusions, timeoutMs=request['timeoutMs'])
    try:
        if not hasattr(os, 'O_NOFOLLOW') or os.open not in os.supports_dir_fd or os.mkdir not in os.supports_dir_fd: raise RuntimeError('Prepared publication unavailable')
        for item in plan['existingDirectories']:
            descriptors[item['directory']] = opened(item['directory'], root_for(item['directory']), item['identity'])
        verify_bindings()
        for step in steps: absent(step['directory'])
        for path in paths + [reference + '.lock', os.path.join(common, 'logs', 'refs', 'heads', 'mitzo', 'repo-' + plan['workspaceId']), os.path.join(common, 'logs', 'refs', 'heads', 'mitzo', 'repo-' + plan['workspaceId'] + '.lock')]: absent(path)
        packed()
        # All staged bytes and the entire task manifest BEFORE the first mkdir.
        for index in range(6):
            value = create_file(file_request(index), deadline=deadline, payload_only=True)
            if expected_text[index] is not None and value != expected_text[index]: raise RuntimeError('Prepared publication unavailable')
        publish_tree(tree, preflight_only=True, deadline=deadline)
        verify_bindings(); packed()
        for step in steps:
            check(); verify_bindings()
            path = step['directory']; parent = os.path.dirname(path)
            if parent not in descriptors or path in descriptors: raise RuntimeError('Prepared publication unavailable')
            absent(path)
            os.mkdir(os.path.basename(path), 0o700, dir_fd=descriptors[parent])
            directory = os.open(os.path.basename(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptors[parent])
            info = os.fstat(directory)
            descriptors[path] = directory
            identities[path] = {'dev': str(info.st_dev), 'ino': str(info.st_ino)}
            created.add(path)
            results.append({'directory': path, 'identity': identities[path]})
        tree['targetIdentity'] = identities[task]
        state = {}
        tree_result = json.loads(publish_tree(tree, deadline=deadline, target_fd=descriptors[task], phase_state=state))
        for index in range(6):
            check(); verify_bindings()
            item = file_request(index)
            file_results.append(json.loads(create_file(item, deadline=deadline, target_parent_fd=descriptors[os.path.dirname(paths[index])])))
        verify_bindings(); packed()
        for index, receipt in enumerate(file_results): create_file(file_request(index), deadline=deadline, expected_receipt=receipt, target_parent_fd=descriptors[os.path.dirname(paths[index])])
        publish_tree(tree, deadline=deadline, target_fd=descriptors[task], phase_state=state, verify_only=True, extra_target_names={'.git'})
        verify_bindings(); packed(); check()
        result = json.dumps({'directories': results, 'files': file_results, 'tree': tree_result}, ensure_ascii=True)
        if len(result.encode('utf-8')) > 16384: raise RuntimeError('Prepared publication unavailable')
        return result
    finally:
        for directory in descriptors.values(): os.close(directory)

def publish_standalone_repository(request):
    plan = request['preparationPlan']; deadline = time.monotonic() + request['timeoutMs'] / 1000
    root = plan['taskRoot']; task = os.path.join(root['rootPath'], 'repo-' + plan['workspaceId']); admin = os.path.join(task, '.git')
    exclusions = plan['deniedRoots']; descriptors = []
    def check():
        if time.monotonic() >= deadline: raise RuntimeError('Prepared publication unavailable')
    def ident(info): return {'dev': str(info.st_dev), 'ino': str(info.st_ino)}
    def opened(path, expected):
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        prefix = ''
        try:
            for part in [part for part in path.split('/') if part]:
                check(); prefix += '/' + part
                if any(prefix == denied or prefix.startswith(denied.rstrip('/') + '/') for denied in exclusions): raise RuntimeError('Prepared publication unavailable')
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd); os.close(fd); fd = child
            if ident(os.fstat(fd)) != expected: raise RuntimeError('Prepared publication unavailable')
            return fd
        except:
            os.close(fd); raise
    def verify_roots():
        for value in [root, plan['sourceAnchor'], plan['commonAnchor']]:
            fd = opened(value['rootPath'], value['identity']); os.close(fd)
    def tree_request(value, target, parent, target_id):
        return dict(value, file_path=target, rootAnchor=root, parentIdentity=parent, targetIdentity=target_id, originalSourcePath=plan['sourcePath'], deniedRoots=exclusions, timeoutMs=request['timeoutMs'])
    try:
        verify_roots(); parent = opened(root['rootPath'], root['identity']); descriptors.append(parent)
        try: os.stat(os.path.basename(task), dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError: pass
        else: raise RuntimeError('Prepared publication unavailable')
        work = tree_request(plan['tree'], task, root['identity'], None)
        git = tree_request(plan['standaloneGit'], admin, root['identity'], None)
        publish_tree(work, preflight_only=True, deadline=deadline); publish_tree(git, preflight_only=True, deadline=deadline, repository_git_containers=True)
        verify_roots(); check(); os.mkdir(os.path.basename(task), 0o700, dir_fd=parent)
        task_fd = os.open(os.path.basename(task), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent); descriptors.append(task_fd)
        task_id = ident(os.fstat(task_fd)); work['targetIdentity'] = task_id
        work_state = {}; result = json.loads(publish_tree(work, deadline=deadline, target_fd=task_fd, phase_state=work_state))
        verify_roots(); os.mkdir('.git', 0o700, dir_fd=task_fd)
        git_fd = os.open('.git', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=task_fd); descriptors.append(git_fd)
        git_id = ident(os.fstat(git_fd)); git['targetIdentity'] = git_id; git['parentIdentity'] = task_id
        git_state = {}; publish_tree(git, deadline=deadline, target_fd=git_fd, phase_state=git_state, repository_git_containers=True)
        verify_roots(); publish_tree(work, deadline=deadline, target_fd=task_fd, phase_state=work_state, verify_only=True, extra_target_names={'.git'})
        publish_tree(git, deadline=deadline, target_fd=git_fd, phase_state=git_state, verify_only=True, repository_git_containers=True); verify_roots(); check()
        return json.dumps({'directories': [{'directory': task, 'identity': task_id}, {'directory': admin, 'identity': git_id}], 'files': [], 'tree': result}, ensure_ascii=True)
    finally:
        for fd in descriptors: os.close(fd)
`;

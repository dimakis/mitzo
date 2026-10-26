import { freezeNativeReadExclusions } from './native-file-operation.js';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  inspectLocalRepositoryGitMetadata,
  isLocalRepositoryCredentialPath,
  LocalRepositoryGitInspectionError,
  readLocalRepositoryStatus,
  type LocalRepositoryGitMetadata,
} from './local-repository-git-inspection.js';
import {
  LocalRepositoryReadAccess,
  type LocalRepositoryReadAnchor,
  type LocalRepositoryReadAuthority,
} from './local-repository-read-access.js';
import {
  readLocalRepositoryGitFacts,
  readLocalRepositoryWorktrees,
} from './local-repository-git-snapshot.js';

/** A projection of existing target read access, never a request to grant access.
 * The owner includes effective canonical denials and relevant lexical aliases;
 * readers must not probe denied locations to normalize policy. */
export type LocalRepositoryReadScope =
  | { kind: 'roots'; roots: readonly string[]; deniedRoots?: readonly string[] }
  | { kind: 'host-wide'; deniedRoots?: readonly string[] };
export interface LocalRepositoryLimits {
  maxDirectories?: number;
  maxEntries?: number;
  maxGitMetadataEntries?: number;
  maxDepth?: number;
  maxCandidates?: number;
  timeoutMs?: number;
  maxInstructionBytes?: number;
  maxTotalInstructionBytes?: number;
  maxInstructionDirectories?: number;
}
interface ReadRequest {
  /** Exact private original factory authority, retained without spread/serialization. */
  nativeReader?: LocalRepositoryReadAuthority;
  /** Genuine original outward owner; independent of the private reader lifetime. */
  revalidateReadAccess?(): Promise<void>;
  /** Original qualified owner's transport, never a model field. Native owners
   * route every source operation through their existing enforced boundary. */
  executeReadOperation?: LocalRepositoryReadAuthority['executeReadOperation'];
  /** Private original current-owner exclusions, never tool JSON. */
  captureReadExclusions?(): Promise<readonly string[]>;
  accessScope: LocalRepositoryReadScope;
  limits?: LocalRepositoryLimits;
  signal?: AbortSignal;
  /** Private current-owner ceiling; mandatory in the native tool adapter.
   * This is ANDed with projected scope, never accepted from tool JSON. */
  assertReadAccess?(path: string, signal: AbortSignal | undefined): Promise<void>;
  /** Actual owner identity capture, never inferred from model paths or projected scope. */
  captureReadAnchor?(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<LocalRepositoryReadAnchor>;
}
export interface LocalRepositoryDiscoveryRequest extends ReadRequest {
  query?: string;
  explicitPath?: string;
  /** Bounded search locations, independent of the target's actual access scope. */
  discoveryRoots?: readonly string[];
  /** Ordering hints only: these neither grant access nor resolve ambiguity. */
  orientationHints?: readonly string[];
}
export interface LocalRepositoryCandidate {
  name: string;
  path: string;
}
export interface LocalRepositoryDiagnostic {
  path: string;
  reason: string;
}
export interface LocalRepositoryDiscoveryResult {
  state: 'selected' | 'ambiguous' | 'missing' | 'access-required';
  candidates: LocalRepositoryCandidate[];
  truncated: boolean;
  /** Known ineligible exclusions; does not imply eligible search truncation. */
  restricted?: true;
  limitReasons: string[];
  diagnostics: LocalRepositoryDiagnostic[];
  needed: Array<
    | 'source'
    | 'destination'
    | 'query-or-path'
    | 'read-access'
    | 'discovery-roots'
    | 'narrower-search'
  >;
  visitedDirectories: number;
}
export interface LocalRepositoryInspection {
  path: string;
  cwd: string;
  head: string | null;
  branch: string | null;
  gitDirectory: string;
  commonDirectory: string;
  /** Git facts only; session ownership must still be checked by the workspace owner. */
  worktrees: Array<{
    path: string;
    head?: string;
    branch?: string;
    locked?: boolean;
    prunable?: boolean;
  }>;
  /** Source-effective facts only. Unqualified omitted host comparison settings
   * remain unknown; isolated private equality is not source cleanliness. */
  dirty: {
    state: 'clean' | 'dirty' | 'unknown';
    entries: Array<{ path: string; index: string; worktree: string; originalPath?: string }>;
  };
  instructions: {
    files: Array<{
      path: string;
      resolvedPath: string;
      identity: { dev: number; ino: number };
      content: string;
      truncated: boolean;
    }>;
    omitted: LocalRepositoryDiagnostic[];
    complete: boolean;
  };
  diagnostics: LocalRepositoryDiagnostic[];
}

const credentials = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.azure',
  '.gcloud',
  '.codex',
  '.claude',
  '.cursor',
  '.config',
  'Keychains',
]);
const skipped = new Set([
  ...credentials,
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.npm',
  '.yarn',
  '.pnpm-store',
  '.next',
  'Library',
]);
const within = (path: string, root: string) => {
  const suffix = relative(root, path);
  return (
    suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
  );
};
const credentialPath = isLocalRepositoryCredentialPath;
const integer = (value: number | undefined, fallback: number, ceiling: number) =>
  value !== undefined && Number.isFinite(value)
    ? Math.max(1, Math.min(ceiling, Math.floor(value)))
    : fallback;
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

async function context(request: ReadRequest) {
  request.signal?.throwIfAborted();
  const captureReadAnchor = request.captureReadAnchor;
  if (typeof captureReadAnchor !== 'function')
    throw new LocalRepositoryGitInspectionError('access', 'read-anchor-required');
  if (typeof request.captureReadExclusions !== 'function')
    throw new LocalRepositoryGitInspectionError('access', 'read-exclusions-required');
  let actualExclusions: readonly string[];
  try {
    actualExclusions = freezeNativeReadExclusions(await request.captureReadExclusions());
  } catch {
    request.signal?.throwIfAborted();
    throw new LocalRepositoryGitInspectionError('access', 'read-exclusions-required');
  }
  const hostWide = request.accessScope.kind === 'host-wide';
  const suppliedRoots = request.accessScope.kind === 'roots' ? [...request.accessScope.roots] : [];
  const suppliedDenials = freezeNativeReadExclusions([
    ...new Set([...actualExclusions, ...(request.accessScope.deniedRoots ?? [])]),
  ]);
  const limits = {
    maxDirectories: integer(request.limits?.maxDirectories, 2000, 10000),
    maxEntries: integer(request.limits?.maxEntries, 20000, 100000),
    maxGitMetadataEntries: integer(request.limits?.maxGitMetadataEntries, 100000, 500000),
    maxDepth: integer(request.limits?.maxDepth, 6, 20),
    maxCandidates: integer(request.limits?.maxCandidates, 20, 100),
    timeoutMs: integer(request.limits?.timeoutMs, 15000, 60000),
    maxInstructionBytes: integer(request.limits?.maxInstructionBytes, 65536, 262144),
    maxTotalInstructionBytes: integer(request.limits?.maxTotalInstructionBytes, 262144, 1048576),
    maxInstructionDirectories: integer(request.limits?.maxInstructionDirectories, 32, 128),
  };
  const readerDescriptor = Object.getOwnPropertyDescriptor(request, 'nativeReader');
  if (
    'nativeReader' in request &&
    (!readerDescriptor || !('value' in readerDescriptor) || readerDescriptor.enumerable)
  )
    throw new LocalRepositoryGitInspectionError('access', 'original-native-reader-required');
  const nativeReader: LocalRepositoryReadAuthority | undefined = readerDescriptor?.value;
  const revalidateReadAccess = request.revalidateReadAccess;
  if (
    readerDescriptor &&
    (!nativeReader ||
      !Object.isFrozen(nativeReader) ||
      typeof nativeReader.executeReadOperation !== 'function' ||
      typeof nativeReader.executeDirectoryVerification !== 'function' ||
      typeof nativeReader.revalidate !== 'function' ||
      typeof revalidateReadAccess !== 'function')
  )
    throw new LocalRepositoryGitInspectionError('access', 'original-native-reader-required');
  const deadline = Math.min(Date.now() + limits.timeoutMs, nativeReader?.deadline ?? Infinity);
  const check = () => {
    request.signal?.throwIfAborted();
    nativeReader?.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new LocalRepositoryGitInspectionError('limit', 'timeout');
  };
  const assertReadAccess = request.assertReadAccess;
  if (assertReadAccess !== undefined && typeof assertReadAccess !== 'function')
    throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
  const authorize = async (path: string) => {
    check();
    try {
      const allowed: unknown = await assertReadAccess?.(path, request.signal);
      if (allowed !== undefined)
        throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
    } catch (error) {
      request.signal?.throwIfAborted();
      if (error instanceof LocalRepositoryGitInspectionError) throw error;
      throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
    }
    check();
  };
  const roots: string[] = [];
  const deniedRoots = new Set<string>();
  const diagnostics: LocalRepositoryDiagnostic[] = [];
  for (const root of suppliedDenials) {
    request.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new LocalRepositoryGitInspectionError('limit', 'timeout');
    if (!isAbsolute(root))
      throw new LocalRepositoryGitInspectionError('access', 'absolute-denied-root-required');
    const lexical = resolve(root);
    deniedRoots.add(lexical);
  }
  const denied = (path: string) => [...deniedRoots].some((root) => within(resolve(path), root));
  if (!hostWide) {
    for (const root of suppliedRoots) {
      request.signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new LocalRepositoryGitInspectionError('limit', 'timeout');
      if (!isAbsolute(root)) {
        diagnostics.push({ path: root, reason: 'absolute-path-required' });
        continue;
      }
      if (denied(root)) {
        diagnostics.push({ path: '', reason: 'read-access-required' });
        continue;
      }
      try {
        await authorize(root);
        if (resolve(root) !== root || credentialPath(root))
          throw new LocalRepositoryGitInspectionError('access', 'canonical-access-root-required');
        roots.push(root);
      } catch (error) {
        request.signal?.throwIfAborted();
        if (error instanceof LocalRepositoryGitInspectionError && error.kind === 'limit')
          throw error;
        diagnostics.push({ path: '', reason: 'unavailable-access-root' });
      }
    }
  }
  const allowed = (path: string) =>
    !credentialPath(path) &&
    !denied(path) &&
    (hostWide || roots.some((root) => within(path, root)));
  const canonical = async (path: string) => {
    check();
    if (!isAbsolute(path))
      throw new LocalRepositoryGitInspectionError('access', 'absolute-path-required');
    if (resolve(path) !== path)
      throw new LocalRepositoryGitInspectionError('access', 'canonical-path-required');
    if (credentialPath(path))
      throw new LocalRepositoryGitInspectionError('access', 'credential-directory-excluded');
    if (!allowed(path))
      throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
    await authorize(path);
    // Lexical validation performs no source lookup. The mandatory descriptor
    // owner captures/revalidates physical roots before any metadata or bytes.
    return path;
  };
  const ceiling = Object.freeze({
    assertReadable: async (path: string) => {
      await canonical(path);
      check();
    },
    revalidate: async () => {
      check();
      if (request.revalidateReadAccess !== revalidateReadAccess)
        throw new LocalRepositoryGitInspectionError('access', 'original-owner-required');
      const checked: unknown = await revalidateReadAccess?.call(request);
      if (checked !== undefined || request.revalidateReadAccess !== revalidateReadAccess)
        throw new LocalRepositoryGitInspectionError('access', 'original-owner-required');
      check();
    },
  });
  const readAccess = nativeReader
    ? new LocalRepositoryReadAccess(nativeReader, ceiling)
    : new LocalRepositoryReadAccess({
        deniedRoots: suppliedDenials,
        assertReadable: async (path) => {
          if (!isAbsolute(path) || !allowed(path))
            throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
          await authorize(path);
        },
        captureReadAnchor: async (path) => {
          await canonical(path);
          const anchor = await captureReadAnchor(path, request.signal);
          await canonical(path);
          return anchor;
        },
        executeReadOperation: request.executeReadOperation,
        signal: request.signal,
        deadline,
      });
  const requestedSource =
    'explicitPath' in request ? request.explicitPath : 'path' in request ? request.path : undefined;
  // Native capture must happen before pinning roots, but inside the explicit
  // discovery result classifier. Preserve the original reader/owner and join
  // one initialization; failures never enable an ambient fallback.
  let initialization: Promise<void> | undefined;
  const initialize = () =>
    (initialization ??= (async () => {
      if (nativeReader?.captureRepositoryObservation && typeof requestedSource === 'string') {
        await canonical(requestedSource);
        await readAccess.captureRepositoryObservation({
          mode: 'explicitPath' in request ? 'discovery' : 'orientation',
          sourcePath: requestedSource,
          readableRoots: hostWide ? ['/'] : roots,
          additionalDeniedRoots: suppliedDenials,
        });
      }
      for (const root of [...roots]) {
        try {
          await readAccess.pinRoot(root);
        } catch (error) {
          request.signal?.throwIfAborted();
          if (error instanceof LocalRepositoryGitInspectionError && error.kind === 'limit')
            throw error;
          roots.splice(roots.indexOf(root), 1);
          diagnostics.push({ path: '', reason: 'unavailable-access-root' });
        }
      }
    })());
  if (!nativeReader?.captureRepositoryObservation || typeof requestedSource !== 'string')
    await initialize();
  const inspected = new Map<string, LocalRepositoryGitMetadata>();
  const metadata = async (cwd: string) => {
    if (!inspected.has(cwd)) {
      // Orientation consumes reference metadata, never object/status evidence.
      // Preserve source indirection refusal without recursively enumerating
      // every unconsumed Git object fanout directory.
      const qualified = await inspectLocalRepositoryGitMetadata({
        mode: 'head',
        path: cwd,
        assertReadable: async (path) => {
          if (!isAbsolute(path) || !allowed(path))
            throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
          await authorize(path);
        },
        signal: request.signal,
        readAccess,
        maxEntries: limits.maxGitMetadataEntries,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      for (const name of ['objects/info/alternates', 'objects/info/http-alternates']) {
        try {
          if (
            (await readAccess.read(join(qualified.commonDirectory, name), 65536))
              .toString('utf8')
              .trim()
          )
            throw new LocalRepositoryGitInspectionError('unsafe', 'alternate-storage-unavailable');
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }
      }
      inspected.set(cwd, qualified);
    }
    return inspected.get(cwd)!;
  };
  const deniedContent = (path: string) => [...deniedRoots].some((root) => within(root, path));
  return {
    roots,
    limits,
    deadline,
    diagnostics,
    allowed,
    check,
    canonical,
    readAccess,
    initialize,
    metadata,
    deniedContent,
    authorize,
  };
}

/** Read-only bounded discovery. A partial scan never silently chooses a unique match. */
export async function discoverLocalRepository(
  request: LocalRepositoryDiscoveryRequest,
): Promise<LocalRepositoryDiscoveryResult> {
  const ctx = await context(request);
  const result: LocalRepositoryDiscoveryResult = {
    state: 'missing',
    candidates: [],
    truncated: false,
    limitReasons: [],
    diagnostics: ctx.diagnostics,
    needed: [],
    visitedDirectories: 0,
  };
  const limit = (reason: string) => {
    result.truncated = true;
    if (!result.limitReasons.includes(reason)) result.limitReasons.push(reason);
  };
  const candidate = async (path: string) => {
    await ctx.initialize();
    await ctx.readAccess.pinRoot(path);
    const metadata = await ctx.metadata(path);
    await readLocalRepositoryGitFacts(metadata, {
      readAccess: ctx.readAccess,
      signal: request.signal,
      timeoutMs: Math.max(1, ctx.deadline - Date.now()),
    });
    const top = metadata.path;
    if (!result.candidates.some((entry) => entry.path === top))
      result.candidates.push({ name: basename(top), path: top });
  };
  if (request.explicitPath) {
    try {
      await candidate(await ctx.canonical(request.explicitPath));
      await ctx.readAccess.verify();
      result.state = 'selected';
      if (ctx.readAccess.hasExclusionsWithin()) result.restricted = true;
    } catch (error) {
      request.signal?.throwIfAborted();
      result.candidates = [];
      const missing = errorCode(error) === 'ENOENT';
      const limited = error instanceof LocalRepositoryGitInspectionError && error.kind === 'limit';
      const access = error instanceof LocalRepositoryGitInspectionError && error.kind === 'access';
      if (limited) limit(`git-metadata-${error.reason}`);
      result.state = missing ? 'missing' : access ? 'access-required' : 'ambiguous';
      result.needed = missing
        ? ['source', 'destination']
        : limited
          ? ['narrower-search']
          : access
            ? ['read-access']
            : [];
      result.diagnostics.push({
        path: request.explicitPath,
        reason: missing
          ? 'repository-not-found'
          : limited
            ? 'inspection-limit'
            : access
              ? 'read-access-required'
              : error instanceof LocalRepositoryGitInspectionError &&
                  error.reason === 'bare-repository-unsupported'
                ? 'bare-repository-unsupported'
                : 'inspection-unavailable',
      });
    }
    return result;
  }
  const query = request.query?.trim().toLocaleLowerCase();
  if (!query) {
    result.needed = ['query-or-path'];
    return result;
  }
  const scanRoots = request.discoveryRoots ?? ctx.roots;
  if (!scanRoots.length || scanRoots.some((root) => resolve(root) === sep)) {
    result.state = 'access-required';
    result.needed = ['discovery-roots'];
    return result;
  }
  const hints = request.orientationHints ?? [];
  const queue: Array<{ path: string; depth: number }> = [];
  for (const path of scanRoots) {
    try {
      const canonicalPath = await ctx.canonical(path);
      if (!ctx.readAccess.covers(canonicalPath)) await ctx.readAccess.pinRoot(canonicalPath);
      queue.push({ path: canonicalPath, depth: 0 });
    } catch {
      request.signal?.throwIfAborted();
      result.diagnostics.push({ path, reason: 'read-access-required' });
    }
  }
  queue.sort(
    (a, b) =>
      Number(hints.includes(b.path)) - Number(hints.includes(a.path)) ||
      a.path.localeCompare(b.path),
  );
  const visited = new Set<string>();
  let entries = 0;
  while (queue.length) {
    request.signal?.throwIfAborted();
    if (Date.now() >= ctx.deadline) {
      limit('timeout');
      break;
    }
    if (result.visitedDirectories >= ctx.limits.maxDirectories) {
      limit('directories');
      break;
    }
    const current = queue.shift()!;
    if (visited.has(current.path)) continue;
    visited.add(current.path);
    result.visitedDirectories++;
    try {
      if ((await ctx.canonical(current.path)) !== current.path)
        throw Error('Discovery path changed');
      const markerPath = join(current.path, '.git');
      if (!ctx.allowed(markerPath))
        throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
      await ctx.authorize(markerPath);
      const listed = await ctx.readAccess.list(current.path);
      const marker = listed.find((entry) => entry.name === '.git');
      const bare =
        listed.some((entry) => entry.name === 'HEAD' && entry.kind === 'file') &&
        listed.some((entry) => entry.name === 'config' && entry.kind === 'file') &&
        listed.some((entry) => entry.name === 'objects' && entry.kind === 'directory');
      if ((marker || bare) && basename(current.path).toLocaleLowerCase().includes(query)) {
        await candidate(current.path);
        if (result.candidates.length >= ctx.limits.maxCandidates) {
          limit('candidates');
          break;
        }
      }
      await ctx.authorize(current.path);
      const directory = listed.map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.kind === 'directory',
        isSymbolicLink: () => entry.kind === 'unsupported',
      }));
      for await (const entry of directory) {
        request.signal?.throwIfAborted();
        await ctx.authorize(current.path);
        if (++entries > ctx.limits.maxEntries) {
          limit('entries');
          break;
        }
        if (Date.now() >= ctx.deadline) {
          limit('timeout');
          break;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink() || skipped.has(entry.name)) continue;
        if (!ctx.allowed(join(current.path, entry.name))) continue;
        if (current.depth >= ctx.limits.maxDepth) {
          limit('depth');
          continue;
        }
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
      }
      if (result.limitReasons.includes('entries') || result.limitReasons.includes('timeout')) break;
    } catch (error) {
      request.signal?.throwIfAborted();
      if (error instanceof LocalRepositoryGitInspectionError && error.kind === 'limit')
        limit(`git-metadata-${error.reason}`);
      result.diagnostics.push({
        path: current.path,
        reason:
          error instanceof LocalRepositoryGitInspectionError && error.kind === 'access'
            ? 'read-access-required'
            : error instanceof LocalRepositoryGitInspectionError &&
                error.reason === 'bare-repository-unsupported'
              ? 'bare-repository-unsupported'
              : 'inspection-unavailable',
      });
    }
  }
  try {
    await ctx.readAccess.verify();
  } catch (error) {
    request.signal?.throwIfAborted();
    result.candidates = [];
    const access = error instanceof LocalRepositoryGitInspectionError && error.kind === 'access';
    if (error instanceof LocalRepositoryGitInspectionError && error.kind === 'limit')
      limit(error.reason);
    result.state = access ? 'access-required' : 'ambiguous';
    result.needed = access ? ['read-access'] : result.truncated ? ['narrower-search'] : [];
    result.diagnostics = [
      { path: '', reason: access ? 'read-access-required' : 'inspection-unavailable' },
    ];
    return result;
  }
  if (ctx.readAccess.hasExclusionsWithin()) result.restricted = true;
  const exact = result.candidates.filter((entry) => entry.name.toLocaleLowerCase() === query);
  if (exact.length) result.candidates = exact;
  result.candidates.sort(
    (a, b) =>
      Number(hints.includes(b.path)) - Number(hints.includes(a.path)) ||
      a.path.localeCompare(b.path),
  );
  if (result.candidates.length) {
    result.state =
      result.candidates.length === 1 && !result.truncated && !result.diagnostics.length
        ? 'selected'
        : 'ambiguous';
    if (result.truncated) result.needed = ['narrower-search'];
  } else if (result.truncated) {
    result.state = 'ambiguous';
    result.needed = ['narrower-search'];
  } else if (result.diagnostics.length) {
    const access = result.diagnostics.some(
      (diagnostic) => diagnostic.reason === 'read-access-required',
    );
    result.state = access ? 'access-required' : 'ambiguous';
    result.needed = access ? ['read-access'] : [];
  } else result.needed = ['source', 'destination'];
  return result;
}

/** Inspect facts only. No stash, reset, checkout, fetch, allocation or ownership claim. */
export async function inspectLocalRepository(
  request: ReadRequest & { path: string },
): Promise<LocalRepositoryInspection> {
  const ctx = await context(request);
  await ctx.initialize();
  const cwd = await ctx.canonical(request.path);
  await ctx.readAccess.pinRoot(cwd);
  const metadata = await ctx.metadata(cwd);
  const path = metadata.path;
  const { gitDirectory, commonDirectory } = metadata;
  const { branch, head } = await readLocalRepositoryGitFacts(metadata, {
    readAccess: ctx.readAccess,
    signal: request.signal,
    timeoutMs: Math.max(1, ctx.deadline - Date.now()),
  });
  const diagnostics = ctx.diagnostics;
  const dirty: LocalRepositoryInspection['dirty'] = { state: 'unknown', entries: [] };
  try {
    // The product status owner must qualify the effective source comparison
    // context. The isolated snapshot alone cannot establish that qualification.
    if (ctx.deniedContent(path)) throw Error('Dirty inspection contains denied paths');
    await ctx.authorize(path);
    const entries = (
      await readLocalRepositoryStatus(metadata, {
        signal: request.signal,
        readAccess: ctx.readAccess,
        timeoutMs: Math.max(1, Math.min(6000, ctx.deadline - Date.now() - 2000)),
      })
    ).split('\0');
    await ctx.authorize(path);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (!entry) continue;
      dirty.entries.push({
        path: entry.slice(3),
        index: entry[0],
        worktree: entry[1],
        ...(/[RC]/.test(entry.slice(0, 2)) ? { originalPath: entries[++index] } : {}),
      });
    }
    dirty.state = dirty.entries.length ? 'dirty' : 'clean';
  } catch (error) {
    request.signal?.throwIfAborted();
    diagnostics.push({ path, reason: 'dirty-state-unavailable' });
    if (error instanceof LocalRepositoryGitInspectionError)
      diagnostics.push({ path, reason: error.reason });
  }
  const worktrees: LocalRepositoryInspection['worktrees'] = [];
  try {
    worktrees.push(
      ...(await readLocalRepositoryWorktrees(metadata, {
        readAccess: ctx.readAccess,
        signal: request.signal,
        timeoutMs: Math.max(1, ctx.deadline - Date.now()),
      })),
    );
  } catch {
    request.signal?.throwIfAborted();
    diagnostics.push({ path, reason: 'worktrees-unavailable' });
  }
  const instructions: LocalRepositoryInspection['instructions'] = {
    files: [],
    omitted: [],
    complete: true,
  };
  const directories: string[] = [];
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (directories.length >= ctx.limits.maxInstructionDirectories) {
      instructions.omitted.push({ path: directory, reason: 'directory-limit' });
      break;
    }
    directories.unshift(directory);
    if (directory === dirname(directory)) break;
  }
  let remaining = ctx.limits.maxTotalInstructionBytes;
  for (const directory of directories) {
    if (!ctx.allowed(directory)) {
      instructions.omitted.push({ path: directory, reason: 'outside-access' });
      continue;
    }
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = join(directory, name);
      if (!ctx.allowed(file)) {
        instructions.omitted.push({ path: file, reason: 'outside-access' });
        continue;
      }
      if (Date.now() >= ctx.deadline) {
        instructions.omitted.push({ path: file, reason: 'timeout' });
        continue;
      }
      request.signal?.throwIfAborted();
      try {
        let resolvedPath = file;
        let alias = false;
        const visited = new Set<string>();
        let entry;
        try {
          for (;;) {
            if (visited.has(resolvedPath) || visited.size >= 16)
              throw Error('Instruction alias limit');
            visited.add(resolvedPath);
            // The target is separately authorized before capturing its actual
            // directory anchor. Link text alone never widens the read scope.
            await ctx.readAccess.assertPath(resolvedPath);
            if (!ctx.readAccess.covers(dirname(resolvedPath)))
              await ctx.readAccess.pinRoot(dirname(resolvedPath));
            entry = await ctx.readAccess.stat(resolvedPath);
            if (!entry) break;
            if ((entry.mode & 0o170000) !== 0o120000) break;
            alias = true;
            resolvedPath = resolve(
              dirname(resolvedPath),
              await ctx.readAccess.readLink(resolvedPath),
            );
          }
        } catch (error) {
          request.signal?.throwIfAborted();
          if (!alias) throw error;
          instructions.omitted.push({ path: file, reason: 'symlink' });
          continue;
        }
        if (!entry) {
          if (alias) instructions.omitted.push({ path: file, reason: 'symlink' });
          continue;
        }
        if (remaining <= 0) {
          instructions.omitted.push({ path: file, reason: 'byte-limit' });
          continue;
        }
        if (!entry || entry.kind !== 'file' || entry.nlink !== 1) {
          instructions.omitted.push({ path: file, reason: 'not-regular-file' });
          continue;
        }
        const cap = Math.min(remaining, ctx.limits.maxInstructionBytes);
        const bytes = await ctx.readAccess.readPrefix(resolvedPath, Math.max(1, cap));
        remaining -= bytes.length;
        instructions.files.push({
          path: file,
          resolvedPath,
          identity: { dev: Number(entry.identity.dev), ino: Number(entry.identity.ino) },
          content: bytes.toString('utf8'),
          truncated: bytes.length < entry.size,
        });
      } catch (error) {
        request.signal?.throwIfAborted();
        if (errorCode(error) !== 'ENOENT')
          instructions.omitted.push({ path: file, reason: 'read-unavailable' });
      }
    }
  }
  await ctx.readAccess.verify();
  if (ctx.readAccess.hasExclusionsWithin()) {
    if (
      ctx.readAccess.hasExclusionsWithin(path) ||
      ctx.readAccess.hasExclusionsWithin(gitDirectory) ||
      ctx.readAccess.hasExclusionsWithin(commonDirectory)
    ) {
      dirty.state = 'unknown';
      dirty.entries = [];
      diagnostics.push({ path, reason: 'read-scope-incomplete' });
    } else diagnostics.push({ path: '', reason: 'restricted-read-scope' });
  }
  instructions.complete =
    !instructions.omitted.length && !instructions.files.some((file) => file.truncated);
  return {
    path,
    cwd,
    head,
    branch,
    gitDirectory,
    commonDirectory,
    worktrees,
    dirty,
    instructions,
    diagnostics,
  };
}

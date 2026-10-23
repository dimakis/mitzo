import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  executeNativeAnchoredReadOperation,
  freezeNativeReadExclusions,
  NativeReadAnchorMissingError,
  type NativeReadAnchor,
  type NativeReadIdentity,
  type NativeAnchoredReadRequest,
} from './native-file-operation.js';
import {
  LocalRepositoryGitInspectionError,
  localRepositoryReadDirectoryExclusions,
} from './local-repository-git-inspection.js';

export type LocalRepositoryReadAnchor = NativeReadAnchor;
export interface LocalRepositoryReadEntry {
  name: string;
  identity: NativeReadIdentity;
  kind: 'file' | 'directory' | 'unsupported';
  size: number;
  mode: number;
  nlink: number;
  mtimeNs: string;
  ctimeNs: string;
}
export interface LocalRepositoryReadAuthority {
  /** Complete current actual-owner exclusions, not inferred from scope roots. */
  deniedRoots: readonly string[];
  assertReadable(path: string): Promise<void>;
  /** Actual native owners perform full async owner validation before final
   * outward verification, including a verification containing cached facts only. */
  revalidate?(): Promise<void>;
  /** Current owner captures immutable actual object identity. Never model JSON,
   * repository configuration, or a fallback inferred from projected paths. */
  captureReadAnchor(path: string): Promise<LocalRepositoryReadAnchor>;
  /** Original native factory supplies its enforced transport. Host-only fixture
   * owners omit it; production must never infer availability from this fallback. */
  executeReadOperation?(
    request: NativeAnchoredReadRequest,
    signal: AbortSignal,
    timeoutMs: number,
  ): ReturnType<typeof executeNativeAnchoredReadOperation>;
  /** Actual native owner supplies the SAME enforced directory-only helper for
   * original pinned-root listings and verification. Fixtures retain bounded pairs. */
  executeDirectoryVerification?(
    requests: readonly NativeAnchoredReadRequest[],
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<readonly { content: string; is_error: boolean }[]>;
  signal?: AbortSignal;
  deadline: number;
}
const contains = (path: string, root: string) => {
  const value = relative(root, path);
  return !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`);
};
const numericIdentity = (value: unknown): value is NativeReadIdentity =>
  !!value &&
  typeof value === 'object' &&
  'dev' in value &&
  typeof value.dev === 'string' &&
  /^\d{1,32}$/.test(value.dev) &&
  'ino' in value &&
  typeof value.ino === 'string' &&
  /^\d{1,32}$/.test(value.ino);
const equalIdentity = (left: NativeReadIdentity, right: NativeReadIdentity) =>
  left.dev === right.dev && left.ino === right.ino;
const sameEntry = (left: LocalRepositoryReadEntry, right: LocalRepositoryReadEntry) =>
  equalIdentity(left.identity, right.identity) &&
  left.kind === right.kind &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;
const unavailable = () =>
  new LocalRepositoryGitInspectionError('unsafe', 'anchored-read-unavailable');

/** Private bounded read mechanism. Anchors are retained for this one operation;
 * listing metadata never authorizes a later child byte read. */
export class LocalRepositoryReadAccess {
  private readonly anchors = new Map<string, LocalRepositoryReadAnchor>();
  private readonly directories = new Map<string, Map<string, LocalRepositoryReadEntry>>();
  private readonly entries = new Map<string, LocalRepositoryReadEntry>();
  private readonly consumed = new Map<string, LocalRepositoryReadEntry>();
  private readonly capturedBytes = new Map<string, Buffer>();
  private readonly absentPaths = new Set<string>();
  private readonly deniedRoots: readonly string[];
  private readonly excludedDirectories = new Set<string>();
  hasExclusionsWithin(path?: string) {
    return [...this.excludedDirectories].some((directory) => !path || contains(directory, path));
  }
  private totalBytes = 0;
  private totalEntries = 0;
  constructor(private readonly authority: LocalRepositoryReadAuthority) {
    this.deniedRoots = freezeNativeReadExclusions(authority.deniedRoots);
  }
  private check() {
    this.authority.signal?.throwIfAborted();
    if (Date.now() >= this.authority.deadline)
      throw new LocalRepositoryGitInspectionError('limit', 'timeout');
  }
  async assertPath(path: string) {
    await this.authorize(path);
  }
  private async authorize(path: string) {
    this.check();
    if (this.deniedRoots.some((root) => contains(path, root)))
      throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
    try {
      await this.authority.assertReadable(path);
    } catch (error) {
      this.authority.signal?.throwIfAborted();
      if (error instanceof LocalRepositoryGitInspectionError) throw error;
      throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
    }
    this.check();
  }
  private anchor(path: string) {
    let found: LocalRepositoryReadAnchor | undefined;
    for (const anchor of this.anchors.values())
      if (
        contains(path, anchor.rootPath) &&
        (!found || anchor.rootPath.length > found.rootPath.length)
      )
        found = anchor;
    if (!found) throw new LocalRepositoryGitInspectionError('access', 'read-anchor-required');
    return found;
  }
  covers(path: string) {
    return [...this.anchors.values()].some((anchor) => contains(path, anchor.rootPath));
  }
  async pinRoot(path: string) {
    await this.authorize(path);
    const retained = this.anchors.get(path);
    if (retained) return retained;
    if (this.anchors.size >= 256)
      throw new LocalRepositoryGitInspectionError('limit', 'read-anchors');
    // Reconcile any already-observed child identity; never recapture an existing
    // root. A separately authorized root need not list otherwise denied ancestors.
    const previous = this.entries.get(path);
    let supplied: LocalRepositoryReadAnchor;
    try {
      supplied = await this.authority.captureReadAnchor(path);
    } catch (error) {
      await this.authorize(path);
      if (error instanceof NativeReadAnchorMissingError) throw error;
      throw unavailable();
    }
    await this.authorize(path);
    if (
      !supplied ||
      supplied.rootPath !== path ||
      !numericIdentity(supplied.identity) ||
      (previous &&
        (!equalIdentity(previous.identity, supplied.identity) || previous.kind !== 'directory'))
    )
      throw unavailable();
    const anchor = Object.freeze({
      rootPath: path,
      identity: Object.freeze({ ...supplied.identity }),
    });
    this.anchors.set(path, anchor);
    if (!this.entries.has(path))
      this.entries.set(path, {
        name: '',
        identity: anchor.identity,
        kind: 'directory',
        size: 0,
        mode: 0,
        nlink: 0,
        mtimeNs: '0',
        ctimeNs: '0',
      });
    return anchor;
  }
  async stat(path: string): Promise<LocalRepositoryReadEntry | undefined> {
    await this.authorize(path);
    const anchor = this.anchor(path);
    // Entries are original observed snapshots, never a freshness claim. The
    // target is still currently authorized; real bytes/listing recheck anchored
    // identity, and verify() reconciles every retained witness before exposure.
    const observed = this.entries.get(path);
    if (observed) return observed;
    if (path === anchor.rootPath) return this.entries.get(path)!;
    const parent = dirname(path);
    if (parent !== anchor.rootPath && !(await this.stat(parent))) return undefined;
    const values = await this.list(parent);
    return values.find((entry) => join(parent, entry.name) === path);
  }
  /** Original physical absence only, never a grant or freshness claim. A
   * directory listing's lexical omission is insufficient on aliasing volumes.
   * Descendants of one physically missing parent need no additional lookup;
   * final verify still reconciles the retained parent listing before exposure. */
  async assertAbsent(path: string): Promise<void> {
    await this.authorize(path);
    this.anchor(path);
    if ([...this.absentPaths].some((parent) => contains(path, parent))) return;
    if (await this.stat(path)) throw unavailable();
    if (!(await this.stat(dirname(path)))) {
      await this.assertAbsent(dirname(path));
      return;
    }
    if (this.absentPaths.size >= 256)
      throw new LocalRepositoryGitInspectionError('limit', 'read-absences');
    try {
      await this.pinRoot(path);
    } catch (error) {
      if (!(error instanceof NativeReadAnchorMissingError)) throw unavailable();
      this.absentPaths.add(path);
      return;
    }
    throw unavailable();
  }
  /** Initial metadata for exactly two already-pinned roots. The native owner
   * supplies the SAME directory-only transport; no new root is inferred here.
   * Retain original maps for final verification and never overwrite a witness. */
  async listPinnedRoots(paths: readonly string[]): Promise<void> {
    if (!Array.isArray(paths) || paths.length !== 2) throw unavailable();
    const roots = Object.freeze([paths[0], paths[1]]);
    if (
      new Set(roots).size !== 2 ||
      roots.some((path) => !this.anchors.has(path) || this.directories.has(path))
    )
      throw unavailable();
    const batch = this.authority.executeDirectoryVerification;
    if (!batch) {
      const results = await Promise.allSettled(roots.map((path) => this.list(path)));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      return;
    }
    const requests: NativeAnchoredReadRequest[] = [];
    for (const path of roots) requests.push(await this.directoryRequest(path));
    const results = await batch.call(
      this.authority,
      requests,
      this.authority.signal ?? new AbortController().signal,
      Math.max(1, Math.min(30000, this.authority.deadline - Date.now())),
    );
    if (!Array.isArray(results) || results.length !== requests.length) throw unavailable();
    for (let index = 0; index < requests.length; index++)
      await this.directoryEntries(roots[index], requests[index].identity, results[index], false);
  }
  private async directoryRequest(path: string): Promise<NativeAnchoredReadRequest> {
    await this.authorize(path);
    const anchor = this.anchor(path);
    const target = path === anchor.rootPath ? this.entries.get(path)! : await this.stat(path);
    if (!target || target.kind !== 'directory') throw unavailable();
    const parent = path === anchor.rootPath ? target : await this.stat(dirname(path));
    if (!parent) throw unavailable();
    await this.authorize(path);
    return {
      operation: 'ListDirectory',
      deniedRoots: freezeNativeReadExclusions([
        ...new Set([...this.deniedRoots, ...localRepositoryReadDirectoryExclusions(path)]),
      ]),
      file_path: path,
      rootAnchor: anchor,
      parentIdentity: parent.identity,
      identity: target.identity,
      limit: 1,
      maxEntries: 10000,
      maxNameBytes: 1024 * 1024,
    };
  }
  async list(path: string, fresh = false): Promise<LocalRepositoryReadEntry[]> {
    await this.authorize(path);
    if (!fresh && this.directories.has(path)) return [...this.directories.get(path)!.values()];
    const request = await this.directoryRequest(path);
    const result = await (
      this.authority.executeReadOperation ?? executeNativeAnchoredReadOperation
    )(
      request,
      this.authority.signal ?? new AbortController().signal,
      Math.max(1, Math.min(30000, this.authority.deadline - Date.now())),
    );
    return this.directoryEntries(path, request.identity, result, fresh);
  }
  private async directoryEntries(
    path: string,
    identity: NativeReadIdentity,
    result: { content: string; is_error: boolean },
    fresh: boolean,
  ): Promise<LocalRepositoryReadEntry[]> {
    await this.authorize(path);
    if (result.is_error && result.content === 'Anchored read limit exceeded')
      throw new LocalRepositoryGitInspectionError('limit', 'snapshot-entries');
    if (result.is_error || result.content.length > 6 * 1024 * 1024) throw unavailable();
    let value: unknown;
    try {
      value = JSON.parse(result.content);
    } catch {
      throw unavailable();
    }
    if (
      !value ||
      typeof value !== 'object' ||
      !('identity' in value) ||
      !numericIdentity(value.identity) ||
      !equalIdentity(value.identity, identity) ||
      !('entries' in value) ||
      !Array.isArray(value.entries) ||
      value.entries.length > 10000 ||
      !('truncated' in value) ||
      value.truncated !== false ||
      !('incomplete' in value) ||
      typeof value.incomplete !== 'boolean'
    )
      throw unavailable();
    if (value.incomplete) this.excludedDirectories.add(path);
    const entries = new Map<string, LocalRepositoryReadEntry>();
    let names = 0;
    for (const entry of value.entries as LocalRepositoryReadEntry[]) {
      if (
        !entry ||
        typeof entry.name !== 'string' ||
        !entry.name ||
        entry.name === '.' ||
        entry.name === '..' ||
        /[/\0]/.test(entry.name) ||
        entries.has(entry.name) ||
        !numericIdentity(entry.identity) ||
        !['file', 'directory', 'unsupported'].includes(entry.kind) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        !Number.isSafeInteger(entry.mode) ||
        entry.mode < 0 ||
        !Number.isSafeInteger(entry.nlink) ||
        entry.nlink < 0 ||
        !/^\d{1,32}$/.test(entry.mtimeNs) ||
        !/^\d{1,32}$/.test(entry.ctimeNs)
      )
        throw unavailable();
      names += Buffer.byteLength(entry.name);
      if (names > 1024 * 1024) throw unavailable();
      entries.set(entry.name, structuredClone(entry));
    }
    if (!fresh) {
      this.totalEntries += entries.size;
      if (this.totalEntries > 100000)
        throw new LocalRepositoryGitInspectionError('limit', 'snapshot-entries');
      this.directories.set(path, entries);
      for (const entry of entries.values()) this.entries.set(join(path, entry.name), entry);
    }
    return [...entries.values()];
  }
  /** File-alias text only; this never grants access to the link target. */
  async readLink(path: string) {
    const entry = await this.stat(path);
    const parent = await this.stat(dirname(path));
    if (
      !entry ||
      !parent ||
      (entry.mode & 0o170000) !== 0o120000 ||
      entry.nlink !== 1 ||
      entry.size > 4096
    )
      throw unavailable();
    await this.authorize(path);
    const result = await (
      this.authority.executeReadOperation ?? executeNativeAnchoredReadOperation
    )(
      {
        operation: 'ReadLink',
        deniedRoots: this.deniedRoots,
        file_path: path,
        rootAnchor: this.anchor(path),
        parentIdentity: parent.identity,
        identity: entry.identity,
        limit: 4096,
        expectedState: { size: entry.size, mtimeNs: entry.mtimeNs, ctimeNs: entry.ctimeNs },
      },
      this.authority.signal ?? new AbortController().signal,
      Math.max(1, Math.min(30000, this.authority.deadline - Date.now())),
    );
    await this.authorize(path);
    if (
      result.is_error ||
      result.content.length > 5464 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(result.content)
    )
      throw unavailable();
    const bytes = Buffer.from(result.content, 'base64');
    if (
      bytes.length !== entry.size ||
      bytes.length > 4096 ||
      bytes.toString('base64') !== result.content
    )
      throw unavailable();
    const text = bytes.toString('utf8');
    if (!text || text.includes('\0') || !Buffer.from(text).equals(bytes)) throw unavailable();
    this.consumed.set(path, structuredClone(entry));
    return text;
  }
  read(path: string, limit: number) {
    return this.readBytes(path, limit, false);
  }
  readPrefix(path: string, limit: number) {
    return this.readBytes(path, limit, true);
  }
  private async readBytes(path: string, limit: number, prefix: boolean) {
    const entry = await this.stat(path);
    if (!entry) throw Object.assign(Error('Repository file unavailable'), { code: 'ENOENT' });
    if (entry.kind !== 'file' || entry.nlink !== 1) throw unavailable();
    if (
      (!prefix && entry.size > Math.min(limit, 16 * 1024 * 1024)) ||
      this.totalBytes + Math.min(entry.size, limit, 16 * 1024 * 1024) > 64 * 1024 * 1024
    )
      throw new LocalRepositoryGitInspectionError('limit', 'snapshot-bytes');
    const cached = this.capturedBytes.get(path);
    if (cached) {
      await this.authorize(path);
      return Buffer.from(prefix ? cached.subarray(0, limit) : cached);
    }
    const parent = await this.stat(dirname(path));
    if (!parent) throw unavailable();
    await this.authorize(path);
    const result = await (
      this.authority.executeReadOperation ?? executeNativeAnchoredReadOperation
    )(
      {
        operation: 'ReadBytes',
        deniedRoots: this.deniedRoots,
        ...(prefix ? { prefix: true } : {}),
        file_path: path,
        rootAnchor: this.anchor(path),
        parentIdentity: parent.identity,
        identity: entry.identity,
        expectedState: { size: entry.size, mtimeNs: entry.mtimeNs, ctimeNs: entry.ctimeNs },
        limit: Math.max(1, Math.min(limit, 16 * 1024 * 1024)),
      },
      this.authority.signal ?? new AbortController().signal,
      Math.max(1, Math.min(30000, this.authority.deadline - Date.now())),
    );
    await this.authorize(path);
    if (result.is_error && result.content === 'Anchored read limit exceeded')
      throw new LocalRepositoryGitInspectionError('limit', 'snapshot-bytes');
    if (
      result.is_error ||
      result.content.length > Math.ceil(Math.min(entry.size, limit) / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(result.content) ||
      result.content.length % 4 !== 0
    )
      throw unavailable();
    const bytes = Buffer.from(result.content, 'base64');
    if (
      bytes.length !== Math.min(entry.size, prefix ? limit : entry.size) ||
      bytes.toString('base64') !== result.content ||
      (prefix && result.truncated !== bytes.length < entry.size)
    )
      throw unavailable();
    this.totalBytes += bytes.length;
    if (bytes.length === entry.size) this.capturedBytes.set(path, Buffer.from(bytes));
    this.consumed.set(path, structuredClone(entry));
    return bytes;
  }
  async verify() {
    const parents = new Map<string, Map<string, LocalRepositoryReadEntry>>();
    const snapshots = [...this.directories];
    const compare = (
      path: string,
      original: Map<string, LocalRepositoryReadEntry>,
      entries: LocalRepositoryReadEntry[],
    ) => {
      const current = new Map(entries.map((entry) => [entry.name, entry]));
      if (
        original.size !== current.size ||
        [...original].some(([name, before]) => {
          const after = current.get(name);
          return !after || !sameEntry(before, after);
        })
      )
        throw unavailable();
      return [path, current] as const;
    };
    const batch = this.authority.executeDirectoryVerification;
    if (batch) {
      for (let offset = 0; offset < snapshots.length; offset += 8) {
        const originals = snapshots.slice(offset, offset + 8);
        const requests: NativeAnchoredReadRequest[] = [];
        for (const [path] of originals) requests.push(await this.directoryRequest(path));
        const results = await batch.call(
          this.authority,
          requests,
          this.authority.signal ?? new AbortController().signal,
          Math.max(1, Math.min(30000, this.authority.deadline - Date.now())),
        );
        if (!Array.isArray(results) || results.length !== originals.length) throw unavailable();
        for (let index = 0; index < originals.length; index++) {
          const [path, original] = originals[index];
          const entries = await this.directoryEntries(
            path,
            requests[index].identity,
            results[index],
            true,
          );
          parents.set(...compare(path, original, entries));
        }
      }
    } else {
      // Each transport keeps its own current/identity/deny checks. Join bounded
      // pairs even on refusal so no helper outlives failed verification/disposal.
      for (let offset = 0; offset < snapshots.length; offset += 2) {
        const results = await Promise.allSettled(
          snapshots.slice(offset, offset + 2).map(async ([path, original]) => {
            return compare(path, original, await this.list(path, true));
          }),
        );
        for (const result of results) {
          if (result.status === 'rejected') throw result.reason;
          parents.set(...result.value);
        }
      }
    }
    for (const [path, before] of this.consumed) {
      const parent = dirname(path);
      if (!parents.has(parent))
        parents.set(
          parent,
          new Map((await this.list(parent, true)).map((entry) => [entry.name, entry])),
        );
      const after = parents.get(parent)!.get(path.slice(parent.length + 1));
      if (!after || !sameEntry(before, after)) throw unavailable();
      await this.authorize(path);
    }
    await this.authority.revalidate?.();
    this.check();
  }
}

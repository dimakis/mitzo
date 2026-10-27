import { RepositoryObservationReadAccessError } from './native-repository-observation.js';
import type {
  RepositoryObservationCapture,
  RepositoryObservationInput,
} from './native-repository-observation.js';
import type { PreparationObjectStoreCapture } from './native-repository-object-store.js';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
import {
  captureNativeReaderPathAuthorization,
  captureNativeObservationParser,
} from './local-repository-native-reader.js';

import {
  freezeNativePreparationObservationData,
  freezeNativePreparationObservationPlan,
  type NativePreparationObservationPlan,
  type NativePreparationObservationCapture,
} from './native-preparation-observation.js';

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
  capturePreparationObjectStore?(
    source: LocalRepositoryReadAnchor,
    objectFormat: 'sha1' | 'sha256',
  ): Promise<Readonly<PreparationObjectStoreCapture>>;
  verifyPreparationObjectStore?(capture: Readonly<PreparationObjectStoreCapture>): Promise<void>;
  captureRepositoryObservation?(
    input: RepositoryObservationInput,
  ): Promise<Readonly<RepositoryObservationCapture>>;
  verifyRepositoryBaseObservation?(capture: Readonly<RepositoryObservationCapture>): Promise<void>;
  verifyRepositoryObservation?(capture: Readonly<RepositoryObservationCapture>): Promise<void>;
  /** Complete current actual-owner exclusions, not inferred from scope roots. */
  deniedRoots: readonly string[];
  /** Actual retained owner's synchronous fence. Required when an additional
   * ceiling awaits after that owner's async validation; never a scope grant. */
  readonly assertCurrentSync?: () => void;
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
  /** SAME reader-only preparation base view. Never qualifies namespace, ALL
   * refs, objects or status. Both stages remain original-owner operations. */
  capturePreparationObservation?(
    plan: NativePreparationObservationPlan,
  ): Promise<Readonly<NativePreparationObservationCapture>>;
  verifyPreparationObservation?(
    capture: Readonly<NativePreparationObservationCapture>,
  ): Promise<void>;
  signal?: AbortSignal;
  deadline: number;
}
/** Additional operation-specific restriction. This never replaces the actual
 * owner's authority, transport or final physical-owner revalidation. */
export interface LocalRepositoryReadCeiling {
  assertReadable(path: string): Promise<void>;
  revalidate(): Promise<void>;
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
  private readonly objectStores: Readonly<PreparationObjectStoreCapture>[] = [];
  async capturePreparationObjectStore(commonDirectory: string, objectFormat: 'sha1' | 'sha256') {
    if (
      !this.authority.capturePreparationObjectStore ||
      !this.authority.verifyPreparationObjectStore
    )
      return;
    if (this.ceiling || this.preparationCapture) throw unavailable();
    await this.authorize(commonDirectory);
    const source = await this.pinRoot(commonDirectory);
    const captured = await this.authority.capturePreparationObjectStore(source, objectFormat);
    this.objectStores.push(captured);
    await this.authorize(commonDirectory);
    return captured;
  }
  hasExclusionsWithin(path?: string) {
    return [...this.excludedDirectories].some((directory) => !path || contains(directory, path));
  }
  private preparationCapture?: Readonly<NativePreparationObservationCapture>;
  private preparationVerify?: NonNullable<
    LocalRepositoryReadAuthority['verifyPreparationObservation']
  >;
  /** An intentionally partial capability, independent of optional metadata
   * labels. Consumers must reject it before generic or namespace lookups. */
  get preparationObservationOnly() {
    return !!this.preparationCapture;
  }
  static async capturePreparationBase(
    authority: LocalRepositoryReadAuthority,
    input: NativePreparationObservationPlan,
  ) {
    const plan = freezeNativePreparationObservationPlan(input);
    const access = new LocalRepositoryReadAccess(authority);
    const captureDescriptor = Object.getOwnPropertyDescriptor(
      authority,
      'capturePreparationObservation',
    );
    const verifyDescriptor = Object.getOwnPropertyDescriptor(
      authority,
      'verifyPreparationObservation',
    );
    if (
      !captureDescriptor ||
      !('value' in captureDescriptor) ||
      typeof captureDescriptor.value !== 'function' ||
      !verifyDescriptor ||
      !('value' in verifyDescriptor) ||
      typeof verifyDescriptor.value !== 'function'
    )
      throw unavailable();
    const capture = captureDescriptor.value as NonNullable<
      LocalRepositoryReadAuthority['capturePreparationObservation']
    >;
    const verify = verifyDescriptor.value as NonNullable<
      LocalRepositoryReadAuthority['verifyPreparationObservation']
    >;
    for (const path of [plan.sourceAnchor.rootPath, plan.gitDirectory, plan.commonAnchor.rootPath])
      await access.authorize(path);
    const captured = await Reflect.apply(capture, authority, [plan]);
    const data = freezeNativePreparationObservationData(captured.observation);
    // Preserve the EXACT actual reader's capture identity for later verification.
    // Reprojection below validates/retains only immutable physical data.
    const paths: string[] = [];
    for (const root of data.anchors) {
      if (
        ![plan.sourceAnchor.rootPath, plan.gitDirectory, plan.commonAnchor.rootPath].includes(
          root.rootPath,
        )
      )
        throw unavailable();
      const original =
        root.rootPath === plan.sourceAnchor.rootPath
          ? plan.sourceAnchor
          : root.rootPath === plan.commonAnchor.rootPath
            ? plan.commonAnchor
            : undefined;
      if (original && !equalIdentity(root.entry.identity, original.identity)) throw unavailable();
      await access.authorize(root.rootPath);
      access.anchors.set(
        root.rootPath,
        Object.freeze({ rootPath: root.rootPath, identity: root.entry.identity }),
      );
      access.entries.set(root.rootPath, root.entry);
    }
    for (const directory of data.directories) {
      const root = data.anchors[directory.anchor].rootPath;
      const path = directory.parent === -1 ? root : join(paths[directory.parent], directory.name);
      if (
        !contains(path, root) ||
        (directory.parent !== -1 &&
          data.directories[directory.parent].anchor !== directory.anchor) ||
        paths.includes(path)
      )
        throw unavailable();
      await access.authorize(path);
      paths.push(path);
      access.entries.set(path, directory.entry);
      access.directories.set(path, new Map(directory.entries.map((entry) => [entry.name, entry])));
      for (const entry of directory.entries) access.entries.set(join(path, entry.name), entry);
      if (directory.incomplete) access.excludedDirectories.add(path);
    }
    for (const file of data.files) {
      const path = join(paths[file.directory], file.name);
      await access.authorize(path);
      const observed = access.entries.get(path);
      if (!observed || !sameEntry(observed, file.entry)) throw unavailable();
      access.capturedBytes.set(path, Buffer.from(file.bytes, 'base64'));
    }
    for (const item of data.absent) {
      const path = join(paths[item.directory], item.name);
      await access.authorize(path);
      if (access.entries.has(path)) throw unavailable();
      access.absentPaths.add(path);
    }
    access.preparationCapture = captured;
    access.preparationVerify = verify;
    return access;
  }
  private repositoryCapture?: Readonly<RepositoryObservationCapture>;
  private assertCapturedPath?: (path: string) => void;
  private readonly repositoryLinks = new Map<string, string>();
  get canCaptureRepositoryObservation() {
    return (
      !this.repositoryCapture &&
      this.anchors.size === 0 &&
      !!captureNativeReaderPathAuthorization(this.authority) &&
      typeof this.authority.captureRepositoryObservation === 'function' &&
      typeof this.authority.verifyRepositoryObservation === 'function'
    );
  }
  get repositoryBaseObservation() {
    return this.repositoryCapture?.plan.mode === 'base' ? this.repositoryCapture : undefined;
  }
  /** Explicit partial HEAD metadata, never generic directory/namespace facts. */
  async headMetadataEntries(path: string) {
    await this.authorize(path);
    const capture = this.repositoryCapture;
    if (!capture || !['base', 'task-topology'].includes(capture.plan.mode)) throw unavailable();
    const directory = capture.data.directories.find((item) => item.path === path);
    if (!directory) throw unavailable();
    return directory.names.map((name) => this.entries.get(join(path, name))!);
  }
  get repositoryObservationMode() {
    return this.repositoryCapture?.plan.mode;
  }
  async captureRepositoryObservation(input: RepositoryObservationInput) {
    if (
      this.repositoryCapture ||
      this.anchors.size ||
      !this.authority.captureRepositoryObservation ||
      !this.authority.verifyRepositoryObservation
    )
      throw unavailable();
    await this.authorize(input.sourcePath);
    if (input.taskRoot) await this.authorize(input.taskRoot);
    let captured: Readonly<RepositoryObservationCapture>;
    try {
      captured = await this.authority.captureRepositoryObservation(input);
    } catch (error) {
      if (error instanceof RepositoryObservationReadAccessError)
        throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
      throw error;
    }
    if (
      captured.plan.mode !== input.mode ||
      captured.plan.sourcePath !== input.sourcePath ||
      captured.plan.taskRoot !== input.taskRoot ||
      captured.plan.workspaceId !== input.workspaceId
    )
      throw unavailable();
    for (const item of captured.data.entries) {
      this.entries.set(item.path, item.entry);
      if (item.entry.kind === 'directory')
        this.anchors.set(
          item.path,
          Object.freeze({ rootPath: item.path, identity: item.entry.identity }),
        );
    }
    for (const directory of captured.data.directories)
      if (directory.complete) {
        this.directories.set(
          directory.path,
          new Map(
            directory.names.map((name) => [name, this.entries.get(join(directory.path, name))!]),
          ),
        );
        if (directory.incomplete) this.excludedDirectories.add(directory.path);
      }
    for (const file of captured.data.files) {
      const bytes = Buffer.from(file.bytes, 'base64');
      if (file.link) this.repositoryLinks.set(file.path, bytes.toString('utf8'));
      else this.capturedBytes.set(file.path, bytes);
    }
    for (const path of captured.data.absent) this.absentPaths.add(path);
    this.repositoryCapture = captured;
    this.assertCapturedPath = captureNativeObservationParser(this.authority, captured);
    this.check();
  }
  private totalBytes = 0;
  private inFlightBytes = 0;
  private totalEntries = 0;
  private directoryRevision = 0;
  private readonly ceiling?: Readonly<{
    owner: LocalRepositoryReadCeiling;
    assertReadable: LocalRepositoryReadCeiling['assertReadable'];
    revalidate: LocalRepositoryReadCeiling['revalidate'];
    originalCurrentSync: () => void;
  }>;
  private readonly nativePathAuthorization?: ReturnType<
    typeof captureNativeReaderPathAuthorization
  >;
  constructor(
    private readonly authority: LocalRepositoryReadAuthority,
    ceiling?: LocalRepositoryReadCeiling,
  ) {
    if (ceiling !== undefined) {
      if (!ceiling || typeof ceiling !== 'object' || Array.isArray(ceiling)) throw unavailable();
      const readable = Object.getOwnPropertyDescriptor(ceiling, 'assertReadable');
      const revalidate = Object.getOwnPropertyDescriptor(ceiling, 'revalidate');
      const originalCurrent = Object.getOwnPropertyDescriptor(authority, 'assertCurrentSync');
      if (
        !readable ||
        !('value' in readable) ||
        typeof readable.value !== 'function' ||
        !revalidate ||
        !('value' in revalidate) ||
        typeof revalidate.value !== 'function' ||
        !originalCurrent ||
        !('value' in originalCurrent) ||
        typeof originalCurrent.value !== 'function'
      )
        throw unavailable();
      this.ceiling = Object.freeze({
        owner: ceiling,
        assertReadable: readable.value,
        revalidate: revalidate.value,
        originalCurrentSync: originalCurrent.value,
      });
    }
    this.nativePathAuthorization = ceiling
      ? captureNativeReaderPathAuthorization(authority)
      : undefined;
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
      if (this.assertCapturedPath) {
        // Only the exact original factory's immutable observation permits this
        // path. No physical read can fall back from the captured-only view.
        await this.assertCeiling(path, false);
        this.assertCapturedPath(path);
        await this.assertCeiling(path, false);
        return;
      }
      const native = this.nativePathAuthorization;
      // Only this exact factory reader starts its original entry with fresh
      // currentness before any effect or await. Enter it immediately after the
      // first ceiling instead of checking the same owner twice at that boundary.
      await this.assertCeiling(path, !native);
      if (native) {
        const result: unknown = await Reflect.apply(native.assertReadable, native.reader, [path]);
        if (result !== undefined) throw unavailable();
      } else await this.authority.assertReadable(path);
      this.check();
      await this.assertCeiling(path);
    } catch (error) {
      this.authority.signal?.throwIfAborted();
      if (error instanceof LocalRepositoryGitInspectionError) throw error;
      throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
    }
    this.check();
  }
  private async assertCeiling(path: string, originalCurrent = true) {
    if (
      this.ceiling &&
      (await Reflect.apply(this.ceiling.assertReadable, this.ceiling.owner, [path])) !== undefined
    )
      throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
    if (originalCurrent) this.assertOriginalCurrentSync();
    this.check();
  }
  private assertOriginalCurrentSync() {
    if (!this.ceiling) return;
    const result: unknown = Reflect.apply(this.ceiling.originalCurrentSync, this.authority, []);
    if (result !== undefined) {
      // A synchronous fence cannot become an async authority wait. Join a
      // rejected value to avoid an unhandled rejection while refusing it.
      void Promise.resolve(result).catch(() => {});
      throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
    }
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
    if (this.preparationCapture || this.repositoryCapture) throw unavailable();
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
    if (this.preparationCapture || this.repositoryCapture) {
      if ([...this.absentPaths].some((parent) => contains(path, parent))) return undefined;
      throw unavailable();
    }
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
    if (this.preparationCapture || this.repositoryCapture) throw unavailable();
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
    if (this.repositoryCapture) {
      for (const path of paths) {
        await this.authorize(path);
        if (!this.directories.has(path)) throw unavailable();
      }
      return;
    }
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
    if (this.preparationCapture || this.repositoryCapture) throw unavailable();
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
  private parseDirectoryEntries(
    identity: NativeReadIdentity,
    result: { content: string; is_error: boolean },
  ) {
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
    return { entries, incomplete: value.incomplete };
  }
  private async directoryEntries(
    path: string,
    identity: NativeReadIdentity,
    result: { content: string; is_error: boolean },
    fresh: boolean,
  ): Promise<LocalRepositoryReadEntry[]> {
    await this.authorize(path);
    const { entries, incomplete } = this.parseDirectoryEntries(identity, result);
    if (!fresh && this.totalEntries + entries.size > 100000)
      throw new LocalRepositoryGitInspectionError('limit', 'snapshot-entries');
    if (incomplete) this.excludedDirectories.add(path);
    if (!fresh) {
      this.totalEntries += entries.size;
      this.directories.set(path, entries);
      for (const entry of entries.values()) this.entries.set(join(path, entry.name), entry);
    }
    if (!fresh || incomplete) this.directoryRevision++;
    return [...entries.values()];
  }

  /** Initial directory observations only. Every target and its parent must
   * already have an original anchored identity; this never discovers a root or
   * infers physical absence. All batch cache writes commit together. */
  async preloadDirectories(paths: readonly string[]): Promise<void> {
    this.check();
    if (
      !Array.isArray(paths) ||
      paths.length < 1 ||
      paths.length > 8 ||
      new Set(paths).size !== paths.length ||
      paths.some(
        (path) =>
          typeof path !== 'string' ||
          !isAbsolute(path) ||
          resolve(path) !== path ||
          path.includes('\0'),
      )
    )
      throw unavailable();
    const captured = Object.freeze([...paths]);
    if (this.preparationCapture || this.repositoryCapture) {
      for (const path of captured) {
        await this.authorize(path);
        if (!this.directories.has(path)) throw unavailable();
      }
      return;
    }
    const known = Object.freeze(
      captured.map((path) => {
        const anchor = this.anchor(path);
        const target = this.entries.get(path);
        const parentPath = path === anchor.rootPath ? path : dirname(path);
        const parent = this.entries.get(parentPath);
        if (!target || target.kind !== 'directory' || !parent || parent.kind !== 'directory')
          throw unavailable();
        return Object.freeze({
          path,
          parentPath,
          anchor,
          target,
          parent,
          rootPath: anchor.rootPath,
          rootIdentity: Object.freeze({ ...anchor.identity }),
          targetState: Object.freeze({
            ...target,
            identity: Object.freeze({ ...target.identity }),
          }),
          parentState: Object.freeze({
            ...parent,
            identity: Object.freeze({ ...parent.identity }),
          }),
        });
      }),
    );
    const assertKnown = () => {
      for (const item of known) {
        if (
          this.anchor(item.path) !== item.anchor ||
          this.entries.get(item.path) !== item.target ||
          this.entries.get(item.parentPath) !== item.parent ||
          item.anchor.rootPath !== item.rootPath ||
          !equalIdentity(item.anchor.identity, item.rootIdentity) ||
          item.target.name !== item.targetState.name ||
          item.parent.name !== item.parentState.name ||
          !sameEntry(item.target, item.targetState) ||
          !sameEntry(item.parent, item.parentState)
        )
          throw unavailable();
      }
    };
    const descriptor = Object.getOwnPropertyDescriptor(this.authority, 'assertCurrentSync');
    if (
      (descriptor && (!('value' in descriptor) || typeof descriptor.value !== 'function')) ||
      (!descriptor && 'assertCurrentSync' in this.authority)
    )
      throw unavailable();
    const originalCurrent = descriptor?.value as (() => unknown) | undefined;
    const current = () => {
      assertKnown();
      if (originalCurrent) {
        if (
          Object.getOwnPropertyDescriptor(this.authority, 'assertCurrentSync')?.value !==
          originalCurrent
        )
          throw unavailable();
        const result: unknown = Reflect.apply(originalCurrent, this.authority, []);
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => {});
          throw unavailable();
        }
        if (
          Object.getOwnPropertyDescriptor(this.authority, 'assertCurrentSync')?.value !==
          originalCurrent
        )
          throw unavailable();
      }
      assertKnown();
      this.check();
    };
    const revision = this.directoryRevision;
    const pending = captured.filter((path) => !this.directories.has(path));
    const requests: NativeAnchoredReadRequest[] = [];
    for (const item of known) {
      await this.authorize(item.path);
      current();
      if (item.parentPath !== item.path) {
        await this.authorize(item.parentPath);
        current();
      }
      if (pending.includes(item.path))
        requests.push(
          Object.freeze({
            operation: 'ListDirectory',
            deniedRoots: freezeNativeReadExclusions([
              ...new Set([
                ...this.deniedRoots,
                ...localRepositoryReadDirectoryExclusions(item.path),
              ]),
            ]),
            file_path: item.path,
            rootAnchor: item.anchor,
            identity: item.targetState.identity,
            parentIdentity: item.parentState.identity,
            limit: 1,
            maxEntries: 10000,
            maxNameBytes: 1024 * 1024,
          }),
        );
    }
    if (this.directoryRevision !== revision) throw unavailable();
    let results: readonly { content: string; is_error: boolean }[] = [];
    if (requests.length) {
      const batch = this.authority.executeDirectoryVerification;
      if (batch !== undefined && typeof batch !== 'function') throw unavailable();
      if (batch) {
        results = await Reflect.apply(batch, this.authority, [
          Object.freeze(requests),
          this.authority.signal ?? new AbortController().signal,
          Math.max(1, Math.min(30000, this.authority.deadline - Date.now())),
        ]);
        current();
      } else {
        const sequential: Array<{ content: string; is_error: boolean }> = [];
        for (const request of requests) {
          sequential.push(
            await Reflect.apply(
              this.authority.executeReadOperation ?? executeNativeAnchoredReadOperation,
              this.authority,
              [
                request,
                this.authority.signal ?? new AbortController().signal,
                Math.max(1, Math.min(30000, this.authority.deadline - Date.now())),
              ],
            ),
          );
          current();
        }
        results = sequential;
      }
    }
    if (!Array.isArray(results) || results.length !== requests.length) throw unavailable();
    let outputBytes = 0;
    const staged = results.map((result, index) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw unavailable();
      const content = Object.getOwnPropertyDescriptor(result, 'content');
      const error = Object.getOwnPropertyDescriptor(result, 'is_error');
      if (
        !content ||
        !('value' in content) ||
        typeof content.value !== 'string' ||
        !error ||
        !('value' in error) ||
        typeof error.value !== 'boolean'
      )
        throw unavailable();
      outputBytes += Buffer.byteLength(content.value);
      if (outputBytes > 2 * 1024 * 1024 - 1024) throw unavailable();
      return {
        path: requests[index].file_path,
        ...this.parseDirectoryEntries(requests[index].identity, {
          content: content.value,
          is_error: error.value,
        }),
      };
    });
    const added = staged.reduce((sum, item) => sum + item.entries.size, 0);
    if (this.totalEntries + added > 100000)
      throw new LocalRepositoryGitInspectionError('limit', 'snapshot-entries');
    for (const path of captured) {
      await this.authorize(path);
      current();
    }
    if (this.directoryRevision !== revision) throw unavailable();
    current();
    if (this.directoryRevision !== revision) throw unavailable();
    // No await after the final genuine original-owner fence. Parsing, aggregate
    // budgets and every target's post-result ceiling all succeeded above.
    for (const item of staged) {
      this.directories.set(item.path, item.entries);
      for (const entry of item.entries.values())
        this.entries.set(join(item.path, entry.name), entry);
      if (item.incomplete) this.excludedDirectories.add(item.path);
    }
    this.totalEntries += added;
    if (staged.length) this.directoryRevision++;
  }
  /** File-alias text only; this never grants access to the link target. */
  async readLink(path: string) {
    if (this.repositoryCapture) {
      await this.authorize(path);
      const value = this.repositoryLinks.get(path);
      if (value === undefined) throw unavailable();
      return value;
    }
    if (this.preparationCapture) throw unavailable();
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
    const observed = await this.stat(path);
    if (!observed) throw Object.assign(Error('Repository file unavailable'), { code: 'ENOENT' });
    const entry = structuredClone(observed); // Retain the exact byte/state expectation across waits.
    if (entry.kind !== 'file' || entry.nlink !== 1) throw unavailable();
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      (!prefix && entry.size > Math.min(limit, 16 * 1024 * 1024))
    )
      throw new LocalRepositoryGitInspectionError('limit', 'snapshot-bytes');
    const cached = this.capturedBytes.get(path);
    if (cached) {
      await this.authorize(path);
      return Buffer.from(prefix ? cached.subarray(0, limit) : cached);
    }
    if (this.preparationCapture || this.repositoryCapture) throw unavailable();
    // Reserve before the parent/current/transport awaits. Independently known
    // reads may overlap, but their aggregate capture budget never does. Cached
    // bytes above perform no new physical read and need no new reservation.
    const reservation = Math.min(entry.size, limit, 16 * 1024 * 1024);
    if (this.totalBytes + this.inFlightBytes + reservation > 64 * 1024 * 1024)
      throw new LocalRepositoryGitInspectionError('limit', 'snapshot-bytes');
    this.inFlightBytes += reservation;
    try {
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
          limit: Math.max(1, reservation),
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
    } finally {
      this.inFlightBytes -= reservation;
    }
  }
  async verify() {
    for (const capture of this.objectStores)
      await this.authority.verifyPreparationObjectStore!(capture);
    if (this.repositoryCapture) {
      await this.authority.verifyRepositoryObservation!(this.repositoryCapture);
      await this.verifyCurrentOwner();
      return;
    }
    if (this.preparationCapture) {
      for (const path of this.entries.keys()) await this.authorize(path);
      await Reflect.apply(this.preparationVerify!, this.authority, [this.preparationCapture]);
      await this.verifyCurrentOwner();
      return;
    }
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
    await this.verifyCurrentOwner();
  }
  private async verifyCurrentOwner() {
    await this.authority.revalidate?.();
    this.check();
    if (this.ceiling) {
      try {
        if ((await Reflect.apply(this.ceiling.revalidate, this.ceiling.owner, [])) !== undefined)
          throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
        this.assertOriginalCurrentSync();
      } catch {
        this.authority.signal?.throwIfAborted();
        throw new LocalRepositoryGitInspectionError('access', 'read-access-required');
      }
      this.check();
    }
  }
}

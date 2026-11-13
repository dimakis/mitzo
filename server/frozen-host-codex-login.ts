import { SessionRuntimeError, findSessionRuntimeError } from './session-runtime-error.js';
import { reportCodexCredentialInvalidation } from './codex-tool-validation-error.js';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { AccountBinding } from '@mitzo/protocol';
import { readBoundedFile } from './bounded-file-read.js';
import { codexPrivateDirectory, protectCodexProfileRoots } from './codex-private-path.js';
import { verifyCodexAccount, type CodexAccountProfile } from './codex-account.js';

import { HostCodexLoginCustodySchema, type HostCodexLoginCustody } from './host-codex-custody.js';

import {
  captureLoginRefreshAnchor,
  captureLoginRefreshVersion,
  prepareLoginRefreshKeys,
  loginRefreshSigningKey,
  HostCodexLoginRefreshVerifier,
} from './host-codex-login-refresh.js';

const unavailable = () => new Error('Host Codex login unavailable');
import {
  initialLoginRefreshLedger,
  readLoginRefreshLedger,
  writeLoginRefreshLedger,
  LOGIN_REFRESH_LEDGER_BYTES,
  syncLoginRefreshDirectory,
  type LoginRefreshState,
} from './host-codex-login-refresh-ledger.js';
const refreshStateName = 'login-refresh.json';
import {
  directory,
  sameIdentity,
  readAuth,
  fileStamp,
  sameFileStamp,
  type FileStamp,
  type Identity,
  type AuthIdentity,
} from './host-codex-login-files.js';
export interface FrozenHostCodexClient {
  readonly modelProvider?: string;
  validateConfiguration?(configuration: unknown): void;
  initialize(): Promise<void>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}
export interface FrozenHostCodexLoginLease<T extends FrozenHostCodexClient> {
  /** This exact private connection must be passed to the existing conversation owner. */
  client: T;
  binding: AccountBinding;
  assertCurrent(): Promise<void>;
  /** Canonical API credential custody, without native account/catalog discovery. */
  assertCredentialCurrent?(signal: AbortSignal): Promise<void>;
  /** Read-only issuer-key qualification. No operator or execution authority. */
  qualifyCredentialRefresh?(signal: AbortSignal): void | Promise<void>;
  /** Final synchronous file/cancellation fence; asynchronous account proof is
   * refreshed by assertCurrent at the preceding owning admission boundary. */
  assertCurrentSync(): void;
  /** Transport closure preserves the private home and every uncertainty record. */
  close(): void;
}

/** Private bootstrap effect: call only after the existing command ledger has
 * durably claimed uncertainty. This is bounded login custody, not host/runtime,
 * agent, permission or workspace authority. The caller still owns those fences.
 * It never adopts or cleans a previous home and never launches twice.
 */
export class FrozenHostCodexLogin {
  #attempted = false;
  #closed = false;
  #sourceRoot: Identity;
  #sourceAuth: AuthIdentity;
  #homeRoot: Identity;
  #homeAuth: AuthIdentity;
  #profile: CodexAccountProfile;
  #signal?: AbortSignal;
  #refreshProof?: HostCodexLoginCustody['refreshProof'];
  #refreshVerifier?: HostCodexLoginRefreshVerifier;
  #ledgerCache?: { stamp: FileStamp; state: LoginRefreshState };
  #lastValidated?: {
    source: ReturnType<typeof readAuth>['stamp'];
    home: ReturnType<typeof readAuth>['stamp'];
  };
  private constructor(
    profile: CodexAccountProfile,
    readonly privateHome: string,
    sourceRoot: Identity,
    sourceAuth: AuthIdentity,
    signal?: AbortSignal,
    retained?: HostCodexLoginCustody,
  ) {
    this.#profile = structuredClone(profile);
    this.#sourceRoot = sourceRoot;
    this.#sourceAuth = sourceAuth;
    this.#homeRoot = directory(privateHome);
    const initialHome = retained ? undefined : readAuth(privateHome);
    this.#homeAuth = retained?.homeAuth ?? initialHome!.identity;
    this.#signal = signal;
    if (retained) this.#refreshProof = retained.refreshProof;
    else {
      const anchor = captureLoginRefreshAnchor(initialHome!.bytes, profile);
      if (anchor) {
        const version = captureLoginRefreshVersion(initialHome!.bytes, profile);
        const path = join(privateHome, refreshStateName);
        writeFileSync(path, initialLoginRefreshLedger({ source: version, home: version }), {
          mode: 0o600,
          flag: 'wx',
          flush: true,
        });
        syncLoginRefreshDirectory(privateHome);
        this.#refreshProof = {
          ...anchor,
          ledger: (({ dev, ino }) => ({ dev, ino }))(lstatSync(path)),
        };
      }
    }
    if (this.#refreshProof)
      this.#refreshVerifier = new HostCodexLoginRefreshVerifier(this.#refreshProof, profile);
  }
  static async prepare(
    profile: CodexAccountProfile,
    signal?: AbortSignal,
    retained?: HostCodexLoginCustody,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!profile.credentialRef) throw unavailable();
    directory(profile.credentialRef);
    const source = readAuth(profile.credentialRef).bytes;
    if (captureLoginRefreshAnchor(source, profile)) {
      const required = [loginRefreshSigningKey(source, profile)];
      if (retained?.refreshProof)
        required.push(loginRefreshSigningKey(readAuth(retained.privateHome).bytes, profile));
      await prepareLoginRefreshKeys(signal, required);
    }
    signal?.throwIfAborted();
  }
  static capture(
    profile: CodexAccountProfile,
    options: { privateRoot?: string; signal?: AbortSignal; bootstrapId?: string } = {},
  ): FrozenHostCodexLogin {
    try {
      options.signal?.throwIfAborted();
      if (options.bootstrapId !== undefined && !/^[a-f0-9]{64}$/.test(options.bootstrapId))
        throw unavailable();
      if (
        !profile.credentialRef ||
        profile.nativeAuth ||
        profile.sandboxProviderType ||
        profile.sandboxProviderId ||
        profile.sandboxGrantId ||
        !profile.planType.trim() ||
        profile.planType.trim().toLowerCase() === 'api'
      )
        throw unavailable();
      const sourceRoot = directory(profile.credentialRef),
        source = readAuth(profile.credentialRef);
      sameIdentity(directory(profile.credentialRef), sourceRoot);
      options.signal?.throwIfAborted();
      const root = options.privateRoot ?? codexPrivateDirectory();
      // Do not create a root through symlinks. Its existing canonical parent is
      // checked before the single owned directory is made.
      try {
        directory(root);
      } catch {
        const parent = resolve(root, '..');
        if (realpathSync(parent) !== parent) throw unavailable();
        mkdirSync(root, { mode: 0o700 });
      }
      directory(root);
      protectCodexProfileRoots([root]);
      const privateHome = options.bootstrapId
        ? join(root, `host-login-${options.bootstrapId}`)
        : mkdtempSync(join(root, 'host-login-'));
      if (options.bootstrapId) mkdirSync(privateHome, { mode: 0o700 });
      options.signal?.throwIfAborted();
      writeFileSync(join(privateHome, 'auth.json'), source.bytes, { mode: 0o600, flag: 'wx' });
      const login = new FrozenHostCodexLogin(
        profile,
        privateHome,
        sourceRoot,
        source.identity,
        options.signal,
      );
      login.assertFilesCurrent(true);
      return login;
    } catch {
      throw unavailable();
    }
  }
  /** Reopen only the original physically retained home. The native store owns
   * this snapshot; a path or bootstrap ID alone is never adoption authority.
   */
  static reopen(
    profile: CodexAccountProfile,
    raw: unknown,
    signal?: AbortSignal,
  ): FrozenHostCodexLogin {
    try {
      signal?.throwIfAborted();
      const snapshot = HostCodexLoginCustodySchema.parse(raw);
      if (
        profile.credentialRef !== snapshot.sourcePath ||
        profile.nativeAuth ||
        profile.sandboxProviderType ||
        profile.sandboxProviderId ||
        profile.sandboxGrantId
      )
        throw unavailable();
      sameIdentity(directory(snapshot.privateHome), snapshot.homeRoot);
      sameIdentity(directory(snapshot.sourcePath), snapshot.sourceRoot);
      const source = readAuth(snapshot.sourcePath).identity;
      const home = readAuth(snapshot.privateHome).identity;
      sameIdentity(source, snapshot.sourceAuth);
      sameIdentity(home, snapshot.homeAuth);
      if (
        !snapshot.refreshProof &&
        (source.sha256 !== snapshot.sourceAuth.sha256 || home.sha256 !== snapshot.homeAuth.sha256)
      ) {
        if (
          captureLoginRefreshAnchor(readAuth(snapshot.sourcePath).bytes, profile) ||
          captureLoginRefreshAnchor(readAuth(snapshot.privateHome).bytes, profile)
        )
          throw new SessionRuntimeError('login_refresh_reauthorization');
        throw unavailable();
      }
      const login = new FrozenHostCodexLogin(
        profile,
        snapshot.privateHome,
        snapshot.sourceRoot,
        snapshot.sourceAuth,
        signal,
        snapshot,
      );
      // A cold object grants no lease. Changed bytes require signature proof
      // after public-key acquisition in connect, before native launch.
      login.assertFilesCurrent(true);
      protectCodexProfileRoots([snapshot.privateHome]);
      return login;
    } catch (error) {
      throw findSessionRuntimeError(error) ?? unavailable();
    }
  }
  custodySnapshot(): HostCodexLoginCustody {
    this.assertFilesCurrent();
    return HostCodexLoginCustodySchema.parse({
      privateHome: this.privateHome,
      sourcePath: this.#profile.credentialRef,
      sourceRoot: this.#sourceRoot,
      sourceAuth: this.#sourceAuth,
      homeRoot: this.#homeRoot,
      homeAuth: this.#homeAuth,
      ...(this.#refreshProof ? { refreshProof: this.#refreshProof } : {}),
    });
  }
  private assertFilesCurrent(allowPendingRefresh = false): void {
    if (this.#closed) throw unavailable();
    this.#signal?.throwIfAborted();
    sameIdentity(directory(this.#profile.credentialRef!), this.#sourceRoot);
    const source = readAuth(this.#profile.credentialRef!);
    sameIdentity(source.identity, this.#sourceAuth);
    sameIdentity(directory(this.privateHome), this.#homeRoot);
    const home = readAuth(this.privateHome);
    sameIdentity(home.identity, this.#homeAuth);
    if (!this.#refreshProof) {
      if (
        source.identity.sha256 !== this.#sourceAuth.sha256 ||
        home.identity.sha256 !== this.#homeAuth.sha256
      ) {
        if (
          captureLoginRefreshAnchor(source.bytes, this.#profile) ||
          captureLoginRefreshAnchor(home.bytes, this.#profile)
        )
          throw new SessionRuntimeError('login_refresh_reauthorization');
        throw unavailable();
      }
      return;
    }
    this.assertRefreshVersions(source, home, allowPendingRefresh);
    if (!allowPendingRefresh) this.#lastValidated = { source: source.stamp, home: home.stamp };
  }
  /** The physically anchored private ledger retains accepted versions across a
   * cold reopen. Native history/custody stays immutable; no token bytes persist
   * here. Synchronous reads/CAS have no await or reentrant callback. */
  private assertRefreshVersions(
    source: ReturnType<typeof readAuth>,
    home: ReturnType<typeof readAuth>,
    allowPending: boolean,
  ) {
    const path = join(this.privateHome, this.#refreshProof?.ledger.name ?? refreshStateName);
    const assertLedgerFile = (entry: Stats) => {
      sameIdentity(entry, this.#refreshProof!.ledger);
      if (
        !entry.isFile() ||
        entry.nlink !== 1 ||
        entry.uid !== process.getuid?.() ||
        (entry.mode & 0o077) !== 0
      )
        throw unavailable();
    };
    const leaf = lstatSync(path);
    assertLedgerFile(leaf);
    const cached = this.#ledgerCache;
    if (
      cached &&
      sameFileStamp(leaf, cached.stamp) &&
      cached.state.source.sha256 === source.identity.sha256 &&
      cached.state.home.sha256 === home.identity.sha256
    )
      return;
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(fd);
      const current = () => {
        this.#signal?.throwIfAborted();
        sameIdentity(directory(this.privateHome), this.#homeRoot);
        for (const entry of [fstatSync(fd!), lstatSync(path)]) assertLedgerFile(entry);
      };
      current();
      const bytes = readBoundedFile(fd, LOGIN_REFRESH_LEDGER_BYTES);
      const previous = readLoginRefreshLedger(bytes);
      const state = previous.state;
      const next = structuredClone(state);
      for (const [name, observed] of [
        ['source', source],
        ['home', home],
      ] as const) {
        if (state[name].issuedAt < this.#refreshProof!.issuedAt) throw unavailable();
        if (state[name].sha256 === observed.identity.sha256) continue;
        if (allowPending) {
          // Only connect can qualify pending bytes. This read-only object is
          // not authority to launch, snapshot new custody or run a tool.
          const candidate = captureLoginRefreshAnchor(observed.bytes, this.#profile);
          if (
            !candidate ||
            candidate.identitySha256 !== this.#refreshProof!.identitySha256 ||
            candidate.issuedAt < state[name].issuedAt ||
            (candidate.issuedAt === state[name].issuedAt &&
              state[name].tokenPairs.includes(
                captureLoginRefreshVersion(observed.bytes, this.#profile).tokenPairs[0],
              ))
          )
            throw unavailable();
          continue;
        }
        next[name] = this.#refreshVerifier!.verify(observed.bytes, state[name]);
      }
      const after = fstatSync(fd);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw unavailable();
      current();
      if (JSON.stringify(next) !== JSON.stringify(state)) {
        writeLoginRefreshLedger(fd, previous, next);
        current();
      }
      this.#ledgerCache = { stamp: fileStamp(fstatSync(fd)), state: next };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private qualifyCredentialRefresh(signal?: AbortSignal): void | Promise<void> {
    if (this.#closed) throw unavailable();
    this.#signal?.throwIfAborted();
    signal?.throwIfAborted();
    if (!this.#refreshVerifier) return;
    // This shortcut only skips public-key discovery, never the caller's final
    // physical/authentication fence. Changed or aliased files are reread there.
    if (
      this.#lastValidated &&
      Object.entries(this.#lastValidated).every(([name, expected]) => {
        const path = name === 'source' ? this.#profile.credentialRef! : this.privateHome;
        const info = lstatSync(join(path, 'auth.json'));
        return Object.entries(expected).every(
          ([key, value]) => info[key as keyof typeof expected] === value,
        );
      })
    )
      return;
    sameIdentity(directory(this.#profile.credentialRef!), this.#sourceRoot);
    sameIdentity(directory(this.privateHome), this.#homeRoot);
    const source = readAuth(this.#profile.credentialRef!),
      home = readAuth(this.privateHome);
    sameIdentity(source.identity, this.#sourceAuth);
    sameIdentity(home.identity, this.#homeAuth);
    return this.#refreshVerifier.qualifyUnknownSigningKey([source.bytes, home.bytes], signal);
  }
  async connect<T extends FrozenHostCodexClient>(
    launch: (privateHome: string) => T,
    beforeInvalidation?: (error: SessionRuntimeError) => void,
    isValidationLive?: () => boolean,
  ): Promise<FrozenHostCodexLoginLease<T>> {
    if (this.#attempted) throw unavailable();
    this.#attempted = true;
    let client: T | undefined;
    const close = () => {
      if (this.#closed) return;
      this.#closed = true;
      this.#signal?.removeEventListener('abort', close);
      try {
        client?.close();
      } catch {
        /* Retain private custody after close failure. */
      }
    };
    const fail = (error: unknown, validation = false): never => {
      const cause = reportCodexCredentialInvalidation(
        error,
        validation,
        this.#signal?.aborted ?? false,
        beforeInvalidation,
        isValidationLive,
      );
      close();
      throw findSessionRuntimeError(error) ?? new Error('Host Codex login unavailable', { cause });
    };
    try {
      if (this.#refreshVerifier) await this.#refreshVerifier.prepare(this.#signal);
      await this.qualifyCredentialRefresh(this.#signal);
      this.assertFilesCurrent();
      client = launch(this.privateHome);
      this.#signal?.addEventListener('abort', close, { once: true });
      this.assertFilesCurrent();
      await client.initialize();
      await this.qualifyCredentialRefresh(this.#signal);
      this.assertFilesCurrent();
      const binding = await verifyCodexAccount(client, this.#profile);
      await this.qualifyCredentialRefresh(this.#signal);
      this.assertFilesCurrent();
      const ownedClient = client;
      return {
        client: ownedClient,
        get binding() {
          return structuredClone(binding);
        },
        close,
        qualifyCredentialRefresh: (signal) => this.qualifyCredentialRefresh(signal),
        assertCurrentSync: () => {
          try {
            this.assertFilesCurrent();
          } catch (error) {
            fail(error, true);
          }
        },
        assertCurrent: async () => {
          try {
            await this.qualifyCredentialRefresh(this.#signal);
            this.assertFilesCurrent();
            await verifyCodexAccount(ownedClient, this.#profile, binding);
            await this.qualifyCredentialRefresh(this.#signal);
            this.assertFilesCurrent();
          } catch (error) {
            fail(error, true);
          }
        },
      };
    } catch (error) {
      return fail(error);
    }
  }
}

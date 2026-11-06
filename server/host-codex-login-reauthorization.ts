import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  HostCodexCustodySchema,
  type HostCodexCustody,
  type HostCodexLoginCustody,
} from './host-codex-custody.js';
import { codexAccountBinding, type CodexAccountProfile } from './codex-account.js';
import { directory, sameIdentity, readAuth } from './host-codex-login-files.js';
import {
  captureLoginRefreshAnchor,
  captureLoginRefreshVersion,
  HostCodexLoginRefreshVerifier,
} from './host-codex-login-refresh.js';
import { readBoundedFile } from './bounded-file-read.js';

const unavailable = () => Error('Reviewed host login reauthorization unavailable');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const prepared = new WeakSet<object>();
/** Explicit operator maintenance only. Read-only preparation proves the selected
 * current account/login; it never infers missing original custody or dispatches
 * a provider request. The native store journals intent before materialization. */
export class HostCodexLoginReauthorization {
  readonly operationId: string;
  readonly #before: HostCodexCustody;
  readonly #login: HostCodexLoginCustody;
  readonly #sourceHash: string;
  readonly #homeHash: string;
  private constructor(
    private readonly profile: CodexAccountProfile,
    before: HostCodexCustody,
    private readonly operator: { assertCurrent(): void; assertOffline(): void },
    private readonly signal: AbortSignal,
    private readonly verifier: HostCodexLoginRefreshVerifier,
    private readonly state: {
      source: ReturnType<typeof captureLoginRefreshVersion>;
      home: ReturnType<typeof captureLoginRefreshVersion>;
    },
  ) {
    this.#before = structuredClone(before);
    this.#login = structuredClone(before.login) as HostCodexLoginCustody;
    this.#sourceHash = state.source.sha256;
    this.#homeHash = state.home.sha256;
    this.operationId = digest([
      'host-login-reauthorization-v1',
      codexAccountBinding(profile),
      before,
      state,
      verifier.anchor,
    ]);
    prepared.add(this);
    Object.freeze(this);
  }
  static async prepare(
    profile: CodexAccountProfile,
    raw: unknown,
    operator: { assertCurrent(): void; assertOffline(): void },
    signal: AbortSignal,
  ): Promise<HostCodexLoginReauthorization> {
    signal.throwIfAborted();
    operator.assertCurrent();
    profile = structuredClone(profile);
    const before = HostCodexCustodySchema.parse(structuredClone(raw));
    if (
      'kind' in before.login ||
      before.login.refreshProof ||
      profile.nativeAuth ||
      profile.credentialRef !== before.login.sourcePath
    )
      throw unavailable();
    const login = before.login;
    sameIdentity(directory(login.sourcePath), login.sourceRoot);
    sameIdentity(directory(login.privateHome), login.homeRoot);
    const source = readAuth(login.sourcePath),
      home = readAuth(login.privateHome);
    sameIdentity(source.identity, login.sourceAuth);
    sameIdentity(home.identity, login.homeAuth);
    const anchor = captureLoginRefreshAnchor(source.bytes, profile);
    if (
      !anchor ||
      captureLoginRefreshAnchor(home.bytes, profile)?.identitySha256 !== anchor.identitySha256
    )
      throw unavailable();
    const verifier = new HostCodexLoginRefreshVerifier(anchor, profile);
    await verifier.prepare(signal);
    await verifier.qualifyUnknownSigningKey([source.bytes, home.bytes], signal);
    signal.throwIfAborted();
    operator.assertCurrent();
    // Explicit approval enrolls these *current*, cryptographically matching
    // files. It does not claim their prior bytes were the same OAuth session.
    const initial = { sha256: '', issuedAt: -1, tokenPairs: [] };
    const state = {
      source: verifier.verify(source.bytes, initial, 'reauthorize-current'),
      // Historical expiry is not account authority: the current source above
      // must authenticate first. Native still owns refreshing this private login.
      home: verifier.verify(home.bytes, initial, 'reauthorize-history'),
    };
    const operation = new HostCodexLoginReauthorization(
      profile,
      before,
      operator,
      signal,
      verifier,
      state,
    );
    operation.assertCurrent();
    return operation;
  }
  originalCustody(): HostCodexCustody {
    this.assertPrepared();
    return structuredClone(this.#before);
  }
  binding() {
    this.assertPrepared();
    return codexAccountBinding(this.profile);
  }
  summary() {
    this.assertPrepared();
    return {
      operationId: this.operationId,
      accountId: this.profile.accountId,
      accountLabel: this.profile.accountLabel,
      email: this.profile.email,
      planType: this.profile.planType,
      model: this.profile.model,
    };
  }
  private assertPrepared() {
    if (!prepared.has(this)) throw unavailable();
  }
  assertCurrent(): void {
    this.assertPrepared();
    this.signal.throwIfAborted();
    this.operator.assertCurrent();
    sameIdentity(directory(this.#login.sourcePath), this.#login.sourceRoot);
    sameIdentity(directory(this.#login.privateHome), this.#login.homeRoot);
    const source = readAuth(this.#login.sourcePath),
      home = readAuth(this.#login.privateHome);
    sameIdentity(source.identity, this.#login.sourceAuth);
    sameIdentity(home.identity, this.#login.homeAuth);
    if (source.identity.sha256 !== this.#sourceHash || home.identity.sha256 !== this.#homeHash)
      throw unavailable();
    const initial = { sha256: '', issuedAt: -1, tokenPairs: [] };
    this.verifier.verify(source.bytes, initial, 'reauthorize-current');
    this.verifier.verify(home.bytes, initial, 'reauthorize-history');
    this.signal.throwIfAborted();
    this.operator.assertCurrent();
  }
  assertMutationCurrent(): void {
    this.assertCurrent();
    this.operator.assertOffline();
    this.assertCurrent();
  }
  /** Caller must already have durably recorded this exact operation and original
   * custody. A retry may adopt only its exact retained, owner-only artifact. */
  materialize(): HostCodexCustody {
    this.assertMutationCurrent();
    const name = `login-refresh-${this.operationId}.json`;
    const path = join(this.#login.privateHome, name);
    const bytes = Buffer.from(JSON.stringify(this.state));
    try {
      writeFileSync(path, bytes, { mode: 0o600, flag: 'wx', flush: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        !readBoundedFile(fd, 4096).equals(bytes)
      )
        throw unavailable();
      this.assertCurrent();
      const anchor = {
        ...this.verifier.anchor,
        issuedAt: Math.min(this.state.source.issuedAt, this.state.home.issuedAt),
      };
      const updated = HostCodexCustodySchema.parse({
        ...this.#before,
        login: {
          ...this.#login,
          refreshProof: { ...anchor, ledger: { dev: info.dev, ino: info.ino, name } },
        },
      });
      if (!isDeepStrictEqual({ ...updated, login: this.#login }, this.#before)) throw unavailable();
      return updated;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

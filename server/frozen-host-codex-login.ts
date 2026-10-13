import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { AccountBinding } from '@mitzo/protocol';
import { z } from 'zod';
import { readBoundedFile } from './bounded-file-read.js';
import { codexPrivateDirectory, protectCodexProfileRoots } from './codex-private-path.js';
import { verifyCodexAccount, type CodexAccountProfile } from './codex-account.js';

import { HostCodexLoginCustodySchema, type HostCodexLoginCustody } from './host-codex-custody.js';

const unavailable = () => new Error('Host Codex login unavailable');
const Auth = z.object({
  auth_mode: z.literal('chatgpt').optional(),
  OPENAI_API_KEY: z.null().optional(),
  tokens: z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    id_token: z.string().min(1),
    account_id: z.string().min(1),
  }),
});
type Identity = { dev: number; ino: number };
type AuthIdentity = Identity & { sha256: string };
function directory(path: string): Identity {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path)
    throw unavailable();
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    throw unavailable();
  return { dev: stat.dev, ino: stat.ino };
}
function sameIdentity(actual: Identity, expected: Identity): void {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw unavailable();
}
function readAuth(root: string): { bytes: Buffer; identity: AuthIdentity } {
  let fd: number | undefined;
  try {
    fd = openSync(
      join(root, 'auth.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      before.uid !== process.getuid?.()
    )
      throw unavailable();
    const bytes = readBoundedFile(fd, Math.min(before.size, 1024 * 1024));
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw unavailable();
    Auth.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const leaf = lstatSync(join(root, 'auth.json'));
    sameIdentity(leaf, before);
    if (!leaf.isFile()) throw unavailable();
    return {
      bytes,
      identity: {
        dev: before.dev,
        ino: before.ino,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export interface FrozenHostCodexClient {
  initialize(): Promise<void>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}
export interface FrozenHostCodexLoginLease<T extends FrozenHostCodexClient> {
  /** This exact private connection must be passed to the existing conversation owner. */
  client: T;
  binding: AccountBinding;
  assertCurrent(): Promise<void>;
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
  private constructor(
    profile: CodexAccountProfile,
    readonly privateHome: string,
    sourceRoot: Identity,
    sourceAuth: AuthIdentity,
    signal?: AbortSignal,
  ) {
    this.#profile = structuredClone(profile);
    this.#sourceRoot = sourceRoot;
    this.#sourceAuth = sourceAuth;
    this.#homeRoot = directory(privateHome);
    this.#homeAuth = readAuth(privateHome).identity;
    this.#signal = signal;
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
      login.assertFilesCurrent();
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
      if (source.sha256 !== snapshot.sourceAuth.sha256 || home.sha256 !== snapshot.homeAuth.sha256)
        throw unavailable();
      const login = new FrozenHostCodexLogin(
        profile,
        snapshot.privateHome,
        snapshot.sourceRoot,
        snapshot.sourceAuth,
        signal,
      );
      login.assertFilesCurrent();
      protectCodexProfileRoots([snapshot.privateHome]);
      return login;
    } catch {
      throw unavailable();
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
    });
  }
  private assertFilesCurrent(): void {
    if (this.#closed) throw unavailable();
    this.#signal?.throwIfAborted();
    sameIdentity(directory(this.#profile.credentialRef!), this.#sourceRoot);
    const source = readAuth(this.#profile.credentialRef!).identity;
    sameIdentity(source, this.#sourceAuth);
    if (source.sha256 !== this.#sourceAuth.sha256) throw unavailable();
    sameIdentity(directory(this.privateHome), this.#homeRoot);
    const home = readAuth(this.privateHome).identity;
    sameIdentity(home, this.#homeAuth);
    if (home.sha256 !== this.#homeAuth.sha256) throw unavailable();
  }
  async connect<T extends FrozenHostCodexClient>(
    launch: (privateHome: string) => T,
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
    try {
      this.assertFilesCurrent();
      client = launch(this.privateHome);
      this.#signal?.addEventListener('abort', close, { once: true });
      this.assertFilesCurrent();
      await client.initialize();
      this.assertFilesCurrent();
      const binding = await verifyCodexAccount(client, this.#profile);
      this.assertFilesCurrent();
      const ownedClient = client;
      return {
        client: ownedClient,
        get binding() {
          return structuredClone(binding);
        },
        close,
        assertCurrentSync: () => {
          try {
            this.assertFilesCurrent();
          } catch {
            close();
            throw unavailable();
          }
        },
        assertCurrent: async () => {
          try {
            this.assertFilesCurrent();
            await verifyCodexAccount(ownedClient, this.#profile, binding);
            this.assertFilesCurrent();
          } catch {
            close();
            throw unavailable();
          }
        },
      };
    } catch {
      close();
      throw unavailable();
    }
  }
}

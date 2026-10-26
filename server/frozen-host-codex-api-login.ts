import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AccountBinding } from '@mitzo/protocol';
import { AccountBindingSchema } from '@mitzo/protocol';
import { readBoundedFile } from './bounded-file-read.js';
import { codexPrivateDirectory, protectCodexProfileRoots } from './codex-private-path.js';
import {
  HostCodexApiLoginCustodySchema,
  type HostCodexApiLoginCustody,
} from './host-codex-custody.js';
import type {
  FrozenHostCodexClient,
  FrozenHostCodexLoginLease,
} from './frozen-host-codex-login.js';

const unavailable = () => Error('API Codex login unavailable');
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const Auth = z.object({
  auth_mode: z.literal('apikey').optional(),
  OPENAI_API_KEY: z.string().min(1),
  tokens: z.null().optional(),
});
export interface CodexApiKeyAuthority {
  assertReady(signal: AbortSignal): Promise<void>;
  /** Returns only the current controller-qualified key under its rotation gate. */
  resolveKey(accountId: string, signal: AbortSignal): Promise<string>;
}
function directory(path: string) {
  const info = lstatSync(path);
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    realpathSync(path) !== path ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw unavailable();
  return { dev: info.dev, ino: info.ino };
}
function auth(home: string) {
  let fd: number | undefined;
  try {
    fd = openSync(
      join(home, 'auth.json'),
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
    const bytes = readBoundedFile(fd, 1024 * 1024);
    const after = fstatSync(fd),
      leaf = lstatSync(join(home, 'auth.json'));
    if (
      !leaf.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.dev !== leaf.dev ||
      before.ino !== leaf.ino ||
      before.size !== after.size ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs
    )
      throw unavailable();
    const value = Auth.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    return {
      identity: { dev: before.dev, ino: before.ino, sha256: digest(bytes) },
      credentialDigest: digest(value.OPENAI_API_KEY),
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** API authentication custody in the existing native conversation row. The
 * account key controller remains authoritative; API mode alone proves no billing identity.
 * Capture is an effect and belongs after the durable command's bootstrap claim. */
export class FrozenHostCodexApiLogin {
  #attempted = false;
  #closed = false;
  #saved: HostCodexApiLoginCustody;
  private constructor(
    saved: HostCodexApiLoginCustody,
    private readonly authority: CodexApiKeyAuthority,
    private readonly signal: AbortSignal,
    private readonly fresh: boolean,
  ) {
    this.#saved = structuredClone(saved);
  }
  get privateHome() {
    return this.#saved.privateHome;
  }
  static async capture(
    binding: AccountBinding,
    options: {
      privateRoot?: string;
      bootstrapId: string;
      authority: CodexApiKeyAuthority;
      signal: AbortSignal;
    },
  ) {
    try {
      binding = AccountBindingSchema.parse(structuredClone(binding));
      if (binding.provider !== 'openai' || !/^[a-f0-9]{64}$/.test(options.bootstrapId))
        throw unavailable();
      options.signal.throwIfAborted();
      const key = await options.authority.resolveKey(binding.accountId, options.signal);
      if (!key.trim()) throw unavailable();
      options.signal.throwIfAborted();
      const root = options.privateRoot ?? codexPrivateDirectory();
      if (!lstatSync(root, { throwIfNoEntry: false })) {
        if (realpathSync(resolve(root, '..')) !== resolve(root, '..')) throw unavailable();
        mkdirSync(root, { mode: 0o700 });
      }
      directory(root);
      protectCodexProfileRoots([root]);
      const privateHome = join(root, `host-api-${options.bootstrapId}`);
      mkdirSync(privateHome, { mode: 0o700 });
      const homeRoot = directory(privateHome);
      // No auth exists until the private API bootstrap RPC succeeds.
      const login = new FrozenHostCodexApiLogin(
        {
          kind: 'api-key',
          privateHome,
          binding: AccountBindingSchema.parse(binding),
          credentialDigest: digest(key),
          homeRoot,
          homeAuth: { dev: 0, ino: 0, sha256: '0'.repeat(64) },
        },
        options.authority,
        options.signal,
        true,
      );
      // The key was just resolved under its controller fence. Only synchronous
      // private-home setup intervenes; connect rechecks the key before launch.
      login.assertRoot();
      return login;
    } catch {
      throw unavailable();
    }
  }
  static async reopen(
    binding: AccountBinding,
    raw: unknown,
    authority: CodexApiKeyAuthority,
    signal: AbortSignal,
  ) {
    try {
      const saved = HostCodexApiLoginCustodySchema.parse(raw);
      if (!isDeepStrictEqual(saved.binding, binding)) throw unavailable();
      const login = new FrozenHostCodexApiLogin(saved, authority, signal, false);
      login.assertFiles();
      await login.assertKey();
      login.assertFiles();
      return login;
    } catch {
      throw unavailable();
    }
  }
  private assertRoot() {
    if (this.#closed) throw unavailable();
    this.signal.throwIfAborted();
    if (!isDeepStrictEqual(directory(this.privateHome), this.#saved.homeRoot)) throw unavailable();
  }
  private assertFiles() {
    this.assertRoot();
    const current = auth(this.privateHome);
    if (
      !isDeepStrictEqual(current.identity, this.#saved.homeAuth) ||
      current.credentialDigest !== this.#saved.credentialDigest
    )
      throw unavailable();
  }
  private async assertKey(signal = this.signal) {
    this.assertRoot();
    signal.throwIfAborted();
    const key = await this.authority.resolveKey(this.#saved.binding.accountId, signal);
    signal.throwIfAborted();
    this.assertRoot();
    if (digest(key) !== this.#saved.credentialDigest) throw unavailable();
  }
  custodySnapshot() {
    this.assertFiles();
    return HostCodexApiLoginCustodySchema.parse(structuredClone(this.#saved));
  }
  async connect<T extends FrozenHostCodexClient>(
    launch: (home: string) => Promise<T>,
  ): Promise<FrozenHostCodexLoginLease<T>> {
    if (this.#attempted) throw unavailable();
    this.#attempted = true;
    let client: T | undefined;
    const close = () => {
      if (this.#closed) return;
      this.#closed = true;
      this.signal.removeEventListener('abort', close);
      try {
        client?.close();
      } catch {
        /* Retain custody. */
      }
    };
    try {
      this.assertRoot();
      if (!this.fresh) this.assertFiles();
      await this.assertKey();
      client = await launch(this.privateHome);
      this.signal.addEventListener('abort', close, { once: true });
      this.assertRoot();
      await client.initialize();
      this.assertRoot();
      if (this.fresh) {
        const current = auth(this.privateHome);
        if (current.credentialDigest !== this.#saved.credentialDigest) throw unavailable();
        this.#saved.homeAuth = current.identity;
      }
      this.assertFiles();
      const owned = client;
      const assertCredentialCurrent = async (signal: AbortSignal) => {
        try {
          this.assertFiles();
          await this.assertKey(signal);
          this.assertFiles();
        } catch {
          close();
          throw unavailable();
        }
      };
      const assertCurrent = async () => {
        try {
          this.assertFiles();
          await this.assertKey();
          const observed = await owned.request('account/read', { refreshToken: false });
          z.object({
            account: z.object({ type: z.literal('apiKey') }),
            requiresOpenaiAuth: z.literal(true),
          }).parse(observed);
          this.assertFiles();
          await this.assertKey();
          this.assertFiles();
        } catch {
          close();
          throw unavailable();
        }
      };
      await assertCurrent();
      const bindingForLease = structuredClone(this.#saved.binding);
      return {
        client: owned,
        get binding() {
          return structuredClone(bindingForLease);
        },
        close,
        assertCurrent,
        assertCredentialCurrent,
        assertCurrentSync: () => {
          try {
            this.assertFiles();
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

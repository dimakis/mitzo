import { keychainController, type KeychainControllerAccess } from './keychain-controller.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { prepareKeychainHelper, type PreparedKeychainHelper } from './keychain-helper-authority.js';

export const VaultReferenceSchema = z
  .object({
    service: z.string().min(1).max(256),
    account: z.string().min(1).max(256),
    persistentRef: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .optional(),
  })
  .strict();
export type VaultReference = z.infer<typeof VaultReferenceSchema>;
export interface CredentialVault {
  save(id: string, secret: string): Promise<VaultReference>;
  link(ref: VaultReference): Promise<VaultReference>;
  read(ref: VaultReference): Promise<string>;
  remove(ref: VaultReference): Promise<void>;
}
export class KeychainUnavailableError extends Error {
  constructor(readonly code: 'unlock_on_mac' | 'item_missing' | 'unavailable') {
    super(
      code === 'unlock_on_mac'
        ? 'Unlock Apple Keychain on the Mac, then retry'
        : code === 'item_missing'
          ? 'Apple Keychain item changed or is missing; re-enroll the connection'
          : 'Apple Keychain credential is unavailable',
    );
    this.name = 'KeychainUnavailableError';
  }
}
type HelperRequest = VaultReference & {
  operation:
    | 'save'
    | 'link'
    | 'read'
    | 'remove'
    | 'rotation-read'
    | 'rotation-write'
    | 'rotation-authorize'
    | 'rotation-create';
  secret?: string;
  authorization?: string;
  namespace?: string;
  version?: string;
  expectedVersion?: string | null;
};
type RunHelper = (file: string, request: HelperRequest, signal?: AbortSignal) => Promise<string>;
const runHelper: RunHelper = (file, request, signal) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [],
      {
        encoding: 'utf8',
        timeout: request.operation === 'rotation-authorize' ? 120_000 : 30_000,
        signal,
        maxBuffer: 64 * 1024,
        env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' },
      },
      (error, stdout) => {
        if (error) reject(new Error('Apple Keychain helper is unavailable'));
        else resolve(stdout);
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(request));
  });
const exec = promisify(execFile);
async function verifyHelper(file: string, requirement: string) {
  if (process.platform !== 'darwin') throw new Error('Apple Keychain requires macOS');
  await exec('/usr/bin/codesign', ['--verify', '--strict', '-R', `=${requirement}`, file], {
    timeout: 10_000,
    env: { PATH: '/usr/bin:/bin' },
  });
}
type RetainedHelper = {
  ready: Promise<PreparedKeychainHelper>;
  users: number;
  retired: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
export class MacKeychainVault implements CredentialVault {
  private retained?: RetainedHelper;
  constructor(
    private file: string,
    private requirement: string,
    private run: RunHelper = runHelper,
    private verify = verifyHelper,
    private controller: KeychainControllerAccess = keychainController,
    private prepare: (file: string) => PreparedKeychainHelper = prepareKeychainHelper,
    private options: { reuseVerifiedHelper?: boolean } = {},
  ) {}
  /** Retire only executable code. In-flight readers release their own lease. */
  disposeVerifiedHelper(): void {
    const retained = this.retained;
    if (!retained) return;
    this.retained = undefined;
    retained.retired = true;
    clearTimeout(retained.timer);
    if (retained.users === 0)
      void retained.ready.then(
        (helper) => helper.dispose(),
        () => {},
      );
  }
  private async acquireHelper(): Promise<{ helper: PreparedKeychainHelper; release(): void }> {
    if (!this.options.reuseVerifiedHelper) {
      const helper = this.prepare(this.file);
      try {
        await this.verify(helper.file, this.requirement);
        return { helper, release: () => helper.dispose() };
      } catch (error) {
        helper.dispose();
        throw error;
      }
    }
    const retained: RetainedHelper = (this.retained ??= {
      users: 0,
      retired: false,
      ready: (async () => {
        const helper = this.prepare(this.file);
        try {
          if (!helper.assertCurrent) throw new Error('Unpinned helper');
          helper.assertCurrent();
          await this.verify(helper.file, this.requirement);
          helper.assertCurrent();
          return helper;
        } catch (error) {
          helper.dispose();
          throw error;
        }
      })(),
    });
    clearTimeout(retained.timer);
    retained.users++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (--retained.users !== 0) return;
      if (retained.retired)
        void retained.ready.then(
          (helper) => helper.dispose(),
          () => {},
        );
      else {
        retained.timer = setTimeout(() => this.disposeVerifiedHelper(), 30_000);
        retained.timer.unref();
      }
    };
    try {
      const helper = await retained.ready;
      if (retained.retired) throw new Error('Retired helper');
      helper.assertCurrent!();
      return { helper, release };
    } catch (error) {
      if (this.retained === retained) this.disposeVerifiedHelper();
      release();
      throw error;
    }
  }
  private async call(request: HelperRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    let lease: Awaited<ReturnType<MacKeychainVault['acquireHelper']>>;
    try {
      lease = await this.acquireHelper();
    } catch {
      throw new Error('Apple Keychain helper is unavailable');
    }
    let result: {
      ok?: boolean;
      code?: string;
      secret?: string;
      service?: string;
      account?: string;
      persistentRef?: string;
      value?: string;
      version?: string | null;
      managed?: boolean;
    };
    try {
      const authorization = await this.controller.authorization();
      signal?.throwIfAborted();
      if (this.options.reuseVerifiedHelper) lease.helper.assertCurrent!();
      const input = {
        ...request,
        authorization,
        ...(this.controller.namespace ? { namespace: this.controller.namespace } : {}),
      };
      result = JSON.parse(
        await (signal
          ? this.run(lease.helper.file, input, signal)
          : this.run(lease.helper.file, input)),
      );
    } catch {
      throw new KeychainUnavailableError('unavailable');
    } finally {
      lease.release();
    }
    if (result?.ok !== true)
      throw new KeychainUnavailableError(
        result?.code === 'unlock_on_mac' || result?.code === 'item_missing'
          ? result.code
          : 'unavailable',
      );
    return result;
  }
  async rotateOpenAI(
    reference: { service: string; account: string },
    operation: 'rotation-read' | 'rotation-write' | 'rotation-authorize' | 'rotation-create',
    extra: { secret?: string; version?: string; expectedVersion?: string | null } = {},
    signal?: AbortSignal,
  ) {
    const parsed = VaultReferenceSchema.parse(reference);
    if (
      parsed.persistentRef ||
      parsed.service.startsWith('mitzo.connection.') ||
      !this.controller.enrollRotation
    )
      throw new KeychainUnavailableError('unavailable');
    await this.controller.enrollRotation({ service: parsed.service, account: parsed.account });
    return this.call({ operation, ...parsed, ...extra }, signal);
  }
  async save(id: string, secret: string) {
    if (!/^[A-Za-z0-9-]+$/.test(id) || !secret || Buffer.byteLength(secret, 'utf8') > 16_384)
      throw new Error('Invalid credential input');
    const ref = { service: `mitzo.connection.${id}`, account: 'credential' };
    const result = await this.call({ operation: 'save', ...ref, secret });
    if (!result.persistentRef) throw new KeychainUnavailableError('unavailable');
    const parsed = VaultReferenceSchema.safeParse({ ...ref, persistentRef: result.persistentRef });
    if (!parsed.success) throw new KeychainUnavailableError('unavailable');
    const pinned = parsed.data;
    await this.controller.enroll(pinned);
    return pinned;
  }
  async link(reference: VaultReference) {
    const ref = VaultReferenceSchema.parse(reference);
    const result = await this.call({ operation: 'link', ...ref });
    if (!result.persistentRef) throw new KeychainUnavailableError('unavailable');
    const parsed = VaultReferenceSchema.safeParse({ ...ref, persistentRef: result.persistentRef });
    if (!parsed.success) throw new KeychainUnavailableError('unavailable');
    const pinned = parsed.data;
    await this.controller.enroll(pinned);
    return pinned;
  }
  async read(reference: VaultReference) {
    const ref = VaultReferenceSchema.parse(reference);
    const result = await this.call({ operation: 'read', ...ref });
    if (
      typeof result.secret !== 'string' ||
      !result.secret ||
      Buffer.byteLength(result.secret, 'utf8') > 16_384
    )
      throw new KeychainUnavailableError('unavailable');
    return result.secret;
  }
  async remove(reference: VaultReference) {
    const ref = VaultReferenceSchema.parse(reference);
    if (!ref.service.startsWith('mitzo.connection.'))
      throw new Error('Only Mitzo-owned credentials can be removed');
    await this.call({ operation: 'remove', ...ref });
    await this.controller.forget(ref);
  }
}

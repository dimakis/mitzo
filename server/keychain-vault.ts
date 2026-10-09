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
    'save' | 'link' | 'read' | 'remove' | 'rotation-read' | 'rotation-write' | 'rotation-authorize';
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
export class MacKeychainVault implements CredentialVault {
  constructor(
    private file: string,
    private requirement: string,
    private run: RunHelper = runHelper,
    private verify = verifyHelper,
    private controller: KeychainControllerAccess = keychainController,
    private prepare: (file: string) => PreparedKeychainHelper = prepareKeychainHelper,
  ) {}
  private async call(request: HelperRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    let helper: PreparedKeychainHelper | undefined;
    try {
      helper = this.prepare(this.file);
      await this.verify(helper.file, this.requirement);
    } catch {
      helper?.dispose();
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
      const input = {
        ...request,
        authorization,
        ...(this.controller.namespace ? { namespace: this.controller.namespace } : {}),
      };
      result = JSON.parse(
        await (signal ? this.run(helper.file, input, signal) : this.run(helper.file, input)),
      );
    } catch {
      throw new KeychainUnavailableError('unavailable');
    } finally {
      helper.dispose();
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
    operation: 'rotation-read' | 'rotation-write' | 'rotation-authorize',
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

import { randomBytes, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { VaultReferenceSchema, type VaultReference } from './keychain-vault.js';

interface ControllerRecord {
  authorization: string;
  items: VaultReference[];
}
export interface KeychainControllerAccess {
  readonly namespace?: string;
  authorization(): Promise<string>;
  enroll(ref: VaultReference): Promise<void>;
  forget(ref: VaultReference): Promise<void>;
}
/** This private capability authenticates the trusted host controller, not arbitrary helper invocations.
 * Same-user unsandboxed processes are part of the host trust boundary; the agent has no access here. */
export class KeychainController implements KeychainControllerAccess {
  private static queues = new Map<string, Promise<unknown>>();
  private directory: string;
  constructor(
    directory?: string,
    readonly namespace = 'default',
  ) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(namespace))
      throw new Error('Invalid Keychain controller namespace');
    this.directory = resolve(directory ?? join(homedir(), '.mitzo', 'keychain-helper', namespace));
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const work = (KeychainController.queues.get(this.directory) ?? Promise.resolve()).then(
      operation,
    );
    const tail = work.catch(() => {});
    KeychainController.queues.set(this.directory, tail);
    void tail.then(() => {
      if (KeychainController.queues.get(this.directory) === tail)
        KeychainController.queues.delete(this.directory);
    });
    return work;
  }
  private get path() {
    return join(this.directory, 'controller.json');
  }
  private async privatePath(path: string, mode: number) {
    const info = await lstat(path);
    if (
      (mode === 0o700 ? !info.isDirectory() : !info.isFile()) ||
      (info.mode & 0o777) !== mode ||
      info.uid !== process.getuid?.()
    )
      throw new Error('Keychain controller files must be private and owned by the current user');
  }
  initialize() {
    return this.serialized(() => this.initializeRecord());
  }
  private async initializeRecord() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.privatePath(this.directory, 0o700);
    // Publish a complete record atomically, even if another host process initializes it.
    const temporary = join(this.directory, `${randomUUID()}.json`);
    try {
      await writeFile(
        temporary,
        JSON.stringify({ authorization: randomBytes(32).toString('hex'), items: [] }),
        { flag: 'wx', mode: 0o600 },
      );
      try {
        await link(temporary, this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    await this.privatePath(this.path, 0o600);
  }
  private async record(): Promise<ControllerRecord> {
    await this.initializeRecord();
    try {
      const info = await lstat(this.path);
      if (info.size > 1_048_576) throw new Error();
      const record = JSON.parse(await readFile(this.path, 'utf8')) as ControllerRecord;
      if (
        !record ||
        !/^[a-f0-9]{64}$/.test(record.authorization) ||
        !Array.isArray(record.items) ||
        record.items.length > 256 ||
        record.items.some(
          (item) => !VaultReferenceSchema.safeParse(item).success || !item.persistentRef,
        )
      )
        throw new Error();
      return record;
    } catch {
      throw new Error('Invalid Keychain controller record');
    }
  }
  authorization() {
    return this.serialized(async () => (await this.record()).authorization);
  }
  private update(change: (record: ControllerRecord) => void) {
    return this.serialized(async () => {
      const record = await this.record();
      change(record);
      if (record.items.length > 256) throw new Error('Keychain connection limit reached');
      const temporary = join(this.directory, `${randomUUID()}.json`);
      try {
        await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }
  enroll(ref: VaultReference) {
    if (!VaultReferenceSchema.safeParse(ref).success || !ref.persistentRef)
      return Promise.reject(new Error('Invalid Keychain reference'));
    ref = { ...ref };
    return this.update((record) => {
      record.items = record.items.filter((item) => item.persistentRef !== ref.persistentRef);
      record.items.push(ref);
    });
  }
  forget(ref: VaultReference) {
    return this.update((record) => {
      record.items = record.items.filter((item) => item.persistentRef !== ref.persistentRef);
    });
  }
}
export const keychainController = new KeychainController();

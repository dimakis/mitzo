import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  lstatSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
const Row = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    label: z.string().trim().min(1).max(120),
    revision: z.number().int().positive(),
    state: z.enum([
      'connected',
      'disconnected',
      'reauth_required',
      'connecting',
      'disconnecting',
      'recovery_required',
    ]),
    modelDiscovery: z.enum(['pending', 'reconciliation_required']).optional(),
    account: z
      .object({ email: z.string().max(254), planType: z.enum(['free', 'plus', 'pro']) })
      .optional(),
  })
  .strict();
export type PersonalConnection = z.infer<typeof Row>;
export interface ConnectionSelection {
  connectionId: string;
  expectedRevision: number;
}
interface Adapter {
  invalidate(): void;
  disconnect(): Promise<void>;
}
/** Metadata is display-only. No disk row can authorize provider access. */
export class PersonalConnections<T extends Adapter> {
  private rows: PersonalConnection[] = [];
  private adapters = new Map<string, T>();
  constructor(
    private readonly path: string,
    private readonly factory: (id: string, label: string) => T,
  ) {
    const parent = lstatSync(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.mode & 0o077 ||
      parent.uid !== process.getuid?.()
    )
      throw new Error('Private connection metadata directory required');
    try {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.mode & 0o077 ||
          stat.uid !== process.getuid?.() ||
          stat.size > 1_000_000
        )
          throw new Error('Invalid connection metadata');
        this.rows = z
          .array(Row)
          .max(100)
          .parse(JSON.parse(readFileSync(fd, 'utf8')));
      } finally {
        closeSync(fd);
      }
      if (new Set(this.rows.map((r) => r.id)).size !== this.rows.length)
        throw new Error('Duplicate connection metadata');
      for (const row of this.rows) {
        if (row.modelDiscovery === 'pending') {
          row.state = 'recovery_required';
          row.modelDiscovery = 'reconciliation_required';
          row.revision++;
        } else if (row.state === 'connected') {
          row.state = 'reauth_required';
          row.revision++;
        } else if (row.state === 'connecting' || row.state === 'disconnecting') {
          row.state = 'recovery_required';
          row.revision++;
        }
      }
      this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  private save() {
    const temp = `${this.path}.${randomUUID()}`;
    try {
      const fd = openSync(
        temp,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, JSON.stringify(this.rows));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
      const parent = openSync(
        dirname(this.path),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    } catch {
      for (const adapter of this.adapters.values()) adapter.invalidate();
      for (const row of this.rows) row.state = 'recovery_required';
      throw new Error('Connection metadata persistence failed; host recovery required');
    }
  }
  list() {
    return structuredClone(this.rows);
  }
  create(label: string, id = `personal_${randomUUID().replaceAll('-', '')}`) {
    if (this.rows.length >= 100 || this.rows.some((r) => r.id === id))
      throw new Error('Connection limit or identity conflict');
    const row = Row.parse({ id, label, revision: 1, state: 'disconnected' });
    this.rows.push(row);
    this.save();
    return structuredClone(row);
  }
  private row(id: string, revision: number) {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.revision !== revision)
      throw new Error('Connection changed; refresh before retry');
    return row;
  }
  begin(id: string, revision: number) {
    const row = this.row(id, revision);
    if (!['disconnected', 'reauth_required'].includes(row.state))
      throw new Error('Connection requires explicit cleanup before login');
    const adapter = this.adapters.get(id) ?? this.factory(id, row.label);
    this.adapters.set(id, adapter);
    row.state = 'connecting';
    row.revision++;
    this.save();
    return { id, revision: row.revision, adapter };
  }
  complete(lease: { id: string; revision: number }, account: PersonalConnection['account']) {
    const row = this.row(lease.id, lease.revision);
    if (row.state !== 'connecting') throw new Error('Connection attempt is no longer current');
    row.account = Row.shape.account.parse(account);
    row.state = 'connected';
    row.revision++;
    this.save();
  }
  fail(lease: { id: string; revision: number }, quarantined = false) {
    const row = this.rows.find((r) => r.id === lease.id);
    if (!row || row.revision !== lease.revision) return;
    this.adapters.get(row.id)?.invalidate();
    row.state = quarantined ? 'recovery_required' : 'reauth_required';
    row.revision++;
    this.save();
  }
  activeAdapters() {
    return this.rows
      .filter((r) => r.state === 'connected')
      .flatMap((r) => {
        const a = this.adapters.get(r.id);
        return a ? [a] : [];
      });
  }
  adapter(id: string) {
    const row = this.rows.find((r) => r.id === id);
    if (row?.state !== 'connected') throw new Error('Connection is not authorized');
    const a = this.adapters.get(id);
    if (!a) throw new Error('Fresh authentication required');
    return a;
  }
  beginDiscovery(id: string, revision: number) {
    const row = this.row(id, revision);
    if (row.state !== 'connected' || row.modelDiscovery)
      throw new Error('Discovery is unavailable');
    const adapter = this.adapter(id);
    row.modelDiscovery = 'pending';
    row.revision++;
    this.save();
    return { id, revision: row.revision, adapter };
  }
  assertDiscovery(lease: { id: string; revision: number }) {
    const row = this.row(lease.id, lease.revision);
    if (row.state !== 'connected' || row.modelDiscovery !== 'pending')
      throw new Error('Discovery changed');
  }
  finishDiscovery(lease: { id: string; revision: number }, clean: boolean) {
    this.assertDiscovery(lease);
    const row = this.row(lease.id, lease.revision);
    if (clean) delete row.modelDiscovery;
    else {
      row.modelDiscovery = 'reconciliation_required';
      row.state = 'recovery_required';
      this.adapters.get(row.id)?.invalidate();
    }
    row.revision++;
    this.save();
    return structuredClone(row);
  }
  async disconnect(id: string, revision: number) {
    const row = this.row(id, revision);
    if (row.modelDiscovery || row.state === 'disconnecting' || row.state === 'connecting')
      throw new Error('Cancel the pending login before disconnecting');
    const adapter = this.adapters.get(id);
    const requiresRecovery = row.state === 'recovery_required';
    adapter?.invalidate();
    row.state = 'disconnecting';
    row.revision++;
    this.save();
    try {
      if (!adapter && (row.account || requiresRecovery))
        throw new Error('Prior host credential cleanup requires recovery');
      await adapter?.disconnect();
      row.state = 'disconnected';
      row.account = undefined;
      row.revision++;
      this.save();
      return structuredClone(row);
    } catch {
      row.state = 'recovery_required';
      row.revision++;
      this.save();
      throw new Error('Credential cleanup is unconfirmed; host recovery required');
    }
  }
  invalidate() {
    for (const a of this.adapters.values()) a.invalidate();
  }
}

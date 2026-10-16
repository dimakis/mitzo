import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, closeSync, openSync } from 'node:fs';
import { z } from 'zod';

export const WarmPoolSettings = z
  .object({
    enabled: z.boolean(),
    capacity: z.union([z.literal(1), z.literal(2)]),
    refill: z.enum(['auto', 'manual']),
    expiryMinutes: z.union([z.literal(0), z.literal(30), z.literal(120)]),
    cpu: z.union([z.literal(1), z.literal(2), z.literal(4)]),
    memoryGiB: z.union([z.literal(2), z.literal(4), z.literal(8)]),
  })
  .strict();
export type WarmPoolSettings = z.infer<typeof WarmPoolSettings>;
export interface WarmPoolRecord {
  id: string;
  name: string;
  physicalId: string | null;
  /** False only when preparation has provably not dispatched native create. */
  creationStarted?: boolean;
  scope: string;
  /** Immutable transport/workdir authority, independent of the creation recipe. */
  runtimeAuthority?: string;
  state: 'preparing' | 'ready' | 'claiming' | 'claimed' | 'removing' | 'removed' | 'uncertain';
  resources: { cpu: number; memoryGiB: number };
  conversationId: string | null;
  provider: string | null;
  connectionAccountId?: string | null;
  failure: string | null;
  createdAt: number;
}
export interface WarmSandbox {
  name: string;
  id: string;
  phase: string;
  poolId: string;
  providers: string[];
}
export interface WarmPoolAdapter {
  scope: string;
  runtimeAuthority?: string;
  available: boolean;
  reason: string | null;
  connectionAuthority?: { gateway: string; workspace: string };
  prepare(
    record: WarmPoolRecord,
    signal: AbortSignal,
    created?: (physicalId: string) => void,
    dispatched?: () => void,
  ): Promise<WarmSandbox>;
  inspect(record: WarmPoolRecord, signal: AbortSignal): Promise<WarmSandbox | undefined>;
  remove(record: WarmPoolRecord, signal: AbortSignal): Promise<void>;
  bind(
    record: WarmPoolRecord,
    provider: string,
    signal: AbortSignal,
    seed?: string,
    providers?: readonly string[],
  ): Promise<void>;
}
/** Legacy rows without authority may only use their exact original recipe. Never
 * infer historical authority from the currently selected gateway or image. */
export function hasWarmPoolRuntimeAuthority(
  record: Pick<WarmPoolRecord, 'scope' | 'runtimeAuthority'>,
  adapter: Pick<WarmPoolAdapter, 'scope' | 'runtimeAuthority'>,
) {
  return record.runtimeAuthority !== undefined
    ? !!adapter.runtimeAuthority && record.runtimeAuthority === adapter.runtimeAuthority
    : record.scope === adapter.scope;
}
interface State {
  revision: number;
  settings: WarmPoolSettings;
  resting: boolean;
  lastUse: number;
  operation: string | null;
  records: WarmPoolRecord[];
}
const defaults = (): State => ({
  revision: 0,
  settings: {
    enabled: false,
    capacity: 1,
    refill: 'auto',
    expiryMinutes: 120,
    cpu: 2,
    memoryGiB: 4,
  },
  resting: false,
  lastUse: Date.now(),
  operation: null,
  records: [],
});
const Request = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('settings'), settings: WarmPoolSettings }),
    z.object({ action: z.literal('prepare') }),
    z.object({ action: z.enum(['remove', 'replace', 'recheck']), id: z.string().uuid() }),
  ])
  .and(
    z.object({ revision: z.number().int().nonnegative(), requestId: z.string().min(1).max(200) }),
  );
export type WarmPoolSnapshot = ReturnType<OpenShellWarmPool['snapshot']>;
/** Single durable pool ledger. An operation reservation survives process failure;
 * readers never recover it implicitly. Only the exclusive host startup may call recoverInterrupted. */
export class OpenShellWarmPool {
  private db: Database.Database;
  now = () => Date.now();
  constructor(
    path: string,
    readonly adapter: WarmPoolAdapter,
  ) {
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
    this.db = new Database(path);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = FULL');
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS warm_pool_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS warm_pool_requests (id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response TEXT,error TEXT);`);
    this.db
      .prepare('INSERT OR IGNORE INTO warm_pool_state VALUES (1,?)')
      .run(JSON.stringify(defaults()));
  }
  private read(): State {
    return JSON.parse(
      (this.db.prepare('SELECT value FROM warm_pool_state WHERE id=1').get() as { value: string })
        .value,
    );
  }
  private write(state: State) {
    state.revision++;
    this.db.prepare('UPDATE warm_pool_state SET value=? WHERE id=1').run(JSON.stringify(state));
  }
  private reserve(expected?: number) {
    return this.db.transaction(() => {
      const s = this.read();
      if (s.operation) throw Error('Sandbox pool is busy. Refresh before retrying.');
      if (expected !== undefined && expected !== s.revision)
        throw Error('Sandbox pool settings are stale. Refresh before retrying.');
      s.operation = randomUUID();
      this.write(s);
      return s;
    })();
  }
  private persist(s: State) {
    this.db.transaction(() => {
      if (this.read().operation !== s.operation) throw Error('Sandbox pool operation changed');
      this.write(s);
    })();
  }
  private finish(s: State) {
    this.db.transaction(() => {
      if (this.read().operation !== s.operation) throw Error('Sandbox pool operation changed');
      s.operation = null;
      this.write(s);
    })();
  }
  snapshot() {
    const s = this.read();
    return {
      revision: s.revision,
      settings: s.settings,
      resting: s.resting,
      busy: !!s.operation,
      available: this.adapter.available,
      reason: this.adapter.reason,
      capabilities: {
        cpu: true,
        memory: true,
        disk: false,
        diskReason: 'This OpenShell CLI does not expose a disk limit.',
      },
      spares: s.records.filter((x) => x.state !== 'removed' && !x.conversationId),
      owned: s.records.filter((x) => x.conversationId && x.state !== 'removed'),
    };
  }
  async observe(signal: AbortSignal) {
    const snapshot = this.snapshot();
    const spares = await Promise.all(
      snapshot.spares.map(async (record) => {
        try {
          const actual = await this.adapter.inspect(record, signal);
          this.assertPhysical(record, actual);
          return {
            ...record,
            observedState:
              record.scope === this.adapter.scope &&
              record.state === 'ready' &&
              actual?.phase === 'Ready'
                ? 'ready'
                : 'unverified',
            failure:
              record.failure ??
              (record.scope !== this.adapter.scope
                ? 'Sandbox uses an older runtime recipe; replace or remove it.'
                : null),
            observedAt: this.now(),
          };
        } catch {
          return { ...record, observedState: 'unverified', observedAt: this.now() };
        }
      }),
    );
    return { ...snapshot, spares };
  }
  lookup(conversationId: string, provider: string) {
    return (
      this.read().records.find(
        (x) =>
          x.conversationId === conversationId && x.provider === provider && x.state !== 'removed',
      ) ?? null
    );
  }
  private assertPhysical(r: WarmPoolRecord, p: WarmSandbox | undefined, neutral = true) {
    if (
      !p ||
      !p.id ||
      p.name !== r.name ||
      p.poolId !== r.id ||
      (r.physicalId && p.id !== r.physicalId) ||
      !hasWarmPoolRuntimeAuthority(r, this.adapter)
    )
      throw Error('Sandbox pool physical identity changed; resource retained.');
    if (neutral && p.providers.length)
      throw Error('Unused sandbox has an unexpected provider; resource retained.');
  }
  private async fill(s: State, signal: AbortSignal) {
    if (!this.adapter.available) throw Error(this.adapter.reason ?? 'Warm sandboxes unavailable');
    // Retire only settled, unused Ready resources. Uncertain operations still reserve capacity.
    for (const old of s.records.filter(
      (r) => !r.conversationId && r.state === 'ready' && r.scope !== this.adapter.scope,
    ))
      await this.retire(s, old, signal);
    const slots = () => s.records.filter((x) => !x.conversationId && x.state !== 'removed');
    while (slots().length < s.settings.capacity) {
      signal.throwIfAborted();
      const id = randomUUID(),
        r: WarmPoolRecord = {
          id,
          name: 'mitzo-warm-' + id,
          physicalId: null,
          creationStarted: false,
          scope: this.adapter.scope,
          ...(this.adapter.runtimeAuthority
            ? { runtimeAuthority: this.adapter.runtimeAuthority }
            : {}),
          state: 'preparing',
          resources: { cpu: s.settings.cpu, memoryGiB: s.settings.memoryGiB },
          conversationId: null,
          provider: null,
          failure: null,
          createdAt: this.now(),
        };
      s.records.push(r);
      this.persist(s);
      try {
        const p = await this.adapter.prepare(
          r,
          signal,
          (physicalId) => {
            if (!physicalId || (r.physicalId && r.physicalId !== physicalId))
              throw Error('Sandbox create receipt identity changed');
            r.physicalId = physicalId;
            r.creationStarted = true;
            this.persist(s);
          },
          () => {
            r.creationStarted = true;
            this.persist(s);
          },
        );
        this.assertPhysical(r, p);
        r.physicalId = p.id;
        r.creationStarted = true;
        this.persist(s);
        const observed = await this.adapter.inspect(r, signal);
        this.assertPhysical(r, observed);
        if (observed?.phase !== 'Ready') throw Error('Prepared sandbox is not Ready');
        r.state = 'ready';
        this.persist(s);
      } catch (e) {
        r.state = 'uncertain';
        r.failure = e instanceof Error ? e.message : 'Sandbox preparation outcome unknown';
        this.persist(s);
        throw e;
      }
    }
  }
  private async retire(s: State, r: WarmPoolRecord, signal: AbortSignal) {
    if (r.conversationId || !r.physicalId)
      throw Error('Only a verified unclaimed sandbox can be removed.');
    r.state = 'removing';
    this.persist(s);
    try {
      const physical = await this.adapter.inspect(r, signal);
      if (physical) {
        this.assertPhysical(r, physical);
        await this.adapter.remove(r, signal);
        if (await this.adapter.inspect(r, signal)) throw Error('Sandbox removal is not confirmed');
      }
      r.state = 'removed';
      r.failure = null;
      this.persist(s);
    } catch (e) {
      r.state = 'uncertain';
      r.failure = e instanceof Error ? e.message : 'Sandbox removal outcome unknown';
      this.persist(s);
      throw e;
    }
  }
  async mutate(input: unknown, signal = AbortSignal.timeout(120000), operator = 'operator') {
    const r = Request.parse(input);
    if (r.action === 'settings')
      r.settings = WarmPoolSettings.parse((input as { settings: unknown }).settings);
    const key = operator + ':' + r.requestId,
      fingerprint = createHash('sha256').update(JSON.stringify(r)).digest('hex');
    const old = this.db.prepare('SELECT * FROM warm_pool_requests WHERE id=?').get(key) as
      { fingerprint: string; response: string | null; error: string | null } | undefined;
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw Error('Request ID reused for a different sandbox operation');
      if (old.error) throw Error(old.error);
      if (!old.response) throw Error('Sandbox operation outcome unknown; refresh before retrying');
      return JSON.parse(old.response) as WarmPoolSnapshot;
    }
    if (
      !this.adapter.available &&
      !(r.action === 'settings' && !r.settings.enabled && this.snapshot().spares.length === 0)
    )
      throw Error(this.adapter.reason ?? 'Warm sandboxes unavailable');
    const s = this.reserve(r.revision);
    this.db
      .prepare('INSERT INTO warm_pool_requests(id,fingerprint) VALUES (?,?)')
      .run(key, fingerprint);
    let error: unknown;
    try {
      if (r.action === 'settings') {
        const changed =
          s.settings.cpu !== r.settings.cpu || s.settings.memoryGiB !== r.settings.memoryGiB;
        s.settings = r.settings;
        s.resting = false;
        s.lastUse = this.now();
        this.persist(s);
        const unused = s.records.filter((x) => !x.conversationId && x.state !== 'removed');
        for (const x of changed ? unused : unused.slice(s.settings.capacity))
          await this.retire(s, x, signal);
        if (s.settings.enabled && s.settings.refill === 'auto') await this.fill(s, signal);
      } else if (r.action === 'prepare') {
        s.resting = false;
        s.lastUse = this.now();
        this.persist(s);
        await this.fill(s, signal);
      } else {
        const record = s.records.find((x) => x.id === r.id && x.state !== 'removed');
        if (!record || record.conversationId)
          throw Error('Only an unclaimed sandbox can be changed.');
        if (r.action === 'recheck') {
          const physical = await this.adapter.inspect(record, signal);
          if (!physical) {
            // Only an explicit operator recheck can release an absent reservation.
            // Inspect must report authoritative absence, never a transport failure.
            if (!hasWarmPoolRuntimeAuthority(record, this.adapter))
              throw Error('Sandbox pool runtime scope changed; resource retained.');
            if (!record.physicalId && record.creationStarted !== false)
              throw Error('Sandbox create outcome is unknown or unsettled; reservation retained.');
            record.state = 'removed';
          } else {
            this.assertPhysical(record, physical);
            record.physicalId = physical.id;
            record.creationStarted = true;
            this.persist(s);
            if (physical.phase !== 'Ready') throw Error('Sandbox readiness is unverified');
            record.state = 'ready';
          }
          record.failure = null;
          this.persist(s);
        } else {
          if (r.action === 'remove') {
            s.settings.enabled = false;
            this.persist(s);
          }
          await this.retire(s, record, signal);
          if (r.action === 'replace') await this.fill(s, signal);
        }
      }
    } catch (e) {
      error = e;
    } finally {
      this.finish(s);
    }
    const response = this.snapshot();
    this.db
      .prepare('UPDATE warm_pool_requests SET response=?,error=? WHERE id=?')
      .run(
        JSON.stringify(response),
        error instanceof Error ? error.message : error ? 'Sandbox operation failed' : null,
        key,
      );
    if (error) throw error;
    return response;
  }
  async claim(
    conversationId: string,
    provider: string,
    signal: AbortSignal,
    seed?: string,
    providers?: readonly string[],
    connectionAccountId?: string,
  ) {
    const existing = this.lookup(conversationId, provider);
    if (existing) {
      if (!hasWarmPoolRuntimeAuthority(existing, this.adapter))
        throw Error('Warm sandbox runtime authority differs');
      if ((existing.connectionAccountId ?? null) !== (connectionAccountId ?? null))
        throw Error('Warm sandbox connection account binding differs');
      if (existing.state !== 'claimed')
        throw Error('Prior sandbox claim is uncertain; preserve the conversation.');
      return existing;
    }
    // Never wait for the pool: another preparation may be slow. Cold admission remains available.
    if (this.read().operation) return null;
    const s = this.reserve();
    let record: WarmPoolRecord | undefined;
    try {
      if (s.records.some((x) => x.conversationId === conversationId))
        throw Error('Conversation already has another pool account binding');
      s.lastUse = this.now();
      s.resting = false;
      record = s.records.find(
        (x) =>
          x.state === 'ready' &&
          !x.conversationId &&
          x.scope === this.adapter.scope &&
          x.resources.cpu === s.settings.cpu &&
          x.resources.memoryGiB === s.settings.memoryGiB,
      );
      if (!record) return null;
      const p = await this.adapter.inspect(record, signal);
      this.assertPhysical(record, p);
      if (p?.phase !== 'Ready') throw Error('Sandbox claim is not Ready');
      record.state = 'claiming';
      record.conversationId = conversationId;
      record.provider = provider;
      record.connectionAccountId = connectionAccountId ?? null;
      this.persist(s);
      await this.adapter.bind(record, provider, signal, seed, providers);
      const after = await this.adapter.inspect(record, signal);
      this.assertPhysical(record, after, false);
      if (after?.phase !== 'Ready' || !after.providers.includes(provider))
        throw Error('Sandbox claim provider attachment is unverified');
      record.state = 'claimed';
      this.persist(s);
      return structuredClone(record);
    } catch (e) {
      if (record) {
        record.state = 'uncertain';
        record.failure = e instanceof Error ? e.message : 'Claim outcome unknown';
        this.persist(s);
      }
      throw e;
    } finally {
      this.finish(s);
    }
  }
  async reconcile(signal = AbortSignal.timeout(120000)) {
    const current = this.read();
    if (current.operation || !current.settings.enabled || current.resting) return;
    const expired =
      current.settings.expiryMinutes &&
      this.now() >= current.lastUse + current.settings.expiryMinutes * 60000;
    const slots = current.records.filter((x) => !x.conversationId && x.state !== 'removed').length;
    const obsoleteReady = current.records.some(
      (r) => !r.conversationId && r.state === 'ready' && r.scope !== this.adapter.scope,
    );
    if (
      !expired &&
      (current.settings.refill !== 'auto' || (slots >= current.settings.capacity && !obsoleteReady))
    )
      return;
    const s = this.reserve();
    try {
      if (!s.settings.enabled || s.resting) return;
      if (s.settings.expiryMinutes && this.now() >= s.lastUse + s.settings.expiryMinutes * 60000) {
        s.resting = true;
        this.persist(s);
        for (const r of s.records.filter((x) => !x.conversationId && x.state === 'ready'))
          await this.retire(s, r, signal);
        return;
      }
      if (s.settings.refill === 'auto') await this.fill(s, signal);
    } finally {
      this.finish(s);
    }
  }
  /** Called only by the exclusive host startup, before requests/timers are admitted. */
  recoverInterrupted() {
    const s = this.read();
    if (!s.operation) return;
    for (const r of s.records)
      if (['preparing', 'removing', 'claiming'].includes(r.state)) {
        r.state = 'uncertain';
        r.failure = 'Interrupted pool operation; inspect before retrying';
      }
    s.operation = null;
    this.write(s);
  }
  close() {
    this.db.close();
  }
}

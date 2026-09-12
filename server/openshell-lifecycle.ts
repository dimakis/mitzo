import Database from 'better-sqlite3';
import { chmodSync, closeSync, openSync } from 'node:fs';

export type OpenShellLifecyclePhase =
  | 'retained'
  | 'checkpointing'
  | 'stopping'
  | 'stopped'
  | 'deleting'
  | 'deleted'
  | 'restoring'
  | 'failed';

export interface OpenShellCheckpointRef {
  path: string;
  digest: string;
  version: number;
  sandboxId: string;
}

export interface OpenShellLifecycleRecord {
  conversationId: string;
  workspace: string;
  gateway: string;
  gatewayEndpoint: string | null;
  sandboxName: string;
  physicalSandboxId: string | null;
  accountProvider: string;
  phase: OpenShellLifecyclePhase;
  generation: number;
  lastActivityAt: number | null;
  idleSince: number | null;
  stoppedAt: number | null;
  checkpoint: OpenShellCheckpointRef | null;
  failure?: string | null;
}

export interface OpenShellLifecyclePolicy {
  idleMs: number;
  retentionMs: number;
  reconcileMs: number;
  enabled: boolean;
  retentionEligible(record: OpenShellLifecycleRecord, now: number): boolean;
}

const DAY = 24 * 60 * 60 * 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;
function positiveNumber(value: string | undefined, fallback: number, label: string, minimum = 1) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed * 60 * 1000 > MAX_TIMER_MS)
    throw new Error(`Invalid OpenShell ${label}`);
  return parsed;
}

/** Conservative lifecycle policy. Retention mutations remain disabled unless explicitly enabled. */
export function openShellLifecyclePolicy(env: NodeJS.ProcessEnv): OpenShellLifecyclePolicy {
  const retentionDays = positiveNumber(env.MITZO_OPENSHELL_RETENTION_DAYS, 7, 'retention', 5);
  const idleMinutes = positiveNumber(env.MITZO_OPENSHELL_IDLE_MINUTES, 30, 'idle delay');
  const reconcileMinutes = positiveNumber(
    env.MITZO_OPENSHELL_RECONCILE_MINUTES,
    5,
    'reconcile interval',
  );
  return {
    idleMs: idleMinutes * 60 * 1000,
    retentionMs: retentionDays * DAY,
    reconcileMs: reconcileMinutes * 60 * 1000,
    enabled: env.MITZO_OPENSHELL_LIFECYCLE_ENABLED === '1',
    retentionEligible: (record, now) =>
      record.phase === 'stopped' &&
      record.stoppedAt !== null &&
      Number.isFinite(record.stoppedAt) &&
      now >= record.stoppedAt + retentionDays * DAY,
  };
}

interface Row {
  conversation_id: string;
  workspace: string;
  gateway: string;
  gateway_endpoint: string | null;
  sandbox_name: string;
  physical_sandbox_id: string | null;
  account_provider: string;
  phase: OpenShellLifecyclePhase;
  generation: number;
  last_activity_at: number | null;
  idle_since: number | null;
  stopped_at: number | null;
  checkpoint: string | null;
  failure: string | null;
}
function fromRow(row: Row): OpenShellLifecycleRecord {
  return {
    conversationId: row.conversation_id,
    workspace: row.workspace,
    gateway: row.gateway,
    gatewayEndpoint: row.gateway_endpoint,
    sandboxName: row.sandbox_name,
    physicalSandboxId: row.physical_sandbox_id,
    accountProvider: row.account_provider,
    phase: row.phase,
    generation: row.generation,
    lastActivityAt: row.last_activity_at,
    idleSince: row.idle_since,
    stoppedAt: row.stopped_at,
    checkpoint: row.checkpoint ? (JSON.parse(row.checkpoint) as OpenShellCheckpointRef) : null,
    failure: row.failure,
  };
}

/** Private durable state for lifecycle fencing. The controller is the single writer. */
export class OpenShellLifecycleStore {
  private db: Database.Database;
  constructor(path: string) {
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
    this.db = new Database(path);
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS openshell_lifecycle (
      conversation_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, gateway TEXT NOT NULL,
      gateway_endpoint TEXT, sandbox_name TEXT NOT NULL, physical_sandbox_id TEXT,
      account_provider TEXT NOT NULL, phase TEXT NOT NULL,
      generation INTEGER NOT NULL, last_activity_at REAL, idle_since REAL, stopped_at REAL,
      checkpoint TEXT, failure TEXT
    )`);
    const columns = this.db
      .prepare("SELECT name FROM pragma_table_info('openshell_lifecycle')")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('gateway_endpoint'))
      this.db.exec('ALTER TABLE openshell_lifecycle ADD COLUMN gateway_endpoint TEXT');
    if (!names.has('physical_sandbox_id'))
      this.db.exec('ALTER TABLE openshell_lifecycle ADD COLUMN physical_sandbox_id TEXT');
  }
  get(conversationId: string): OpenShellLifecycleRecord | null {
    const row = this.db
      .prepare('SELECT * FROM openshell_lifecycle WHERE conversation_id=?')
      .get(conversationId) as Row | undefined;
    return row ? fromRow(row) : null;
  }
  upsert(record: OpenShellLifecycleRecord) {
    const existing = this.get(record.conversationId);
    if (existing) {
      if (existing.generation > record.generation)
        throw new Error('OpenShell lifecycle has newer state');
      if (existing.generation === record.generation) return;
    }
    const changed = this.db
      .prepare(
        `INSERT INTO openshell_lifecycle
        (conversation_id,workspace,gateway,gateway_endpoint,sandbox_name,physical_sandbox_id,account_provider,phase,generation,last_activity_at,idle_since,stopped_at,checkpoint,failure)
        VALUES (@conversationId,@workspace,@gateway,@gatewayEndpoint,@sandboxName,@physicalSandboxId,@accountProvider,@phase,@generation,@lastActivityAt,@idleSince,@stoppedAt,@checkpoint,@failure)
        ON CONFLICT(conversation_id) DO UPDATE SET workspace=excluded.workspace,gateway=excluded.gateway,sandbox_name=excluded.sandbox_name,
        gateway_endpoint=excluded.gateway_endpoint,physical_sandbox_id=excluded.physical_sandbox_id,account_provider=excluded.account_provider,phase=excluded.phase,generation=excluded.generation,last_activity_at=excluded.last_activity_at,
        idle_since=excluded.idle_since,stopped_at=excluded.stopped_at,checkpoint=excluded.checkpoint,failure=excluded.failure`,
      )
      .run({
        ...record,
        checkpoint: record.checkpoint ? JSON.stringify(record.checkpoint) : null,
        failure: record.failure ?? null,
      });
    if (!changed.changes) throw new Error('OpenShell lifecycle update failed');
  }
  transition(conversationId: string, expectedGeneration: number, phase: OpenShellLifecyclePhase) {
    const changed = this.db
      .prepare(
        'UPDATE openshell_lifecycle SET phase=?, generation=generation+1, failure=NULL WHERE conversation_id=? AND generation=?',
      )
      .run(phase, conversationId, expectedGeneration);
    return changed.changes ? this.get(conversationId) : null;
  }
  reconcileInterrupted() {
    this.db
      .prepare(
        "UPDATE openshell_lifecycle SET phase='failed', failure='interrupted lifecycle action', generation=generation+1 WHERE phase IN ('checkpointing','stopping','deleting','restoring')",
      )
      .run();
  }
  close() {
    this.db.close();
  }
}

/**
 * Process-local admission fence. Durable generation state protects recovery after
 * restart; this prevents a new send from racing an in-process idle action.
 */
export class OpenShellLifecycleCoordinator {
  private tails = new Map<string, Promise<void>>();
  private idle = new Map<string, { generation: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private options: { onIdleError?: (conversationId: string, error: Error) => void } = {},
  ) {}

  private cancelIdle(conversationId: string) {
    const scheduled = this.idle.get(conversationId);
    if (!scheduled) return;
    clearTimeout(scheduled.timer);
    this.idle.delete(conversationId);
  }

  async reserve(conversationId: string): Promise<() => void> {
    this.cancelIdle(conversationId);
    const prior = this.tails.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = prior.catch(() => {}).then(() => gate);
    this.tails.set(conversationId, tail);
    await prior.catch(() => {});
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      if (this.tails.get(conversationId) === tail) this.tails.delete(conversationId);
    };
  }

  async admit<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.reserve(conversationId);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  scheduleIdle(conversationId: string, delayMs: number, operation: () => Promise<void>) {
    this.cancelIdle(conversationId);
    const generation = Date.now() + Math.random();
    const timer = setTimeout(() => {
      const current = this.idle.get(conversationId);
      if (!current || current.generation !== generation) return;
      this.idle.delete(conversationId);
      void this.admit(conversationId, operation).catch((error: unknown) =>
        this.options.onIdleError?.(
          conversationId,
          error instanceof Error ? error : new Error('OpenShell idle action failed'),
        ),
      );
    }, delayMs);
    timer.unref?.();
    this.idle.set(conversationId, { generation, timer });
  }
}

/** Server-wide fence used by OpenShell startup and reconnect paths. */
export const sharedOpenShellLifecycleCoordinator = new OpenShellLifecycleCoordinator();

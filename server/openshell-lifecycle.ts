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
  /** Gateway observation recorded in the archive identity at capture time. It
   * is volatile for Ready sandboxes and is not a workspace-mutation fence; the
   * coordinator's admission lock provides capture-to-stop quiescence. */
  sourceResourceVersion?: string;
}

export interface OpenShellLifecycleRecord {
  conversationId: string;
  workspace: string;
  gateway: string;
  gatewayEndpoint: string | null;
  sandboxName: string;
  physicalSandboxId: string | null;
  accountProvider: string;
  ownerClientId?: string | null;
  phase: OpenShellLifecyclePhase;
  generation: number;
  lastActivityAt: number | null;
  idleSince: number | null;
  stoppedAt: number | null;
  /** Stable stopped revision used to authorize a later delete. Capture identity has its own
   * volatile Ready observation version. */
  stoppedResourceVersion?: string | null;
  checkpoint: OpenShellCheckpointRef | null;
  failure?: string | null;
  /** Immutable non-secret compatibility identity. Missing metadata blocks lifecycle mutation. */
  identity?: OpenShellLifecycleIdentity | null;
  /** Explicit operator consent for automated retention deletion. */
  retentionConsent?: boolean;
}
export interface OpenShellLifecycleIdentity {
  threadId: string;
  accountId: string;
  provider: string;
  model: string;
  profileRevision: string;
  image: string;
  policyDigest: string;
  runtimeScope: string;
  route:
    | { kind: 'api'; provider: string; model: string }
    | {
        kind: 'chatgpt-subscription';
        provider: string;
        providerType: string;
        providerId: string;
        grantId: string;
        model: string;
      };
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
const MINUTE = 60 * 1000;
const MAX_RETENTION_DAYS = Math.floor(Number.MAX_SAFE_INTEGER / DAY);
function positiveInteger(value: string | undefined, fallback: number, label: string, minimum = 1) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw new Error(`Invalid OpenShell ${label}`);
  return parsed;
}
function timerMinutes(value: string | undefined, fallback: number, label: string, minimum = 1) {
  const parsed = positiveInteger(value, fallback, label, minimum);
  if (parsed * MINUTE > MAX_TIMER_MS) throw new Error(`Invalid OpenShell ${label}`);
  return parsed;
}
function retentionDays(value: string | undefined) {
  const parsed = positiveInteger(value, 7, 'retention', 5);
  if (parsed > MAX_RETENTION_DAYS) throw new Error('Invalid OpenShell retention');
  return parsed;
}

/** Lifecycle is independently opt-in; reject malformed control values eagerly. */
export function openShellLifecycleEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.MITZO_OPENSHELL_LIFECYCLE_ENABLED;
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new Error('Invalid OpenShell lifecycle enabled flag');
}

/** Conservative lifecycle policy. Retention mutations remain disabled unless explicitly enabled. */
export function openShellLifecyclePolicy(env: NodeJS.ProcessEnv): OpenShellLifecyclePolicy {
  const enabled = openShellLifecycleEnabled(env);
  // Lifecycle settings are meaningful only after explicit opt-in. Keep stale
  // cleanup configuration inert in otherwise enabled OpenShell deployments.
  if (!enabled)
    return {
      idleMs: 30 * MINUTE,
      retentionMs: 7 * DAY,
      reconcileMs: 5 * MINUTE,
      enabled: false,
      retentionEligible: () => false,
    };
  const retention = retentionDays(env.MITZO_OPENSHELL_RETENTION_DAYS);
  const idleMinutes = timerMinutes(env.MITZO_OPENSHELL_IDLE_MINUTES, 30, 'idle delay');
  const reconcileMinutes = timerMinutes(
    env.MITZO_OPENSHELL_RECONCILE_MINUTES,
    5,
    'reconcile interval',
  );
  return {
    idleMs: idleMinutes * MINUTE,
    retentionMs: retention * DAY,
    reconcileMs: reconcileMinutes * MINUTE,
    enabled,
    retentionEligible: (record, now) =>
      record.phase === 'stopped' &&
      record.stoppedAt !== null &&
      Number.isFinite(record.stoppedAt) &&
      now >= record.stoppedAt + retention * DAY,
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
  owner_client_id?: string | null;
  phase: OpenShellLifecyclePhase;
  generation: number;
  last_activity_at: number | null;
  idle_since: number | null;
  stopped_at: number | null;
  stopped_resource_version?: string | null;
  checkpoint: string | null;
  failure: string | null;
  identity?: string | null;
  retention_consent?: number;
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
    ownerClientId: row.owner_client_id ?? null,
    phase: row.phase,
    generation: row.generation,
    lastActivityAt: row.last_activity_at,
    idleSince: row.idle_since,
    stoppedAt: row.stopped_at,
    stoppedResourceVersion: row.stopped_resource_version ?? null,
    checkpoint: row.checkpoint ? (JSON.parse(row.checkpoint) as OpenShellCheckpointRef) : null,
    failure: row.failure,
    identity: row.identity ? (JSON.parse(row.identity) as OpenShellLifecycleIdentity) : null,
    retentionConsent: !!row.retention_consent,
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
      account_provider TEXT NOT NULL, owner_client_id TEXT, phase TEXT NOT NULL,
      generation INTEGER NOT NULL, last_activity_at REAL, idle_since REAL, stopped_at REAL,
      checkpoint TEXT, failure TEXT, stopped_resource_version TEXT, identity TEXT, retention_consent INTEGER NOT NULL DEFAULT 0
    )`);
    const columns = this.db
      .prepare("SELECT name FROM pragma_table_info('openshell_lifecycle')")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('gateway_endpoint'))
      this.db.exec('ALTER TABLE openshell_lifecycle ADD COLUMN gateway_endpoint TEXT');
    if (!names.has('physical_sandbox_id'))
      this.db.exec('ALTER TABLE openshell_lifecycle ADD COLUMN physical_sandbox_id TEXT');
    if (!names.has('owner_client_id'))
      this.db.exec('ALTER TABLE openshell_lifecycle ADD COLUMN owner_client_id TEXT');
    if (!names.has('stopped_resource_version'))
      this.db.exec('ALTER TABLE openshell_lifecycle ADD COLUMN stopped_resource_version TEXT');
    if (!names.has('identity'))
      this.db.exec('ALTER TABLE openshell_lifecycle ADD COLUMN identity TEXT');
    if (!names.has('retention_consent'))
      this.db.exec(
        'ALTER TABLE openshell_lifecycle ADD COLUMN retention_consent INTEGER NOT NULL DEFAULT 0',
      );
  }
  get(conversationId: string): OpenShellLifecycleRecord | null {
    const row = this.db
      .prepare('SELECT * FROM openshell_lifecycle WHERE conversation_id=?')
      .get(conversationId) as Row | undefined;
    return row ? fromRow(row) : null;
  }
  list(): OpenShellLifecycleRecord[] {
    return (this.db.prepare('SELECT * FROM openshell_lifecycle').all() as Row[]).map(fromRow);
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
        (conversation_id,workspace,gateway,gateway_endpoint,sandbox_name,physical_sandbox_id,account_provider,owner_client_id,phase,generation,last_activity_at,idle_since,stopped_at,checkpoint,failure,stopped_resource_version,identity,retention_consent)
        VALUES (@conversationId,@workspace,@gateway,@gatewayEndpoint,@sandboxName,@physicalSandboxId,@accountProvider,@ownerClientId,@phase,@generation,@lastActivityAt,@idleSince,@stoppedAt,@checkpoint,@failure,@stoppedResourceVersion,@identity,@retentionConsent)
        ON CONFLICT(conversation_id) DO UPDATE SET workspace=excluded.workspace,gateway=excluded.gateway,sandbox_name=excluded.sandbox_name,
        gateway_endpoint=excluded.gateway_endpoint,physical_sandbox_id=excluded.physical_sandbox_id,account_provider=excluded.account_provider,owner_client_id=excluded.owner_client_id,phase=excluded.phase,generation=excluded.generation,last_activity_at=excluded.last_activity_at,
        idle_since=excluded.idle_since,stopped_at=excluded.stopped_at,checkpoint=excluded.checkpoint,failure=excluded.failure,stopped_resource_version=excluded.stopped_resource_version,identity=excluded.identity,retention_consent=excluded.retention_consent`,
      )
      .run({
        ...record,
        checkpoint: record.checkpoint ? JSON.stringify(record.checkpoint) : null,
        failure: record.failure ?? null,
        ownerClientId: record.ownerClientId ?? null,
        stoppedResourceVersion: record.stoppedResourceVersion ?? null,
        identity: record.identity ? JSON.stringify(record.identity) : null,
        retentionConsent: record.retentionConsent ? 1 : 0,
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
  saveCheckpoint(
    conversationId: string,
    expectedGeneration: number,
    checkpoint: OpenShellCheckpointRef,
  ) {
    const changed = this.db
      .prepare(
        "UPDATE openshell_lifecycle SET checkpoint=?, generation=generation+1, failure=NULL WHERE conversation_id=? AND generation=? AND phase='checkpointing'",
      )
      .run(JSON.stringify(checkpoint), conversationId, expectedGeneration);
    return changed.changes ? this.get(conversationId) : null;
  }
  /** Fences a failed transient action without replacing a newer lifecycle row. */
  fail(
    conversationId: string,
    expectedGeneration: number,
    expectedPhase: Extract<OpenShellLifecyclePhase, 'checkpointing' | 'stopping' | 'deleting'>,
    failure: string,
  ) {
    const changed = this.db
      .prepare(
        "UPDATE openshell_lifecycle SET phase='failed', failure=?, generation=generation+1 WHERE conversation_id=? AND generation=? AND phase=?",
      )
      .run(failure, conversationId, expectedGeneration, expectedPhase);
    return changed.changes ? this.get(conversationId) : null;
  }
  /** A stopped archive that cannot be verified is unsafe to retry automatically. */
  failStoppedCheckpoint(conversationId: string, expectedGeneration: number, failure: string) {
    const changed = this.db
      .prepare(
        "UPDATE openshell_lifecycle SET phase='failed', failure=?, generation=generation+1 WHERE conversation_id=? AND generation=? AND phase='stopped'",
      )
      .run(failure, conversationId, expectedGeneration);
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
  private activity = new Map<string, number>();
  private mutations = new Set<string>();

  constructor(
    private options: { onIdleError?: (conversationId: string, error: Error) => void } = {},
  ) {}

  private cancelIdle(conversationId: string) {
    const scheduled = this.idle.get(conversationId);
    if (!scheduled) return;
    clearTimeout(scheduled.timer);
    this.idle.delete(conversationId);
  }

  /** Records queue admission synchronously so a pending stop can recheck it
   * immediately before making the control-plane stop request. */
  noteActivity(conversationId: string) {
    this.cancelIdle(conversationId);
    const generation = (this.activity.get(conversationId) ?? 0) + 1;
    this.activity.set(conversationId, generation);
    return generation;
  }

  /** Atomically admits queue work unless a stop/delete owns this conversation.
   * Callers must reject the enqueue when this returns false: accepting work
   * while a physical mutation is in flight would race a stopped sandbox. */
  tryAdmitActivity(conversationId: string) {
    if (this.mutations.has(conversationId)) return false;
    this.noteActivity(conversationId);
    return true;
  }

  activityGeneration(conversationId: string) {
    return this.activity.get(conversationId) ?? 0;
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

  /** Holds the coordinator through the entire physical stop/delete operation. */
  async mutate<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    return this.admit(conversationId, async () => {
      this.mutations.add(conversationId);
      try {
        return await operation();
      } finally {
        this.mutations.delete(conversationId);
      }
    });
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

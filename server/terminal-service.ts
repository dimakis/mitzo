import { TerminalSessionMissing } from './terminal-errors.js';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  TerminalInputBody,
  TerminalResizeBody,
  type TerminalInfo,
  type TerminalEvent,
} from '@mitzo/protocol';
import type { OpenShellRuntime } from './openshell-runtime.js';

export interface TerminalTarget {
  kind: 'host' | 'sandbox';
  label: string;
  cwd: string;
  identity: string;
  sessionId?: string;
  runtime?: OpenShellRuntime & { sandboxId: string };
}
export interface TerminalRecord extends TerminalInfo {
  owner: string;
  identity: string;
  target?: TerminalTarget;
}
interface TerminalProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
}
export interface TerminalBackend {
  start(
    record: TerminalRecord,
    resume: boolean,
    callbacks: {
      data(data: string): void;
      exit(reason?: 'disconnected'): void;
    },
  ): Promise<TerminalProcess>;
  end(record: TerminalRecord): Promise<void>;
}
interface LiveTerminal {
  process?: TerminalProcess;
  data: string;
  seq: number;
  listeners: Set<(event: TerminalEvent) => void>;
}
export class TerminalStore {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS operator_terminals (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, identity TEXT NOT NULL,
      kind TEXT NOT NULL, label TEXT NOT NULL, cwd TEXT NOT NULL,
      session_id TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
  }
  create(record: TerminalRecord) {
    this.db
      .prepare('INSERT INTO operator_terminals VALUES (?,?,?,?,?,?,?,?,?)')
      .run(
        record.id,
        record.owner,
        record.identity,
        record.kind,
        record.label,
        record.cwd,
        record.sessionId ?? null,
        record.state,
        record.createdAt,
      );
  }
  private rows(owner?: string): TerminalRecord[] {
    const query = `SELECT id,owner,identity,kind,label,cwd,session_id AS sessionId,state,created_at AS createdAt FROM operator_terminals ${owner ? 'WHERE owner=?' : ''} ORDER BY created_at DESC`;
    const records = (
      owner ? this.db.prepare(query).all(owner) : this.db.prepare(query).all()
    ) as TerminalRecord[];
    return records.map((record) => ({ ...record, sessionId: record.sessionId || undefined }));
  }
  list(owner?: string) {
    return this.rows(owner);
  }
  read(owner: string, id: string) {
    const record = this.rows(owner).find((record) => record.id === id);
    if (!record) throw new Error('Terminal unavailable');
    return record;
  }
  state(id: string, state: TerminalInfo['state']) {
    this.db.prepare('UPDATE operator_terminals SET state=? WHERE id=?').run(state, id);
  }
}
function publicInfo(record: TerminalRecord): TerminalInfo {
  const { id, kind, label, cwd, sessionId, state, createdAt } = record;
  return { id, kind, label, cwd, ...(sessionId ? { sessionId } : {}), state, createdAt };
}
export class TerminalService {
  private live = new Map<string, LiveTerminal>();
  private starts = new Map<string, Promise<LiveTerminal>>();
  private opening: Promise<void> = Promise.resolve();
  constructor(
    private store: TerminalStore,
    private deps: {
      resolve(request: { sessionId?: string }, owner: string): Promise<TerminalTarget>;
      backend: TerminalBackend;
    },
  ) {}
  list(owner: string) {
    return this.store.list(owner).map(publicInfo);
  }
  get(owner: string, id: string) {
    return publicInfo(this.store.read(owner, id));
  }
  open(owner: string, request: { sessionId?: string }): Promise<TerminalInfo> {
    const operation = this.opening.then(() => this.openOne(owner, request));
    this.opening = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  private async openOne(owner: string, request: { sessionId?: string }) {
    const target = await this.deps.resolve(request, owner);
    const existing = this.store
      .list(owner)
      .find((record) => record.identity === target.identity && record.state === 'running');
    if (existing) {
      try {
        await this.ensure(existing, true);
      } catch (error) {
        if (!(error instanceof TerminalSessionMissing)) throw error;
      }
      return this.get(owner, existing.id);
    }
    if (
      this.store.list(owner).filter((record) => record.state === 'running').length >= 5 ||
      this.store.list().filter((record) => record.state === 'running').length >= 50
    )
      throw new Error('Terminal limit reached');
    const record: TerminalRecord = {
      id: `term-${randomUUID()}`,
      owner,
      identity: target.identity,
      kind: target.kind,
      label: target.label,
      cwd: target.cwd,
      sessionId: target.sessionId,
      state: 'running',
      createdAt: Date.now(),
    };
    this.store.create(record);
    await this.ensure(record, false);
    return this.get(owner, record.id);
  }
  private async verify(record: TerminalRecord) {
    const target = await this.deps.resolve({ sessionId: record.sessionId }, record.owner);
    if (
      target.identity !== record.identity ||
      target.cwd !== record.cwd ||
      target.kind !== record.kind
    )
      throw new Error('Terminal environment changed');
    return { ...record, target };
  }
  private async ensure(record: TerminalRecord, resume = true): Promise<LiveTerminal> {
    if (record.state !== 'running') throw new Error('Terminal has ended or is unavailable');
    const verified = await this.verify(record);
    const existing = this.live.get(record.id);
    if (existing?.process) return existing;
    const pending = this.starts.get(record.id);
    if (pending) return pending;
    const live: LiveTerminal = { data: '', seq: 0, listeners: new Set() };
    this.live.set(record.id, live);
    const start = this.deps.backend
      .start(verified, resume, {
        data: (data) => {
          live.seq++;
          live.data = (live.data + data).slice(-128 * 1024);
          for (const listener of live.listeners) listener({ type: 'output', data, seq: live.seq });
        },
        exit: (reason) => {
          if (reason !== 'disconnected') this.store.state(record.id, 'ended');
          live.seq++;
          for (const listener of live.listeners)
            listener(
              reason === 'disconnected'
                ? { type: 'error', error: 'Terminal transport disconnected; reconnecting' }
                : { type: 'exit', seq: live.seq },
            );
          this.live.delete(record.id);
        },
      })
      .then((process) => {
        live.process = process;
        return live;
      })
      .catch((error) => {
        if (error instanceof TerminalSessionMissing) this.store.state(record.id, 'ended');
        else if (!resume) this.store.state(record.id, 'unavailable');
        this.live.delete(record.id);
        if (error instanceof TerminalSessionMissing) throw error;
        throw new Error('Terminal could not be opened. Check the selected environment.');
      })
      .finally(() => {
        this.starts.delete(record.id);
      });
    this.starts.set(record.id, start);
    return start;
  }
  async subscribe(owner: string, id: string, listener: (event: TerminalEvent) => void) {
    const live = await this.ensure(this.store.read(owner, id));
    listener({ type: 'snapshot', data: live.data, seq: live.seq });
    live.listeners.add(listener);
    return () => {
      live.listeners.delete(listener);
    };
  }
  async write(
    owner: string,
    id: string,
    data: string,
    authority?: { signal: AbortSignal; expiresAt: number },
  ) {
    const authorize = () => {
      authority?.signal.throwIfAborted();
      if (authority && authority.expiresAt <= Date.now()) throw Error('Operator session expired');
    };
    authorize();
    if (!TerminalInputBody.safeParse({ data }).success) throw new Error('Invalid terminal input');
    const live = await this.ensure(this.store.read(owner, id));
    authorize();
    live.process!.write(data);
  }
  async resize(owner: string, id: string, cols: number, rows: number) {
    if (!TerminalResizeBody.safeParse({ cols, rows }).success)
      throw new Error('Invalid terminal size');
    const live = await this.ensure(this.store.read(owner, id));
    live.process!.resize(cols, rows);
  }
  async end(owner: string, id: string) {
    const record = await this.verify(this.store.read(owner, id));
    if (record.state === 'ended') return;
    await this.deps.backend.end(record);
    this.store.state(id, 'ended');
    const live = this.live.get(id);
    for (const listener of live?.listeners ?? [])
      listener({ type: 'exit', seq: (live?.seq ?? 0) + 1 });
    live?.process?.detach();
    this.live.delete(id);
  }
  detachAll() {
    for (const live of this.live.values()) {
      live.listeners.clear();
      live.process?.detach();
    }
    this.live.clear();
  }
}

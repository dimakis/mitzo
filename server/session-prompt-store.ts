import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  SessionTimerCreateSchema,
  SessionTimerChangeSchema,
  SessionMessageSendSchema,
  SessionTimerSchema,
  type SessionTimer,
} from '@mitzo/protocol';
import type { AuthSession } from './auth.js';

export class SessionPromptError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
export interface SessionPromptDelivery {
  id: string;
  commandId: string;
  kind: 'timer' | 'agent';
  timerId: string | null;
  timerRevision: number | null;
  manual: boolean;
  senderSessionId: string | null;
  recipientSessionId: string;
  text: string;
  workId: string | null;
  state: 'pending' | 'dispatching' | 'accepted' | 'failed' | 'uncertain' | 'cancelled';
  error: string | null;
  createdAt: number;
  auth: AuthSession;
}
interface TimerEnvelope {
  timer: SessionTimer;
  auth: AuthSession;
  deliveryId: string | null;
}
type JsonRow = { data: string };

/** Timer consent, correlation and delivery intent live in the ordinary event
 * database and its backup lifetime. Runtime command receipts remain authoritative. */
export class SessionPromptStore {
  private readonly db: Database.Database;
  private pendingCursor = 0;
  private pendingBoundary = 0;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_prompt_timers (
        id TEXT PRIMARY KEY, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_prompt_deliveries (
        id TEXT PRIMARY KEY, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_prompt_requests (
        request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_prompt_closed_sessions (
        session_id TEXT PRIMARY KEY
      );
      CREATE INDEX IF NOT EXISTS session_prompt_delivery_state
        ON session_prompt_deliveries(json_extract(data, '$.state'));
      CREATE INDEX IF NOT EXISTS session_prompt_timer_status
        ON session_prompt_timers(json_extract(data, '$.timer.status'));
    `);
  }
  close() {
    this.db.close();
  }
  private assertSessionOpen(sessionId: string | null) {
    if (
      sessionId &&
      this.db
        .prepare('SELECT 1 FROM session_prompt_closed_sessions WHERE session_id=?')
        .get(sessionId)
    )
      throw new SessionPromptError('This chat is being removed.');
  }
  keepSession(sessionId: string) {
    // Explicitly keeping the chat permits future admissions, never resumes a
    // cancelled timer or resends retained delivery intent.
    this.db.prepare('DELETE FROM session_prompt_closed_sessions WHERE session_id=?').run(sessionId);
  }
  /** Cancel only unadmitted intent. Dispatching/uncertain receipts keep their
   * identity until the original delivery owner establishes acceptance. */
  cancelSession(sessionId: string) {
    this.db
      .transaction(() => {
        this.db
          .prepare('INSERT OR IGNORE INTO session_prompt_closed_sessions VALUES(?)')
          .run(sessionId);
        for (const timer of this.list()) {
          if (timer.sessionId !== sessionId && timer.sourceSessionId !== sessionId) continue;
          if (timer.status === 'cancelled' || timer.status === 'completed') continue;
          const envelope = this.envelope(timer.id);
          envelope.timer = {
            ...timer,
            status: 'cancelled',
            nextRunAt: null,
            revision: timer.revision + 1,
            updatedAt: Date.now(),
          };
          this.save(envelope);
        }
        for (const delivery of this.deliveries(['pending'])) {
          if (delivery.recipientSessionId !== sessionId && delivery.senderSessionId !== sessionId)
            continue;
          delivery.state = 'cancelled';
          this.saveDelivery(delivery);
        }
      })
      .immediate();
  }
  private request<T>(requestId: string, input: unknown, action: () => T): T {
    return this.db
      .transaction(() => {
        const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        const prior = this.db
          .prepare('SELECT fingerprint,result FROM session_prompt_requests WHERE request_id=?')
          .get(requestId) as { fingerprint: string; result: string } | undefined;
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new SessionPromptError('Request identity changed');
          return JSON.parse(prior.result) as T;
        }
        const result = action();
        this.db
          .prepare('INSERT INTO session_prompt_requests VALUES(?,?,?)')
          .run(requestId, fingerprint, JSON.stringify(result));
        return result;
      })
      .immediate();
  }
  private envelope(id: string): TimerEnvelope {
    const row = this.db.prepare('SELECT data FROM session_prompt_timers WHERE id=?').get(id) as
      JsonRow | undefined;
    if (!row) throw new SessionPromptError('Timer not found', 404);
    return JSON.parse(row.data) as TimerEnvelope;
  }
  private save(value: TimerEnvelope) {
    SessionTimerSchema.parse(value.timer);
    this.db
      .prepare('INSERT OR REPLACE INTO session_prompt_timers VALUES(?,?)')
      .run(value.timer.id, JSON.stringify(value));
  }
  private saveDelivery(value: SessionPromptDelivery) {
    this.db
      .prepare('INSERT OR REPLACE INTO session_prompt_deliveries VALUES(?,?)')
      .run(value.id, JSON.stringify(value));
  }
  get(id: string): SessionTimer {
    return this.envelope(id).timer;
  }
  list(sessionId?: string): SessionTimer[] {
    return (
      this.db
        .prepare('SELECT data FROM session_prompt_timers ORDER BY rowid DESC')
        .all() as JsonRow[]
    )
      .map((row) => (JSON.parse(row.data) as TimerEnvelope).timer)
      .filter((timer) => !sessionId || timer.sessionId === sessionId);
  }
  create(
    raw: unknown,
    auth: AuthSession,
    createdBy: 'user' | 'agent',
    sourceSessionId: string | null,
    now = Date.now(),
  ): SessionTimer {
    const input = SessionTimerCreateSchema.parse(raw);
    return this.request(input.requestId, ['create', input, createdBy, sourceSessionId], () => {
      this.assertSessionOpen(input.sessionId);
      this.assertSessionOpen(sourceSessionId);
      if (
        this.list().filter((t) => t.status !== 'cancelled' && t.status !== 'completed').length >=
        200
      )
        throw new SessionPromptError('Pause or cancel existing timers before creating more.', 422);
      const timer: SessionTimer = {
        id: randomUUID(),
        sessionId: input.sessionId,
        prompt: input.prompt,
        intervalMinutes: input.intervalMinutes,
        maxRuns: input.maxRuns,
        revision: 1,
        status: 'active',
        createdBy,
        sourceSessionId,
        createdAt: now,
        updatedAt: now,
        nextRunAt: input.startImmediately ? now : now + input.intervalMinutes * 60_000,
        lastRunAt: null,
        runCount: 0,
        lastError: null,
      };
      this.save({ timer, auth: { ...auth }, deliveryId: null });
      return timer;
    });
  }
  change(id: string, raw: unknown, auth: AuthSession, now = Date.now()): SessionTimer {
    const input = SessionTimerChangeSchema.parse(raw);
    return this.request(input.requestId, ['change', id, input], () => {
      const envelope = this.envelope(id),
        timer = envelope.timer;
      if (timer.revision !== input.expectedRevision)
        throw new SessionPromptError('Timer changed. Refresh before trying again.');
      if (timer.status === 'cancelled' || timer.status === 'completed')
        throw new SessionPromptError('This timer has ended. Create another timer.');
      if (input.action === 'resume' && timer.status === 'active')
        throw new SessionPromptError('This timer is already active.');
      const previous = envelope.deliveryId ? this.delivery(envelope.deliveryId) : undefined;
      if (
        previous &&
        ['dispatching', 'uncertain'].includes(previous.state) &&
        !['pause', 'cancel'].includes(input.action)
      )
        throw new SessionPromptError(
          'Delivery is uncertain. Check the original receipt before resuming.',
        );
      timer.revision++;
      timer.updatedAt = now;
      if (input.action === 'cancel' || input.action === 'pause' || input.action === 'update') {
        if (previous?.state === 'pending') {
          previous.state = 'cancelled';
          this.saveDelivery(previous);
          envelope.deliveryId = null;
        }
      }
      if (input.action === 'pause' || input.action === 'cancel') {
        timer.status = input.action === 'pause' ? 'paused' : 'cancelled';
        timer.nextRunAt = null;
      } else if (input.action === 'resume') {
        timer.status = 'active';
        timer.lastError = null;
        timer.nextRunAt = now + timer.intervalMinutes * 60_000;
        envelope.auth = { ...auth };
        if (previous?.state === 'pending') {
          // The old check has not been admitted. Replace its cancelled intent
          // under this resume's revision/login, preserving the manual check.
          previous.state = 'cancelled';
          this.saveDelivery(previous);
          this.reserve(envelope, now, previous.manual);
        }
      } else if (input.action === 'update') {
        timer.prompt = input.prompt ?? timer.prompt;
        timer.intervalMinutes = input.intervalMinutes ?? timer.intervalMinutes;
        if (input.maxRuns !== undefined) timer.maxRuns = input.maxRuns;
        if (timer.maxRuns !== null && timer.maxRuns <= timer.runCount)
          throw new SessionPromptError('Run limit must exceed the checks already sent.');
        if (timer.status === 'active') timer.nextRunAt = now + timer.intervalMinutes * 60_000;
      } else {
        if (previous && ['pending', 'dispatching', 'uncertain'].includes(previous.state))
          throw new SessionPromptError('A check is already pending.');
        if (!['active', 'paused'].includes(timer.status))
          throw new SessionPromptError('Resume this timer before running it.');
        envelope.auth = { ...auth };
        this.reserve(envelope, now, true);
      }
      this.save(envelope);
      return timer;
    });
  }
  private reserve(envelope: TimerEnvelope, now: number, manual = false) {
    const timer = envelope.timer;
    const id = randomUUID();
    this.saveDelivery({
      id,
      commandId: `session-prompt:${id}`,
      kind: 'timer',
      timerId: timer.id,
      timerRevision: timer.revision,
      manual,
      senderSessionId: timer.sourceSessionId,
      recipientSessionId: timer.sessionId,
      text: timer.prompt,
      workId: null,
      state: 'pending',
      error: null,
      createdAt: now,
      auth: { ...envelope.auth },
    });
    envelope.deliveryId = id;
  }
  /** Overdue intervals collapse into one retained request, never a catch-up burst. */
  due(now = Date.now()): SessionPromptDelivery[] {
    return this.db
      .transaction(() => {
        const active = this.db
          .prepare(
            "SELECT data FROM session_prompt_timers WHERE json_extract(data, '$.timer.status')='active'",
          )
          .all() as JsonRow[];
        for (const row of active) {
          const { timer } = JSON.parse(row.data) as TimerEnvelope;
          if (timer.status !== 'active' || timer.nextRunAt === null || timer.nextRunAt > now)
            continue;
          const envelope = this.envelope(timer.id);
          if (!envelope.deliveryId) {
            this.reserve(envelope, now);
            this.save(envelope);
          }
        }
        return this.pendingPage().filter((d) => {
          if (!d.timerId) return true;
          const status = this.get(d.timerId).status;
          return (
            !['cancelled', 'completed', 'paused'].includes(status) ||
            (d.manual && status === 'paused')
          );
        });
      })
      .immediate();
  }
  /** Bound each sweep to its original tail: ongoing arrivals cannot starve
   * earlier recipients, and busy recipients cannot monopolize every tick. */
  private pendingPage(): SessionPromptDelivery[] {
    const reset = () => {
      this.pendingCursor = 0;
      this.pendingBoundary = (
        this.db
          .prepare(
            "SELECT coalesce(max(rowid),0) AS boundary FROM session_prompt_deliveries WHERE json_extract(data, '$.state')='pending'",
          )
          .get() as { boundary: number }
      ).boundary;
    };
    const read = () =>
      this.db
        .prepare(
          "SELECT rowid,data FROM session_prompt_deliveries WHERE json_extract(data, '$.state')='pending' AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 200",
        )
        .all(this.pendingCursor, this.pendingBoundary) as Array<JsonRow & { rowid: number }>;
    if (this.pendingCursor >= this.pendingBoundary) reset();
    let rows = read();
    if (!rows.length && this.pendingCursor > 0) {
      reset();
      rows = read();
    }
    this.pendingCursor = rows.at(-1)?.rowid ?? this.pendingBoundary;
    return rows.map((row) => JSON.parse(row.data) as SessionPromptDelivery);
  }
  deliveries(states?: SessionPromptDelivery['state'][]): SessionPromptDelivery[] {
    return (
      this.db
        .prepare(
          states
            ? `SELECT data FROM session_prompt_deliveries WHERE json_extract(data, '$.state') IN (${states.map(() => '?').join(',')}) ORDER BY rowid`
            : 'SELECT data FROM session_prompt_deliveries ORDER BY rowid',
        )
        .all(...(states ?? [])) as JsonRow[]
    ).map((row) => JSON.parse(row.data) as SessionPromptDelivery);
  }
  delivery(id: string): SessionPromptDelivery {
    const row = this.db.prepare('SELECT data FROM session_prompt_deliveries WHERE id=?').get(id) as
      JsonRow | undefined;
    if (!row) throw new SessionPromptError('Message not found', 404);
    return JSON.parse(row.data) as SessionPromptDelivery;
  }
  message(
    raw: unknown,
    auth: AuthSession,
    senderSessionId: string,
    now = Date.now(),
  ): SessionPromptDelivery {
    const input = SessionMessageSendSchema.parse(raw);
    if (input.sessionId === senderSessionId)
      throw new SessionPromptError('Select another session.', 422);
    return this.request(input.requestId, ['message', input, senderSessionId], () => {
      this.assertSessionOpen(input.sessionId);
      this.assertSessionOpen(senderSessionId);
      const id = randomUUID();
      const delivery: SessionPromptDelivery = {
        id,
        commandId: `session-prompt:${id}`,
        kind: 'agent',
        timerId: null,
        timerRevision: null,
        manual: false,
        senderSessionId,
        recipientSessionId: input.sessionId,
        text: input.text,
        workId: input.workId ?? null,
        state: 'pending',
        error: null,
        createdAt: now,
        auth: { ...auth },
      };
      this.saveDelivery(delivery);
      return delivery;
    });
  }
  assertDeliveryCurrent(id: string): SessionPromptDelivery {
    const delivery = this.delivery(id);
    this.assertSessionOpen(delivery.recipientSessionId);
    this.assertSessionOpen(delivery.senderSessionId);
    if (!['pending', 'dispatching'].includes(delivery.state))
      throw new SessionPromptError('Delivery is no longer current.');
    if (delivery.timerId) {
      const { timer } = this.envelope(delivery.timerId);
      if (
        timer.revision !== delivery.timerRevision ||
        (timer.status !== 'active' && !(delivery.manual && timer.status === 'paused'))
      )
        throw new SessionPromptError('Timer cancelled, paused, or changed.');
    }
    return delivery;
  }
  claim(id: string): boolean {
    return this.db
      .transaction(() => {
        const delivery = this.delivery(id);
        if (delivery.state !== 'pending') return false;
        this.assertDeliveryCurrent(id);
        delivery.state = 'dispatching';
        this.saveDelivery(delivery);
        return true;
      })
      .immediate();
  }
  finish(
    id: string,
    state: 'accepted' | 'failed' | 'uncertain',
    error: string | null,
    now = Date.now(),
  ) {
    this.db
      .transaction(() => {
        const delivery = this.delivery(id);
        if (delivery.state === 'accepted' || delivery.state === 'cancelled') return;
        delivery.state = state;
        delivery.error = error;
        this.saveDelivery(delivery);
        if (!delivery.timerId) return;
        const envelope = this.envelope(delivery.timerId),
          timer = envelope.timer;
        timer.updatedAt = now;
        timer.revision++;
        if (state === 'accepted') {
          timer.runCount++;
          timer.lastRunAt = now;
          timer.lastError = null;
          envelope.deliveryId = null;
          if (
            timer.status !== 'cancelled' &&
            timer.maxRuns !== null &&
            timer.runCount >= timer.maxRuns
          ) {
            timer.status = 'completed';
            timer.nextRunAt = null;
          } else if (timer.status === 'active')
            timer.nextRunAt = now + timer.intervalMinutes * 60_000;
        } else {
          if (state === 'failed') envelope.deliveryId = null;
          timer.lastError = error;
          if (timer.status === 'active') {
            timer.status = 'blocked';
            timer.nextRunAt = null;
          }
        }
        this.save(envelope);
      })
      .immediate();
  }
}

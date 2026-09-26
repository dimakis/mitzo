import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { chmodSync, lstatSync, statSync } from 'node:fs';
import {
  confirmControlledAttemptStopped,
  launchControlledAttempt,
  type ControlledAttemptProcess,
  type ControlledAttemptSandbox,
} from './symposium-attempt-transport.js';

type AttemptState = 'reserved' | 'uncertain' | 'confirmed';

interface AttemptRow extends ControlledAttemptSandbox {
  claimToken: string;
  sessionId: string;
  state: AttemptState;
}

export interface SymposiumAttemptTransport {
  launch: typeof launchControlledAttempt;
  confirm: typeof confirmControlledAttemptStopped;
}

/** Host-owned durable mapping; never populate it from client-supplied sandbox names. */
export class SymposiumAttemptRegistry {
  private readonly db: Database.Database;

  constructor(
    path: string,
    private readonly transport: SymposiumAttemptTransport = {
      launch: launchControlledAttempt,
      confirm: confirmControlledAttemptStopped,
    },
  ) {
    if (path === ':memory:' || (statSync(dirname(path)).mode & 0o077) !== 0)
      throw new Error('Native attempt registry requires a private host directory');
    try {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0)
        throw new Error('Native attempt registry file is not private');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS symposium_native_attempts (
      claim_token TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sandbox_name TEXT NOT NULL,
      workdir TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved', 'uncertain', 'confirmed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS symposium_native_attempts_sandbox
      ON symposium_native_attempts(sandbox_name, state);
    CREATE TABLE IF NOT EXISTS symposium_native_preparations (
      claim_token TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0, 1))
    );`);
  }

  /** Registered before asynchronous setup. Every native launch must pass reserve(). */
  prepare(input: { claimToken: string; sessionId: string }) {
    if (!input.claimToken || !input.sessionId) throw new Error('Invalid native attempt identity');
    this.db.transaction(() => {
      if (this.get(input.claimToken)) throw new Error('Native attempt claim already exists');
      const existing = this.db
        .prepare(
          'SELECT session_id AS sessionId, closed FROM symposium_native_preparations WHERE claim_token = ?',
        )
        .get(input.claimToken) as { sessionId: string; closed: number } | undefined;
      if (existing) {
        if (existing.closed || existing.sessionId !== input.sessionId)
          throw new Error('Native attempt preparation is closed or belongs to another session');
        return;
      }
      this.db
        .prepare(
          'INSERT INTO symposium_native_preparations (claim_token, session_id) VALUES (?, ?)',
        )
        .run(input.claimToken, input.sessionId);
    })();
  }

  reserve(input: { claimToken: string; sessionId: string; sandbox: ControlledAttemptSandbox }) {
    if (!input.claimToken || !input.sessionId || !input.sandbox.sandboxName)
      throw new Error('Invalid native attempt identity');
    this.db.transaction(() => {
      const preparation = this.db
        .prepare(
          'SELECT session_id AS sessionId, closed FROM symposium_native_preparations WHERE claim_token = ?',
        )
        .get(input.claimToken) as { sessionId: string; closed: number } | undefined;
      if (preparation && (preparation.closed || preparation.sessionId !== input.sessionId))
        throw new Error('Native attempt preparation is closed or belongs to another session');
      this.assertSandboxAvailable(input.sandbox.sandboxName);
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO symposium_native_attempts
           (claim_token, session_id, sandbox_name, workdir, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'reserved', ?, ?)`,
        )
        .run(
          input.claimToken,
          input.sessionId,
          input.sandbox.sandboxName,
          input.sandbox.workdir,
          now,
          now,
        );
      // Commit the unknown process state before any transport side effect.
      this.db
        .prepare('DELETE FROM symposium_native_preparations WHERE claim_token = ?')
        .run(input.claimToken);
    })();
  }

  launch(input: {
    claimToken: string;
    sessionId: string;
    sandbox: ControlledAttemptSandbox;
    access: 'read' | 'write';
    command: readonly string[];
  }): ControlledAttemptProcess {
    this.reserve(input);
    try {
      const process = this.transport.launch(
        input.sandbox,
        input.claimToken,
        input.access,
        input.command,
      );
      return { child: process.child, confirmStopped: () => this.recover(input.claimToken) };
    } catch {
      this.markUncertain(input.claimToken);
      throw new Error('Native attempt launch is unconfirmed; sandbox remains quarantined');
    }
  }

  assertSandboxAvailable(sandboxName: string) {
    const row = this.db
      .prepare(
        "SELECT 1 FROM symposium_native_attempts WHERE sandbox_name = ? AND state != 'confirmed' LIMIT 1",
      )
      .get(sandboxName);
    if (row) throw new Error('Native sandbox is quarantined pending exact cleanup proof');
  }

  get(claimToken: string): AttemptRow | undefined {
    const row = this.db
      .prepare(
        `SELECT claim_token AS claimToken, session_id AS sessionId,
                sandbox_name AS sandboxName, workdir, state
         FROM symposium_native_attempts WHERE claim_token = ?`,
      )
      .get(claimToken);
    return row as AttemptRow | undefined;
  }

  markUncertain(claimToken: string) {
    const result = this.db
      .prepare(
        "UPDATE symposium_native_attempts SET state = 'uncertain', updated_at = ? WHERE claim_token = ? AND state != 'confirmed'",
      )
      .run(Date.now(), claimToken);
    if (result.changes !== 1) throw new Error('Native attempt claim is unavailable');
  }

  markConfirmed(claimToken: string) {
    const result = this.db
      .prepare(
        "UPDATE symposium_native_attempts SET state = 'confirmed', updated_at = ? WHERE claim_token = ? AND state != 'confirmed'",
      )
      .run(Date.now(), claimToken);
    if (result.changes !== 1 && this.get(claimToken)?.state !== 'confirmed')
      throw new Error('Native attempt claim is unavailable');
  }

  pending(): AttemptRow[] {
    return this.db
      .prepare(
        `SELECT claim_token AS claimToken, session_id AS sessionId,
                sandbox_name AS sandboxName, workdir, state
         FROM symposium_native_attempts WHERE state != 'confirmed'`,
      )
      .all() as AttemptRow[];
  }

  /** A failed probe retains the quarantine; callers must not infer sandbox safety. */
  async recover(
    claimToken: string,
    confirm: typeof confirmControlledAttemptStopped = this.transport.confirm,
  ): Promise<void> {
    const row = this.db.transaction(() => {
      const launched = this.get(claimToken);
      if (launched) return launched;
      // Closing and launch reservation serialize in the same database. A late
      // setup continuation can never launch after this proof is issued.
      const result = this.db
        .prepare('UPDATE symposium_native_preparations SET closed = 1 WHERE claim_token = ?')
        .run(claimToken);
      if (result.changes !== 1) throw new Error('Native attempt claim is unavailable');
      return undefined;
    })();
    if (!row) return;
    if (row.state === 'confirmed') return;
    try {
      await confirm({ sandboxName: row.sandboxName, workdir: row.workdir }, claimToken);
      this.markConfirmed(claimToken);
    } catch {
      this.markUncertain(claimToken);
      throw new Error('Native attempt cleanup is unconfirmed; sandbox remains quarantined');
    }
  }

  close() {
    this.db.close();
  }
}

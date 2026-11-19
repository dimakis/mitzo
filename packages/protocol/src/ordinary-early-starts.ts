import type Database from 'better-sqlite3';
import { RuntimeFailureSchema, type RuntimeFailure } from './runtime-failure.js';

export interface OrdinaryEarlyStart {
  clientMsgId: string;
  sessionId: string;
  /** Selected repository; the session and reservation identities derive from it. */
  workspaceId: string;
  /** Login that created the start. A later login of the same operator recovers it. */
  authSessionId: string;
  wireFingerprint: string;
  state: 'preparing' | 'failed';
  runtimeFailure?: RuntimeFailure;
}

/** Durable record of a first command acknowledged before workspace reservation
 * and provider startup. It is never admission: the command's admission receipt
 * stays with its existing owner. A failure is retained against the exact frozen
 * wire so a deliberate retry reruns the same reservation, never a different one. */
export class OrdinaryEarlyStarts {
  constructor(private readonly database: () => Database.Database) {
    database().exec(`CREATE TABLE IF NOT EXISTS ordinary_early_starts (
      client_msg_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      auth_session_id TEXT NOT NULL,
      wire_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('preparing', 'failed')),
      runtime_failure TEXT
    )`);
  }

  get(clientMsgId: string): OrdinaryEarlyStart | undefined {
    const row = this.database()
      .prepare(
        'SELECT session_id, workspace_id, auth_session_id, wire_fingerprint, state, runtime_failure FROM ordinary_early_starts WHERE client_msg_id=?',
      )
      .get(clientMsgId) as
      | {
          session_id: string;
          workspace_id: string;
          auth_session_id: string;
          wire_fingerprint: string;
          state: string;
          runtime_failure: string | null;
        }
      | undefined;
    if (!row) return undefined;
    const failure = row.runtime_failure
      ? RuntimeFailureSchema.safeParse(JSON.parse(row.runtime_failure)).data
      : undefined;
    return {
      clientMsgId,
      sessionId: row.session_id,
      workspaceId: row.workspace_id,
      authSessionId: row.auth_session_id,
      wireFingerprint: row.wire_fingerprint,
      state: row.state === 'failed' ? 'failed' : 'preparing',
      ...(failure ? { runtimeFailure: failure } : {}),
    };
  }

  /** The start still preparing this conversation, if any. It exists from the
   * acknowledgement, before reservation, worktree creation or a session row. */
  preparingForSession(sessionId: string): OrdinaryEarlyStart | undefined {
    const row = this.database()
      .prepare(
        "SELECT client_msg_id FROM ordinary_early_starts WHERE session_id=? AND state='preparing' LIMIT 1",
      )
      .get(sessionId) as { client_msg_id: string } | undefined;
    return row ? this.get(row.client_msg_id) : undefined;
  }

  /** Records a new or retried start. The identity of an existing record, including
   * its creating login, is fixed; the caller qualifies the current operator. */
  begin(input: {
    clientMsgId: string;
    sessionId: string;
    workspaceId: string;
    authSessionId: string;
    wireFingerprint: string;
  }): void {
    if (!/^[a-f0-9]{64}$/.test(input.wireFingerprint))
      throw Error('Original early start wire required');
    this.database()
      .transaction(() => {
        const previous = this.get(input.clientMsgId);
        if (
          previous &&
          (previous.sessionId !== input.sessionId ||
            previous.workspaceId !== input.workspaceId ||
            previous.wireFingerprint !== input.wireFingerprint)
        )
          throw Error('Original early start identity required');
        this.database()
          .prepare(
            `INSERT INTO ordinary_early_starts
              (client_msg_id, session_id, workspace_id, auth_session_id, wire_fingerprint, state)
            VALUES (?, ?, ?, ?, ?, 'preparing')
            ON CONFLICT(client_msg_id) DO UPDATE SET state='preparing', runtime_failure=NULL`,
          )
          .run(
            input.clientMsgId,
            input.sessionId,
            input.workspaceId,
            input.authSessionId,
            input.wireFingerprint,
          );
      })
      .immediate();
  }

  fail(clientMsgId: string, runtimeFailure: RuntimeFailure): void {
    this.database()
      .prepare(
        "UPDATE ordinary_early_starts SET state='failed', runtime_failure=? WHERE client_msg_id=?",
      )
      .run(JSON.stringify(RuntimeFailureSchema.parse(runtimeFailure)), clientMsgId);
  }

  /** Admission now owns the command's receipt. */
  complete(clientMsgId: string): void {
    this.database()
      .prepare('DELETE FROM ordinary_early_starts WHERE client_msg_id=?')
      .run(clientMsgId);
  }
}

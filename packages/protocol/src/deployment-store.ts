import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';

export interface DeploymentSession {
  sessionId: string;
  snapshot: Record<string, unknown>;
  interruptId: string;
  resumeId: string;
  state:
    | 'captured'
    | 'interrupting'
    | 'paused'
    | 'activating'
    | 'resuming'
    | 'resumed'
    | 'blocked'
    | 'uncertain';
  error: string | null;
  /** Recorded only after the original live turn and effects settle. */
  pauseSettled?: boolean;
}
export interface DeploymentOperation {
  id: string;
  sourceCommit: string;
  targetCommit: string;
  auth: { id: string; expiresAt: number };
  phase: 'capturing' | 'pausing' | 'paused' | 'activating' | 'resuming' | 'completed' | 'cancelled';
  sessions: DeploymentSession[];
  activationHash?: string;
  resumeCommit?: string;
  createdAt: number;
}

/** The hold shares admission's SQLite transaction, not a process-local flag.
 * Interrupted operations retain their hold until an explicit reconciliation. */
export class DeploymentStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS deployment_operations (
      id TEXT PRIMARY KEY, data TEXT NOT NULL,
      held INTEGER NOT NULL CHECK(held IN (0,1))
    ); CREATE UNIQUE INDEX IF NOT EXISTS deployment_single_hold
      ON deployment_operations(held) WHERE held=1`);
  }
  get(id: string): DeploymentOperation {
    const row = this.db.prepare('SELECT data FROM deployment_operations WHERE id=?').get(id) as
      { data: string } | undefined;
    if (!row) throw Error('Deployment operation not found');
    return JSON.parse(row.data) as DeploymentOperation;
  }
  active(): DeploymentOperation | undefined {
    const row = this.db.prepare('SELECT data FROM deployment_operations WHERE held=1').get() as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as DeploymentOperation) : undefined;
  }
  begin(input: Omit<DeploymentOperation, 'phase' | 'sessions' | 'createdAt'>) {
    return this.db
      .transaction(() => {
        const previous = this.db
          .prepare('SELECT 1 FROM deployment_operations WHERE id=?')
          .get(input.id);
        if (previous) {
          const value = this.get(input.id);
          for (const key of ['sourceCommit', 'targetCommit', 'auth'] as const)
            if (!isDeepStrictEqual(value[key], input[key]))
              throw Error('Deployment identity changed');
          return value;
        }
        if (this.active()) throw Error('Another deployment owns admission');
        const value: DeploymentOperation = {
          ...input,
          phase: 'capturing',
          sessions: [],
          createdAt: Date.now(),
        };
        this.db
          .prepare('INSERT INTO deployment_operations(id,data,held) VALUES (?,?,1)')
          .run(input.id, JSON.stringify(value));
        return value;
      })
      .immediate();
  }
  update(id: string, change: (operation: DeploymentOperation) => void) {
    return this.db
      .transaction(() => {
        if (this.active()?.id !== id) throw Error('Original deployment hold required');
        const value = this.get(id);
        change(value);
        this.db
          .prepare('UPDATE deployment_operations SET data=? WHERE id=?')
          .run(JSON.stringify(value), id);
        return value;
      })
      .immediate();
  }
  release(id: string, phase: 'completed' | 'cancelled') {
    return this.db
      .transaction(() => {
        const value = this.update(id, (operation) => {
          operation.phase = phase;
        });
        this.db.prepare('UPDATE deployment_operations SET held=0 WHERE id=?').run(id);
        return value;
      })
      .immediate();
  }
  /** Only the captured continuation can enter during the explicit resume phase.
   * Native FIFO dispatch uses its separate predicate to retain saved ordering. */
  assertAdmission(sessionId: string, commandId?: string) {
    const operation = this.active();
    if (!operation) return;
    if (
      operation.phase === 'resuming' &&
      operation.sessions.some(
        (session) =>
          session.sessionId === sessionId &&
          session.resumeId === commandId &&
          session.state === 'resuming',
      )
    )
      return;
    throw Error('Server deployment has paused new commands; retry after maintenance');
  }
  canDispatch(sessionId: string) {
    const operation = this.active();
    return (
      !operation ||
      (operation.phase === 'resuming' &&
        operation.sessions.some(
          (session) =>
            session.sessionId === sessionId && ['resuming', 'resumed'].includes(session.state),
        ))
    );
  }
}

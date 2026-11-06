import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const TaskExecutionScopeSchema = z.strictObject({
  title: z.string().trim().min(1).max(240),
  network: z.enum(['none', 'loopback', 'internet']),
  repositories: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).max(20),
  expiresAt: z.number().int().positive().safe(),
  members: z
    .array(
      z.strictObject({
        sessionId: z.string().min(1).max(200),
        fingerprint: z.string().min(1).max(200),
        roots: z.array(z.string().min(1)).min(1).max(20),
      }),
    )
    .min(1)
    .max(20),
});
export type TaskExecutionScope = z.infer<typeof TaskExecutionScopeSchema>;
const GrantSchema = TaskExecutionScopeSchema.extend({
  id: z.uuid(),
  operatorId: z.string(),
  ownerSessionId: z.string(),
  issuedAt: z.number(),
  revokedAt: z.number().nullable(),
});
export type TaskExecutionGrant = z.infer<typeof GrantSchema>;
const RunResult = z.strictObject({ content: z.string().max(131072), isError: z.boolean() });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Consent is durable; it never makes an interrupted command safe to repeat.
 * The host must independently prove operator, runtime, mode and workspace
 * identity at each invocation and immediately before an effect.
 */
export class TaskExecutionStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_execution_grants (
        id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE(operator_id,owner_id,request_id));
      CREATE TABLE IF NOT EXISTS task_execution_runs (
        grant_id TEXT NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, result TEXT,
        PRIMARY KEY(grant_id,session_id,request_id));
    `);
  }
  close() {
    this.db.close();
  }
  approve(
    operatorId: string,
    ownerSessionId: string,
    requestId: string,
    raw: TaskExecutionScope,
  ): TaskExecutionGrant {
    const scope = TaskExecutionScopeSchema.parse(raw);
    if (
      !operatorId ||
      !ownerSessionId ||
      !requestId ||
      scope.expiresAt <= Date.now() ||
      !scope.members.some((member) => member.sessionId === ownerSessionId) ||
      new Set(scope.members.map((member) => member.sessionId)).size !== scope.members.length
    )
      throw Error('Invalid task authorization scope or owner');
    return this.db
      .transaction(() => {
        const previous = this.db
          .prepare(
            'SELECT fingerprint,data FROM task_execution_grants WHERE operator_id=? AND owner_id=? AND request_id=?',
          )
          .get(operatorId, ownerSessionId, requestId) as
          { fingerprint: string; data: string } | undefined;
        if (previous) {
          if (previous.fingerprint !== hash(scope))
            throw Error('Task authorization request changed');
          return GrantSchema.parse(JSON.parse(previous.data));
        }
        const grant: TaskExecutionGrant = {
          ...scope,
          id: randomUUID(),
          operatorId,
          ownerSessionId,
          issuedAt: Date.now(),
          revokedAt: null,
        };
        this.db
          .prepare('INSERT INTO task_execution_grants VALUES (?,?,?,?,?,?)')
          .run(grant.id, operatorId, ownerSessionId, requestId, hash(scope), JSON.stringify(grant));
        return grant;
      })
      .immediate();
  }
  private read(id: string): TaskExecutionGrant {
    const row = this.db.prepare('SELECT data FROM task_execution_grants WHERE id=?').get(id) as
      { data: string } | undefined;
    if (!row) throw Error('Task authorization was not found');
    return GrantSchema.parse(JSON.parse(row.data));
  }
  assertGrant(
    id: string,
    operatorId: string,
    sessionId: string,
    fingerprint: string,
  ): TaskExecutionGrant {
    const grant = this.read(id);
    if (
      grant.operatorId !== operatorId ||
      !grant.members.some(
        (member) => member.sessionId === sessionId && member.fingerprint === fingerprint,
      )
    )
      throw Error('Task authorization does not match this operator or workspace scope');
    if (grant.revokedAt !== null) throw Error('Task authorization was revoked');
    if (grant.expiresAt <= Date.now()) throw Error('Task authorization expired');
    return grant;
  }
  active(operatorId: string, sessionId: string): TaskExecutionGrant[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM task_execution_grants WHERE operator_id=? AND json_extract(data,'$.revokedAt') IS NULL AND json_extract(data,'$.expiresAt')>?",
        )
        .all(operatorId, Date.now()) as Array<{ data: string }>
    )
      .map((row) => GrantSchema.parse(JSON.parse(row.data)))
      .filter((grant) => grant.members.some((member) => member.sessionId === sessionId));
  }
  revoke(id: string, operatorId: string, sessionId: string) {
    const grant = this.read(id);
    if (grant.operatorId !== operatorId || grant.ownerSessionId !== sessionId)
      throw Error('Only the task authorization owner can revoke it');
    this.db
      .prepare("UPDATE task_execution_grants SET data=json_set(data,'$.revokedAt',?) WHERE id=?")
      .run(Date.now(), id);
  }
  begin(
    grantId: string,
    sessionId: string,
    requestId: string,
    fingerprint: string,
  ): { state: 'running' } | { state: 'completed'; result: z.infer<typeof RunResult> } {
    return this.db
      .transaction(() => {
        const previous = this.db
          .prepare(
            'SELECT fingerprint,result FROM task_execution_runs WHERE grant_id=? AND session_id=? AND request_id=?',
          )
          .get(grantId, sessionId, requestId) as
          { fingerprint: string; result: string | null } | undefined;
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw Error('Task execution request changed');
          if (previous.result === null)
            throw Error(
              'Task execution outcome is uncertain; inspect the existing work before starting another run',
            );
          return {
            state: 'completed' as const,
            result: RunResult.parse(JSON.parse(previous.result)),
          };
        }
        this.db
          .prepare('INSERT INTO task_execution_runs VALUES (?,?,?,?,NULL)')
          .run(grantId, sessionId, requestId, fingerprint);
        return { state: 'running' as const };
      })
      .immediate();
  }
  finish(grantId: string, sessionId: string, requestId: string, result: z.infer<typeof RunResult>) {
    const applied = this.db
      .prepare(
        'UPDATE task_execution_runs SET result=? WHERE grant_id=? AND session_id=? AND request_id=? AND result IS NULL',
      )
      .run(JSON.stringify(RunResult.parse(result)), grantId, sessionId, requestId);
    if (applied.changes !== 1) throw Error('Task execution result has no original unsettled run');
  }
}

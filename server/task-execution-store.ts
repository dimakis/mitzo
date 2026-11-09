import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { codexStoredAccountKey } from './codex-stored-account.js';
import type { AccountBinding } from '@mitzo/protocol';
import { z } from 'zod';
import { createLogger } from './logger.js';
const log = createLogger('task-execution-store');

export const TaskExecutionScopeSchema = z.strictObject({
  title: z.string().trim().min(1).max(240),
  network: z.enum(['none', 'loopback', 'internet']),
  repositories: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).max(20),
  expiresAt: z.number().int().positive().safe(),
  durationMinutes: z.number().int().min(1).max(480).optional(),
  inheritedGrants: z
    .array(
      z.strictObject({
        sessionId: z.string().min(1).max(200),
        grantId: z.uuid(),
        capability: z.discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('development') }),
          z.strictObject({
            kind: z.literal('github-read'),
            repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
          }),
        ]),
      }),
    )
    .max(420)
    .optional(),
  members: z
    .array(
      z.strictObject({
        sessionId: z.string().min(1).max(200),
        fingerprint: z.string().min(1).max(200),
        roots: z.array(z.string().min(1)).min(1).max(20),
        account: z
          .strictObject({
            accountId: z.string(),
            accountLabel: z.string(),
            provider: z.string(),
            model: z.string(),
            profileRevision: z.string(),
          })
          .nullable()
          .optional(),
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
export const taskExecutionFingerprint = (
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  timeoutMs = 60000,
) => hash([tool, input, cwd, timeoutMs]);
/** An identical retry must retain the original command's unknown outcome. */
export class UnsettledTaskExecutionError extends Error {}

/** Consent is durable; it never makes an interrupted command safe to repeat.
 * The host must independently prove operator, runtime, mode and workspace
 * identity at each invocation and immediately before an effect.
 */
export class TaskExecutionStore {
  private readonly revocations = new Map<string, Set<() => void>>();
  private readonly db: Database.Database;
  constructor(readonly path: string) {
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
    for (const id of this.revocations.keys()) this.notifyRevoked(id);
    this.db.close();
  }
  onRevoked(id: string, cancel: () => void): () => void {
    const listeners = this.revocations.get(id) ?? new Set<() => void>();
    listeners.add(cancel);
    this.revocations.set(id, listeners);
    return () => {
      listeners.delete(cancel);
      if (!listeners.size) this.revocations.delete(id);
    };
  }
  private notifyRevoked(id: string) {
    for (const cancel of this.revocations.get(id) ?? []) {
      try {
        cancel();
      } catch (error) {
        log.error('Task cancellation listener failed after revocation', {
          grantId: id,
          errorType: error instanceof Error ? error.name : 'non-Error',
        });
      }
    }
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
  findApprovedRequest(
    operatorId: string,
    ownerSessionId: string,
    requestId: string,
  ): TaskExecutionGrant | undefined {
    const row = this.db
      .prepare(
        'SELECT data FROM task_execution_grants WHERE operator_id=? AND owner_id=? AND request_id=?',
      )
      .get(operatorId, ownerSessionId, requestId) as { data: string } | undefined;
    return row ? GrantSchema.parse(JSON.parse(row.data)) : undefined;
  }
  inspectGrant(
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
    return grant;
  }
  assertGrant(
    id: string,
    operatorId: string,
    sessionId: string,
    fingerprint: string,
  ): TaskExecutionGrant {
    const grant = this.inspectGrant(id, operatorId, sessionId, fingerprint);
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
    this.notifyRevoked(id);
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
            throw new UnsettledTaskExecutionError(
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
  runStatus(
    grantId: string,
    sessionId: string,
    requestId: string,
  ):
    | { state: 'not_started' | 'uncertain' }
    | { state: 'completed'; result: z.infer<typeof RunResult> } {
    const row = this.db
      .prepare(
        'SELECT result FROM task_execution_runs WHERE grant_id=? AND session_id=? AND request_id=?',
      )
      .get(grantId, sessionId, requestId) as { result: string | null } | undefined;
    if (!row) return { state: 'not_started' };
    return row.result === null
      ? { state: 'uncertain' }
      : { state: 'completed', result: RunResult.parse(JSON.parse(row.result)) };
  }
  /** Historical observation only. Revocation/expiry never authorizes another run,
   * but does not erase the original executor's immutable completed result. */
  observeRunForRecovery(input: {
    grantId: string;
    sessionId: string;
    requestId: string;
    fingerprint: string;
    cwd: string;
    binding: AccountBinding;
  }) {
    const row = this.db
      .prepare(
        `SELECT r.fingerprint,r.result,g.data FROM task_execution_runs r
      JOIN task_execution_grants g ON g.id=r.grant_id
      WHERE r.grant_id=? AND r.session_id=? AND r.request_id=?`,
      )
      .get(input.grantId, input.sessionId, input.requestId) as
      { fingerprint: string; result: string | null; data: string } | undefined;
    if (!row || row.fingerprint !== input.fingerprint) return undefined;
    const grant = GrantSchema.parse(JSON.parse(row.data));
    const member = grant.members.find((value) => value.sessionId === input.sessionId);
    if (
      !member?.account ||
      codexStoredAccountKey(member.account as AccountBinding) !==
        codexStoredAccountKey(input.binding) ||
      !member.roots.some((root) => input.cwd === root || input.cwd.startsWith(root + '/'))
    )
      return undefined;
    return {
      grant,
      member,
      fingerprint: row.fingerprint,
      result: row.result === null ? null : RunResult.parse(JSON.parse(row.result)),
    };
  }
  hasMatchingCompletedRun(
    input: Parameters<TaskExecutionStore['observeRunForRecovery']>[0] & {
      result: z.infer<typeof RunResult>;
    },
  ): boolean {
    const observed = this.observeRunForRecovery(input);
    return (
      !!observed && observed.result !== null && isDeepStrictEqual(observed.result, input.result)
    );
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

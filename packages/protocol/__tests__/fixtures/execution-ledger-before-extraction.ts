/** Frozen SQL/state-machine behavior from accepted main 310a9a71.
 * Differential oracle only. DB/statements, registration validation and owner
 * method dispatch are injected; production never imports this fixture. */
import { randomUUID } from 'node:crypto';
import { ExecutionAdmissionError } from '../../src/event-store.js';
import type {
  BeginExecutionResult,
  ExecutionAdmission,
  BeginProviderAttemptResult,
  ProviderAttemptTransitionResult,
  ProviderAttemptRecord,
  ExecutionTransitionResult,
  ExecutionLedgerOwner,
  ExecutionSessionRow,
} from '../../src/execution-ledger.js';
import type {
  ExecutionToken,
  ExecutionPhase,
  ExecutionTerminalReason,
  ExecutionStateChangedPayload,
  ProviderAttemptToken,
  ProviderAttemptPhase,
  ProviderAttemptTerminalReason,
  ProviderAttemptStateChangedPayload,
  ClientSessionState,
} from '../../src/types.js';

const EXECUTION_TERMINAL_REASONS = new Set<ExecutionTerminalReason>([
  'completed',
  'failed',
  'stopped',
  'interrupted',
  'closed',
  'abandoned',
  'server_restart',
  'startup_failed',
]);

const EXECUTION_TRANSITIONS: Record<ExecutionPhase, ExecutionPhase[]> = {
  RUNNING: ['REQUIRES_ACTION', 'STOPPING', 'TERMINAL'],
  REQUIRES_ACTION: ['RUNNING', 'STOPPING', 'TERMINAL'],
  STOPPING: ['TERMINAL'],
  TERMINAL: [],
};

const PROVIDER_ATTEMPT_TERMINAL_REASONS = new Set<ProviderAttemptTerminalReason>([
  'completed',
  'failed',
  'ambiguous',
  'cancelled',
  'server_restart',
]);

function clientStateForExecution(phase: ExecutionPhase): ClientSessionState {
  if (phase === 'REQUIRES_ACTION') return 'requires_action';
  if (phase === 'RUNNING' || phase === 'STOPPING') return 'running';
  return 'idle';
}

export class ExecutionLedgerBeforeExtraction<Row extends ExecutionSessionRow> {
  constructor(private readonly owner: ExecutionLedgerOwner<Row>) {}
  /**
   * Atomically allocate the next durable execution generation for a session.
   * When a client command identity is supplied, exact retries return the
   * original token without appending another event or advancing generation.
   */
  beginExecution(
    sessionId: string,
    executionId?: string,
    clientMsgId?: string,
    requestFingerprint?: string,
  ): BeginExecutionResult {
    this.owner.assertConversationIdentity(sessionId);
    if (executionId !== undefined && !executionId.trim()) {
      throw new Error('executionId must not be empty');
    }
    const fingerprint = this.validateExecutionAdmission(clientMsgId, requestFingerprint);
    return this.owner
      .database()!
      .transaction((): BeginExecutionResult => {
        const current = this.owner.statements.getSession.get(sessionId) as Row | undefined;
        if (!current || !this.owner.isRegisteredConversation(current))
          throw new Error(
            `Cannot begin execution for unknown or unregistered session: ${sessionId}`,
          );

        if (clientMsgId) {
          const existing = this.owner.getExecutionAdmission(sessionId, clientMsgId);
          if (existing) {
            if (existing.requestFingerprint !== fingerprint) {
              throw new ExecutionAdmissionError(
                'fingerprint_conflict',
                'clientMsgId is already admitted for a different request fingerprint',
              );
            }
            if (executionId && existing.token.executionId !== executionId) {
              throw new ExecutionAdmissionError(
                'execution_id_conflict',
                'clientMsgId is already admitted for a different executionId',
              );
            }
            return { token: existing.token, duplicate: true };
          }
        }

        if (current.execution_phase && current.execution_phase !== 'TERMINAL') {
          throw new Error(`Cannot overwrite active execution for session: ${sessionId}`);
        }

        const acceptedExecutionId = executionId ?? randomUUID();
        const generation = (current.execution_generation ?? 0) + 1;
        const token: ExecutionToken = { sessionId, executionId: acceptedExecutionId, generation };
        const timestamp = Date.now();
        const event: ExecutionStateChangedPayload = {
          type: 'execution_state_changed',
          ...token,
          phase: 'RUNNING',
          clientState: 'running',
          timestamp,
        };
        const updated = this.owner
          .database()!
          .prepare(
            `UPDATE sessions SET
          execution_generation = ?, execution_id = ?, execution_phase = 'RUNNING',
          execution_terminal_reason = NULL, execution_updated_at = ?, updated_at = ?
         WHERE session_id = ?
           AND (execution_phase IS NULL OR execution_phase = 'TERMINAL')`,
          )
          .run(generation, acceptedExecutionId, timestamp, timestamp, sessionId);
        if (updated.changes !== 1) {
          throw new Error(`Execution admission changed for session: ${sessionId}`);
        }
        const seq = Number(
          this.owner.statements.append.run(sessionId, event.type, JSON.stringify(event), null, null)
            .lastInsertRowid,
        );
        if (clientMsgId) {
          this.owner
            .database()!
            .prepare(
              `INSERT INTO execution_admissions
            (session_id, client_msg_id, request_fingerprint, execution_id, generation)
           VALUES (?, ?, ?, ?, ?)`,
            )
            .run(sessionId, clientMsgId, fingerprint, acceptedExecutionId, generation);
        }
        return { token, duplicate: false, seq, event };
      })
      .immediate();
  }

  /** Read the terminal outcome of any generation, including superseded commands. */
  getExecutionTerminalReason(token: ExecutionToken): ExecutionTerminalReason | undefined {
    const row = this.owner
      .database()!
      .prepare(
        `SELECT json_extract(payload, '$.terminalReason') AS reason FROM events
       WHERE session_id = ? AND type = 'execution_state_changed'
         AND json_extract(payload, '$.executionId') = ?
         AND json_extract(payload, '$.generation') = ?
         AND json_extract(payload, '$.phase') = 'TERMINAL'
       ORDER BY seq DESC LIMIT 1`,
      )
      .get(token.sessionId, token.executionId, token.generation) as
      { reason: ExecutionTerminalReason } | undefined;
    return row?.reason;
  }

  /** Read a durable execution admission receipt without consulting transport state. */
  getExecutionAdmission(sessionId: string, clientMsgId: string): ExecutionAdmission | undefined {
    const row = this.owner
      .database()!
      .prepare(
        `SELECT execution_id, generation, request_fingerprint
       FROM execution_admissions WHERE session_id = ? AND client_msg_id = ?`,
      )
      .get(sessionId, clientMsgId) as
      { execution_id: string; generation: number; request_fingerprint: string } | undefined;
    return (
      row && {
        token: { sessionId, executionId: row.execution_id, generation: row.generation },
        requestFingerprint: row.request_fingerprint,
      }
    );
  }

  private validateExecutionAdmission(
    clientMsgId: string | undefined,
    requestFingerprint: string | undefined,
  ): string | undefined {
    if (clientMsgId === undefined) {
      if (requestFingerprint !== undefined) {
        throw new ExecutionAdmissionError(
          'fingerprint_required',
          'requestFingerprint requires a clientMsgId',
        );
      }
      return undefined;
    }
    if (!clientMsgId.trim() || clientMsgId.length > 512) {
      throw new ExecutionAdmissionError(
        'fingerprint_required',
        'clientMsgId must be a non-empty string of at most 512 characters',
      );
    }
    if (
      typeof requestFingerprint !== 'string' ||
      !requestFingerprint.trim() ||
      requestFingerprint.length > 512
    ) {
      throw new ExecutionAdmissionError(
        'fingerprint_required',
        'requestFingerprint must be a non-empty string of at most 512 characters',
      );
    }
    return requestFingerprint;
  }

  /** Start one durable provider dispatch owned by the exact active execution token. */
  beginProviderAttempt(
    executionToken: ExecutionToken,
    providerAttemptId: string = randomUUID(),
    options: { allowParallel?: boolean } = {},
  ): BeginProviderAttemptResult {
    if (!providerAttemptId.trim()) throw new Error('providerAttemptId must not be empty');
    return this.owner
      .database()!
      .transaction((): BeginProviderAttemptResult => {
        const existing = this.owner
          .database()!
          .prepare(
            `SELECT execution_id, generation, attempt_number FROM provider_attempts
         WHERE session_id = ? AND provider_attempt_id = ?`,
          )
          .get(executionToken.sessionId, providerAttemptId) as
          { execution_id: string; generation: number; attempt_number: number } | undefined;
        if (existing) {
          if (
            existing.execution_id !== executionToken.executionId ||
            existing.generation !== executionToken.generation
          ) {
            throw new Error('providerAttemptId is already bound to a different execution token');
          }
          return {
            token: {
              ...executionToken,
              providerAttemptId,
              attempt: existing.attempt_number,
            },
            duplicate: true,
          };
        }

        const current = this.owner.statements.getSession.get(executionToken.sessionId) as
          Row | undefined;
        if (
          !current ||
          current.execution_id !== executionToken.executionId ||
          current.execution_generation !== executionToken.generation ||
          current.execution_phase !== 'RUNNING'
        ) {
          throw new Error('Cannot begin provider attempt for stale execution token');
        }

        const active = this.owner
          .database()!
          .prepare(
            `SELECT 1 FROM provider_attempts
         WHERE session_id = ? AND execution_id = ? AND generation = ? AND phase = 'RUNNING'
         LIMIT 1`,
          )
          .get(executionToken.sessionId, executionToken.executionId, executionToken.generation);
        if (active && !options.allowParallel) {
          throw new Error(
            `Cannot overwrite active provider attempt for execution: ${executionToken.executionId}`,
          );
        }

        const previous = this.owner
          .database()!
          .prepare(
            `SELECT MAX(attempt_number) AS attempt_number FROM provider_attempts
         WHERE session_id = ? AND execution_id = ? AND generation = ?`,
          )
          .get(executionToken.sessionId, executionToken.executionId, executionToken.generation) as {
          attempt_number: number | null;
        };
        const attempt = (previous.attempt_number ?? 0) + 1;
        const token: ProviderAttemptToken = {
          ...executionToken,
          providerAttemptId,
          attempt,
        };
        const timestamp = Date.now();
        const event: ProviderAttemptStateChangedPayload = {
          type: 'provider_attempt_state_changed',
          ...token,
          phase: 'RUNNING',
          timestamp,
        };
        this.owner
          .database()!
          .prepare(
            `INSERT INTO provider_attempts (
          session_id, execution_id, generation, attempt_number, provider_attempt_id,
          phase, terminal_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'RUNNING', NULL, ?, ?)`,
          )
          .run(
            token.sessionId,
            token.executionId,
            token.generation,
            token.attempt,
            token.providerAttemptId,
            timestamp,
            timestamp,
          );
        const seq = Number(
          this.owner.statements.append.run(
            token.sessionId,
            event.type,
            JSON.stringify(event),
            null,
            null,
          ).lastInsertRowid,
        );
        return { token, duplicate: false, seq, event };
      })
      .immediate();
  }

  /** Apply a token-guarded provider-attempt transition and event atomically. */
  transitionProviderAttempt(
    token: ProviderAttemptToken,
    nextPhase: ProviderAttemptPhase,
    terminalReason?: ProviderAttemptTerminalReason,
  ): ProviderAttemptTransitionResult {
    this.validateProviderAttemptTransition(nextPhase, terminalReason);
    return this.owner
      .database()!
      .transaction((): ProviderAttemptTransitionResult => {
        const current = this.owner
          .database()!
          .prepare(
            `SELECT phase, terminal_reason FROM provider_attempts
         WHERE session_id = ? AND execution_id = ? AND generation = ?
           AND attempt_number = ? AND provider_attempt_id = ?`,
          )
          .get(
            token.sessionId,
            token.executionId,
            token.generation,
            token.attempt,
            token.providerAttemptId,
          ) as
          | {
              phase: ProviderAttemptPhase;
              terminal_reason: ProviderAttemptTerminalReason | null;
            }
          | undefined;
        if (!current) return { applied: false, status: 'stale', token };
        if (current.phase === 'TERMINAL') {
          const persistedTerminalReason = current.terminal_reason;
          if (nextPhase === 'TERMINAL' && persistedTerminalReason !== terminalReason) {
            return {
              applied: false,
              status: 'conflict',
              token,
              persistedTerminalReason,
            };
          }
          return {
            applied: false,
            status: 'terminal',
            token,
            persistedTerminalReason,
          };
        }

        const currentExecution = this.owner.statements.getSession.get(token.sessionId) as
          Row | undefined;
        if (
          !currentExecution ||
          currentExecution.execution_id !== token.executionId ||
          currentExecution.execution_generation !== token.generation ||
          currentExecution.execution_phase === 'TERMINAL'
        ) {
          return { applied: false, status: 'stale', token };
        }
        if (nextPhase !== 'TERMINAL') {
          return { applied: false, status: 'invalid_transition', token };
        }

        const timestamp = Date.now();
        const event: ProviderAttemptStateChangedPayload = {
          type: 'provider_attempt_state_changed',
          ...token,
          phase: nextPhase,
          terminalReason,
          timestamp,
        };
        const updated = this.owner
          .database()!
          .prepare(
            `UPDATE provider_attempts SET phase = ?, terminal_reason = ?, updated_at = ?
         WHERE session_id = ? AND execution_id = ? AND generation = ?
           AND attempt_number = ? AND provider_attempt_id = ? AND phase = 'RUNNING'`,
          )
          .run(
            nextPhase,
            terminalReason,
            timestamp,
            token.sessionId,
            token.executionId,
            token.generation,
            token.attempt,
            token.providerAttemptId,
          );
        if (updated.changes !== 1) return { applied: false, status: 'stale', token };
        const seq = Number(
          this.owner.statements.append.run(
            token.sessionId,
            event.type,
            JSON.stringify(event),
            null,
            null,
          ).lastInsertRowid,
        );
        return { applied: true, status: 'applied', token, seq, event };
      })
      .immediate();
  }

  /** Read provider-attempt history for one immutable execution generation. */
  getProviderAttempts(executionToken: ExecutionToken): ProviderAttemptRecord[] {
    const rows = this.owner
      .database()!
      .prepare(
        `SELECT attempt_number, provider_attempt_id, phase, terminal_reason, updated_at
       FROM provider_attempts
       WHERE session_id = ? AND execution_id = ? AND generation = ?
       ORDER BY attempt_number`,
      )
      .all(
        executionToken.sessionId,
        executionToken.executionId,
        executionToken.generation,
      ) as Array<{
      attempt_number: number;
      provider_attempt_id: string;
      phase: ProviderAttemptPhase;
      terminal_reason: ProviderAttemptTerminalReason | null;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      token: {
        ...executionToken,
        providerAttemptId: row.provider_attempt_id,
        attempt: row.attempt_number,
      },
      phase: row.phase,
      terminalReason: row.terminal_reason,
      updatedAt: row.updated_at,
    }));
  }

  private validateProviderAttemptTransition(
    nextPhase: ProviderAttemptPhase,
    terminalReason?: ProviderAttemptTerminalReason,
  ): void {
    if (nextPhase === 'TERMINAL') {
      if (!terminalReason || !PROVIDER_ATTEMPT_TERMINAL_REASONS.has(terminalReason)) {
        throw new Error(
          'A valid terminal reason is required when transitioning provider attempt to TERMINAL',
        );
      }
      return;
    }
    if (terminalReason !== undefined) {
      throw new Error('terminalReason is only valid for TERMINAL provider attempts');
    }
  }

  /** Apply one token-guarded execution transition and persist its event atomically. */
  transitionExecution(
    token: ExecutionToken,
    nextPhase: ExecutionPhase,
    terminalReason?: ExecutionTerminalReason,
  ): ExecutionTransitionResult {
    this.validateExecutionTransition(nextPhase, terminalReason);
    return this.owner
      .database()!
      .transaction((): ExecutionTransitionResult => {
        const current = this.owner.statements.getSession.get(token.sessionId) as Row | undefined;
        if (
          !current ||
          current.execution_id !== token.executionId ||
          current.execution_generation !== token.generation ||
          !current.execution_phase
        ) {
          return { applied: false, status: 'stale', token };
        }

        const phase = current.execution_phase as ExecutionPhase;
        if (phase === 'TERMINAL') return { applied: false, status: 'terminal', token };
        if (phase === 'STOPPING' && nextPhase === 'STOPPING') {
          return { applied: false, status: 'already_stopping', token };
        }
        if (!EXECUTION_TRANSITIONS[phase]?.includes(nextPhase)) {
          return { applied: false, status: 'invalid_transition', token };
        }
        if (nextPhase === 'TERMINAL') {
          const activeProviderAttempt = this.owner
            .database()!
            .prepare(
              `SELECT 1 FROM provider_attempts
           WHERE session_id = ? AND execution_id = ? AND generation = ? AND phase = 'RUNNING'
           LIMIT 1`,
            )
            .get(token.sessionId, token.executionId, token.generation);
          if (activeProviderAttempt) {
            throw new Error('Cannot terminalize execution with an active provider attempt');
          }
        }

        const timestamp = Date.now();
        const event: ExecutionStateChangedPayload = {
          type: 'execution_state_changed',
          ...token,
          phase: nextPhase,
          clientState: clientStateForExecution(nextPhase),
          ...(terminalReason ? { terminalReason } : {}),
          timestamp,
        };
        const updated = this.owner
          .database()!
          .prepare(
            `UPDATE sessions SET
          execution_phase = ?, execution_terminal_reason = ?, execution_updated_at = ?,
          updated_at = ?
         WHERE session_id = ? AND execution_id = ? AND execution_generation = ?
           AND execution_phase = ?`,
          )
          .run(
            nextPhase,
            nextPhase === 'TERMINAL' ? terminalReason : null,
            timestamp,
            timestamp,
            token.sessionId,
            token.executionId,
            token.generation,
            phase,
          );
        if (updated.changes !== 1) return { applied: false, status: 'stale', token };
        const seq = Number(
          this.owner.statements.append.run(
            token.sessionId,
            event.type,
            JSON.stringify(event),
            null,
            null,
          ).lastInsertRowid,
        );
        return { applied: true, status: 'applied', token, seq, event };
      })
      .immediate();
  }

  /** Terminalize only non-terminal executions orphaned by a process restart. */
  recoverOrphanedExecutions(options: { excludeSymposium?: boolean } = {}): number {
    const rows = this.owner
      .database()!
      .prepare(
        `SELECT session_id, execution_id, execution_generation
       FROM sessions
       WHERE execution_phase IN ('RUNNING', 'REQUIRES_ACTION', 'STOPPING')
         AND execution_id IS NOT NULL
         AND (? = 0 OR (COALESCE(session_type,'') != 'symposium' AND symposium_config IS NULL))`,
      )
      .all(options.excludeSymposium ? 1 : 0) as Array<{
      session_id: string;
      execution_id: string;
      execution_generation: number;
    }>;
    let recovered = 0;
    for (const row of rows) {
      const token: ExecutionToken = {
        sessionId: row.session_id,
        executionId: row.execution_id,
        generation: row.execution_generation,
      };
      const activeProviderAttempts = this.owner
        .getProviderAttempts(token)
        .filter((attempt) => attempt.phase === 'RUNNING');
      for (const attempt of activeProviderAttempts) {
        this.owner.transitionProviderAttempt(attempt.token, 'TERMINAL', 'ambiguous');
      }
      const result = this.owner.transitionExecution(token, 'TERMINAL', 'server_restart');
      if (result.applied) recovered++;
    }
    return recovered;
  }

  private validateExecutionTransition(
    nextPhase: ExecutionPhase,
    terminalReason?: ExecutionTerminalReason,
  ): void {
    if (nextPhase === 'TERMINAL') {
      if (!terminalReason || !EXECUTION_TERMINAL_REASONS.has(terminalReason)) {
        throw new Error('A valid terminal reason is required when transitioning to TERMINAL');
      }
      return;
    }
    if (terminalReason !== undefined) {
      throw new Error('terminalReason is only valid for TERMINAL transitions');
    }
  }
}

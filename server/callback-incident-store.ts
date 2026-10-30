import type Database from 'better-sqlite3';
import { writeFileSync, fsyncSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AccountBinding } from '@mitzo/protocol';
import type { CodexConversationStore } from './codex-conversation-store.js';
import { callbackIncident, incidentHash } from './callback-incident-evidence.js';

/** Incident-specific storage adapter. Generic recovery remains conservative. */
export class CallbackIncidentStore {
  constructor(
    private readonly db: Database.Database,
    private readonly native: Pick<
      CodexConversationStore,
      | 'read'
      | 'assertNoPendingThreadDispatch'
      | 'assertNoPendingThreadOwnership'
      | 'capacityRecovery'
      | 'nativeRecoveryTarget'
      | 'continuationBlocker'
    >,
  ) {}
  private callbackIncidentRows() {
    // Fixed table list, fixed incident. Raw history is hashed/backed up privately,
    // never returned to HTTP callers or parsed into a replacement instruction.
    return Object.fromEntries(
      [
        'codex_conversations',
        'codex_commands',
        'codex_tools',
        'codex_thread_generations',
        'codex_thread_acceptances',
        'codex_pending_thread_dispatches',
        'codex_startup_reservations',
        'codex_capacity_recoveries',
        'codex_capacity_continuations',
        'codex_workspace_transitions',
      ].map((table) => [
        table,
        this.db
          .prepare(
            `SELECT * FROM ${table} WHERE ${table === 'codex_conversations' ? 'id' : 'conversation_id'}=? ORDER BY rowid`,
          )
          .all(callbackIncident.sessionId),
      ]),
    );
  }
  private callbackIncidentReceipt() {
    return this.db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='codex_callback_incident_repairs'",
      )
      .get()
      ? (this.db
          .prepare('SELECT * FROM codex_callback_incident_repairs WHERE conversation_id=?')
          .get(callbackIncident.sessionId) as
          | { plan_hash: string; post_hash: string; evidence_hash: string; operator_hash: string }
          | undefined)
      : undefined;
  }
  callbackIncidentToolReceipts(binding: AccountBinding) {
    this.native.read(callbackIncident.sessionId, binding);
    return (
      this.db
        .prepare(
          'SELECT call_id,tool_name,request_hash,result_content,result_is_error FROM codex_tools WHERE conversation_id=? AND command_id=? ORDER BY rowid',
        )
        .all(callbackIncident.sessionId, callbackIncident.commandId) as Array<{
        call_id: string;
        tool_name: string;
        request_hash: string;
        result_content: string;
        result_is_error: number;
      }>
    ).map((row) => ({
      callId: row.call_id,
      toolName: row.tool_name,
      requestHash: row.request_hash,
      resultHash: incidentHash(row.result_content),
      isError: row.result_is_error,
    }));
  }
  /** Exact incident inspection. No no-hook phase is synthesized for old code. */
  inspectCallbackIncident(binding: AccountBinding): string {
    const incident = callbackIncident;
    const state = this.native.read(incident.sessionId, binding);
    const hash = incidentHash(JSON.stringify(this.callbackIncidentRows()));
    const prior = this.callbackIncidentReceipt();
    if (prior) {
      if (prior.post_hash !== hash) throw Error('Repaired incident has changed');
      return prior.plan_hash;
    }
    this.native.assertNoPendingThreadDispatch(incident.sessionId, binding);
    this.native.assertNoPendingThreadOwnership(incident.sessionId, binding);
    if (
      !state.recovery ||
      state.threadId !== incident.threadId ||
      state.threadGeneration !== incident.generation ||
      this.native.capacityRecovery(incident.sessionId, binding)
    )
      throw Error('Historical native custody changed');
    const target = this.native.nativeRecoveryTarget(incident.sessionId, binding);
    if (
      !isDeepStrictEqual(target, {
        commandId: incident.commandId,
        attempt: 1,
        threadId: incident.threadId,
        turnId: incident.turnId,
        generation: 2,
      })
    )
      throw Error('Historical native acceptance changed');
    const command = this.db
      .prepare(
        'SELECT status,attempt,ambiguous,recovery_acknowledged,completion_phases FROM codex_commands WHERE conversation_id=? AND id=?',
      )
      .get(incident.sessionId, incident.commandId) as Record<string, unknown>;
    if (
      !isDeepStrictEqual(command, {
        status: 'completed',
        attempt: 1,
        ambiguous: 1,
        recovery_acknowledged: 0,
        completion_phases: null,
      })
    )
      throw Error('Historical command changed');
    const tool = this.db
      .prepare(
        'SELECT command_id,turn_id,tool_name,request_hash,result_content,result_is_error FROM codex_tools WHERE conversation_id=? AND call_id=?',
      )
      .get(incident.sessionId, incident.callId);
    if (
      !isDeepStrictEqual(tool, {
        command_id: incident.commandId,
        turn_id: incident.turnId,
        tool_name: 'RequestWebAccess',
        request_hash: incident.requestHash,
        result_content: incident.result,
        result_is_error: 1,
      })
    )
      throw Error('Original read-access receipt changed');
    const queued = this.db
      .prepare(
        "SELECT id,attempt,native_turns,native_execution_history FROM codex_commands WHERE conversation_id=? AND status='queued' ORDER BY sequence",
      )
      .all(incident.sessionId);
    if (
      !isDeepStrictEqual(
        queued,
        incident.queuedIds.map((id) => ({
          id,
          attempt: 1,
          native_turns: null,
          native_execution_history: null,
        })),
      )
    )
      throw Error('Queued input changed');
    if (
      this.db
        .prepare(
          "SELECT 1 FROM codex_commands WHERE conversation_id=? AND id<>? AND (status NOT IN ('completed','cancelled','queued') OR ambiguous=1) LIMIT 1",
        )
        .get(incident.sessionId, incident.commandId) ||
      this.db
        .prepare(
          'SELECT 1 FROM codex_tools WHERE conversation_id=? AND result_content IS NULL LIMIT 1',
        )
        .get(incident.sessionId) ||
      this.db
        .prepare('SELECT 1 FROM codex_startup_reservations WHERE conversation_id=?')
        .get(incident.sessionId) ||
      this.db
        .prepare(
          "SELECT 1 FROM codex_workspace_transitions WHERE conversation_id=? AND state IN ('holding','waiting')",
        )
        .get(incident.sessionId)
    )
      throw Error('Other native effects remain unresolved');
    const unsettled = this.native.continuationBlocker(incident.sessionId, binding);
    if (
      !unsettled ||
      unsettled.commandId !== incident.commandId ||
      unsettled.kind === 'completion_phase'
    )
      throw Error('Historical effect scope changed');
    return hash;
  }
  /** Called only by the authenticated, fenced incident endpoint after fresh
   * source/native/event evidence. It never dispatches or pumps queued work. */
  applyCallbackIncident(
    binding: AccountBinding,
    planHash: string,
    audit: { evidenceHash: string; operatorHash: string },
  ) {
    if (
      ![planHash, audit.evidenceHash, audit.operatorHash].every((hash) =>
        /^[a-f0-9]{64}$/.test(hash),
      )
    )
      throw Error('Invalid incident audit');
    return this.db
      .transaction(() => {
        if (this.inspectCallbackIncident(binding) !== planHash)
          throw Error('Incident changed after inspection');
        const prior = this.callbackIncidentReceipt();
        if (prior) {
          if (
            prior.evidence_hash !== audit.evidenceHash ||
            prior.operator_hash !== audit.operatorHash
          )
            throw Error('Incident audit identity changed');
          return { status: 'already_reconciled' as const };
        }
        const backupPath = join(dirname(this.db.name), `callback-incident-${randomUUID()}.json`);
        const fd = openSync(backupPath, 'wx', 0o600);
        try {
          writeFileSync(
            fd,
            JSON.stringify({
              version: 1,
              incident: callbackIncident,
              rows: this.callbackIncidentRows(),
            }),
          );
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        const parent = openSync(dirname(backupPath), 'r');
        try {
          fsyncSync(parent);
        } finally {
          closeSync(parent);
        }
        const changed = this.db
          .prepare(
            'UPDATE codex_commands SET ambiguous=0,recovery_acknowledged=1 WHERE conversation_id=? AND id=? AND attempt=1 AND ambiguous=1 AND recovery_acknowledged=0',
          )
          .run(callbackIncident.sessionId, callbackIncident.commandId);
        if (
          changed.changes !== 1 ||
          this.native.continuationBlocker(callbackIncident.sessionId, binding)
        )
          throw Error('Incident reconciliation no longer qualifies');
        this.db
          .prepare('UPDATE codex_conversations SET recovery=0,automatic_recovery=0 WHERE id=?')
          .run(callbackIncident.sessionId);
        this.db.exec(
          'CREATE TABLE IF NOT EXISTS codex_callback_incident_repairs (conversation_id TEXT PRIMARY KEY,plan_hash TEXT NOT NULL,post_hash TEXT NOT NULL,evidence_hash TEXT NOT NULL,operator_hash TEXT NOT NULL,backup_path TEXT NOT NULL,created_at INTEGER NOT NULL)',
        );
        this.db
          .prepare('INSERT INTO codex_callback_incident_repairs VALUES(?,?,?,?,?,?,?)')
          .run(
            callbackIncident.sessionId,
            planHash,
            incidentHash(JSON.stringify(this.callbackIncidentRows())),
            audit.evidenceHash,
            audit.operatorHash,
            backupPath,
            Date.now(),
          );
        return { status: 'reconciled' as const };
      })
      .immediate();
  }
}

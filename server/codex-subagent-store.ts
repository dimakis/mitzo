import { callbackOutcome, retainCallbackOutcome } from './turn-callbacks.js';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  NativeSubagentSnapshotSchema,
  type NativeSubagentControl,
  type NativeSubagentControlStatus,
  type AccountBinding,
} from '@mitzo/protocol';
import type { CodexToolResult } from './codex-tool-result.js';

export interface SubagentScope {
  conversationId: string;
  bindingRevision: string;
}
export function subagentScope(conversationId: string, binding: AccountBinding): SubagentScope {
  return {
    conversationId,
    bindingRevision: createHash('sha256')
      .update(JSON.stringify([binding.provider, binding.accountId, binding.profileRevision]))
      .digest('hex'),
  };
}
export function subagentSnapshot(child: RetainedSubagent, available = false) {
  return NativeSubagentSnapshotSchema.parse({
    threadId: child.threadId,
    parentThreadId: child.parentThreadId,
    commandId: child.commandId,
    name: child.name,
    task: child.task,
    model: child.model,
    turnId: child.turnId,
    revision: child.revision,
    blocks: child.blocks,
    usage: child.usage,
    outputTruncated: child.outputTruncated,
    inspectionFailure: child.inspectionFailure,
    available,
    state:
      !available && ['starting', 'working', 'needs_permission', 'stopping'].includes(child.state)
        ? 'unknown'
        : child.state,
  });
}
const RetainedChild = NativeSubagentSnapshotSchema.extend({
  rootThreadId: z.string().min(1),
  commandId: z.string().min(1),
  policyRevision: z.string().min(1),
  commandAttempt: z.number().int().positive().optional(),
  threadGeneration: z.number().int().nonnegative().optional(),
  // Observation establishes visibility only. Native identity must still be verified.
  admissionVerified: z.boolean().optional(),
  /** Missing on legacy rows, whose already emitted activity must not be replayed. */
  activityAnchored: z.boolean().optional(),
});
export type RetainedSubagent = z.infer<typeof RetainedChild>;
export interface ChildToolIdentity {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  requestHash: string;
}
/** Uses the conversation owner's existing private, FULL-synchronous database.
 * Claims survive transport loss. An unrecorded outcome is never executable again. */
export class CodexSubagentStore {
  private readonly hasEffectOutcomeTable: boolean;
  constructor(
    private readonly db: Database.Database,
    initialize = true,
  ) {
    if (initialize)
      db.exec(`CREATE TABLE IF NOT EXISTS codex_subagents (
      conversation_id TEXT NOT NULL, binding_revision TEXT NOT NULL, thread_id TEXT NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY(conversation_id,binding_revision,thread_id));
      CREATE TABLE IF NOT EXISTS codex_subagent_effects (
      conversation_id TEXT NOT NULL, binding_revision TEXT NOT NULL, effect_id TEXT NOT NULL,
      identity TEXT NOT NULL, result TEXT,
      PRIMARY KEY(conversation_id,binding_revision,effect_id));`);
    // Keep the original five-column table compatible with retained rollback
    // writers that use positional INSERT. Outcome proof is an independent fact.
    if (initialize)
      db.exec(`CREATE TABLE IF NOT EXISTS codex_subagent_effect_outcomes (
        conversation_id TEXT NOT NULL, binding_revision TEXT NOT NULL, effect_id TEXT NOT NULL,
        receipt_digest TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('settled','unknown')),
        PRIMARY KEY(conversation_id,binding_revision,effect_id))`);
    this.hasEffectOutcomeTable = !!db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_subagent_effect_outcomes'",
      )
      .get();
  }
  /** Unqualified retained child activity blocks a deployment, including cold unknown trees. */
  unsettledConversationIds(): string[] {
    const rows = this.db
      .prepare('SELECT conversation_id,data FROM codex_subagents')
      .all() as Array<{ conversation_id: string; data: string }>;
    const unsettled = new Set(
      rows
        .filter(
          (row) =>
            !['completed', 'failed', 'stopped'].includes(
              RetainedChild.parse(JSON.parse(row.data)).state,
            ),
        )
        .map((row) => row.conversation_id),
    );
    // Stream the joined receipts: bound memory and avoid one query per effect.
    // Metadata is historical proof only while its exact original bytes match.
    const effects = this.db.prepare(`SELECT e.conversation_id,e.identity,e.result,
      ${this.hasEffectOutcomeTable ? 'o.receipt_digest,o.outcome' : 'NULL AS receipt_digest,NULL AS outcome'}
      FROM codex_subagent_effects e ${this.effectOutcomeJoin()}
      WHERE e.result IS NULL OR e.result='"uncertain"' OR e.effect_id LIKE 'tool:%'`);
    for (const row of effects.iterate() as Iterable<{
      conversation_id: string;
      identity: string;
      result: string | null;
      receipt_digest: string | null;
      outcome: string | null;
    }>) {
      if (unsettled.has(row.conversation_id)) continue;
      if (
        row.result === null ||
        row.result === '"uncertain"' ||
        row.outcome !== 'settled' ||
        row.receipt_digest !== this.receiptDigest(row.identity, row.result)
      )
        unsettled.add(row.conversation_id);
    }
    return [...unsettled];
  }
  private receiptDigest(identity: string, result: string | null) {
    return createHash('sha256')
      .update(JSON.stringify([identity, result]))
      .digest('hex');
  }
  private effectOutcomeJoin() {
    return this.hasEffectOutcomeTable
      ? `LEFT JOIN codex_subagent_effect_outcomes o
      ON o.conversation_id=e.conversation_id AND o.binding_revision=e.binding_revision AND o.effect_id=e.effect_id`
      : '';
  }
  list(scope: SubagentScope): RetainedSubagent[] {
    return (
      this.db
        .prepare(
          'SELECT data FROM codex_subagents WHERE conversation_id=? AND binding_revision=? ORDER BY rowid',
        )
        .all(scope.conversationId, scope.bindingRevision) as { data: string }[]
    ).map((row) => RetainedChild.parse(JSON.parse(row.data)));
  }
  get(scope: SubagentScope, threadId: string): RetainedSubagent | undefined {
    const row = this.db
      .prepare(
        'SELECT data FROM codex_subagents WHERE conversation_id=? AND binding_revision=? AND thread_id=?',
      )
      .get(scope.conversationId, scope.bindingRevision, threadId) as { data: string } | undefined;
    return row ? RetainedChild.parse(JSON.parse(row.data)) : undefined;
  }
  save(scope: SubagentScope, raw: RetainedSubagent): void {
    const child = RetainedChild.parse(raw);
    const previous = this.get(scope, child.threadId);
    if (previous) {
      for (const key of ['parentThreadId', 'rootThreadId', 'commandId', 'policyRevision'] as const)
        if (previous[key] !== child[key]) throw Error('Child identity changed');
      for (const key of ['commandAttempt', 'threadGeneration'] as const)
        if (previous[key] !== undefined && previous[key] !== child[key])
          throw Error('Child native origin changed');
      if (child.revision <= previous.revision && !isDeepStrictEqual(previous, child))
        throw Error('Child revision is stale');
    }
    this.db
      .prepare(
        'INSERT INTO codex_subagents VALUES(?,?,?,?) ON CONFLICT(conversation_id,binding_revision,thread_id) DO UPDATE SET data=excluded.data',
      )
      .run(scope.conversationId, scope.bindingRevision, child.threadId, JSON.stringify(child));
  }
  private effect(scope: SubagentScope, key: string, identity: unknown) {
    const row = this.db
      .prepare(
        `SELECT e.identity,e.result,${this.hasEffectOutcomeTable ? 'o.receipt_digest,o.outcome' : 'NULL AS receipt_digest,NULL AS outcome'} FROM codex_subagent_effects e ${this.effectOutcomeJoin()} WHERE e.conversation_id=? AND e.binding_revision=? AND e.effect_id=?`,
      )
      .get(scope.conversationId, scope.bindingRevision, key) as
      | {
          identity: string;
          result: string | null;
          receipt_digest: string | null;
          outcome: 'settled' | 'unknown' | null;
        }
      | undefined;
    if (row && !isDeepStrictEqual(JSON.parse(row.identity), identity))
      throw Error('Effect identity changed');
    if (row && row.receipt_digest !== this.receiptDigest(row.identity, row.result))
      row.outcome = null;
    return row;
  }
  private claim(scope: SubagentScope, key: string, identity: unknown): boolean {
    if (this.effect(scope, key, identity)) return false;
    return (
      this.db
        .prepare(
          'INSERT OR IGNORE INTO codex_subagent_effects(conversation_id,binding_revision,effect_id,identity,result) VALUES(?,?,?,?,NULL)',
        )
        .run(scope.conversationId, scope.bindingRevision, key, JSON.stringify(identity)).changes ===
      1
    );
  }
  private finish(scope: SubagentScope, key: string, identity: unknown, result: unknown): void {
    const row = this.effect(scope, key, identity);
    if (!row) throw Error('Effect was not claimed');
    const value = JSON.stringify(result);
    if (row.result !== null && row.result !== value) throw Error('Effect outcome changed');
    this.db
      .prepare(
        'UPDATE codex_subagent_effects SET result=? WHERE conversation_id=? AND binding_revision=? AND effect_id=?',
      )
      .run(value, scope.conversationId, scope.bindingRevision, key);
  }
  claimTool(scope: SubagentScope, call: ChildToolIdentity): boolean {
    const child = this.get(scope, call.threadId);
    if (!child || child.turnId !== call.turnId) throw Error('Child tool identity mismatch');
    return this.claim(scope, `tool:${call.callId}`, call);
  }
  toolResult(scope: SubagentScope, call: ChildToolIdentity): CodexToolResult | undefined {
    const row = this.effect(scope, `tool:${call.callId}`, call);
    return row?.result
      ? retainCallbackOutcome(
          JSON.parse(row.result),
          row.outcome === 'settled' ? 'settled' : 'unknown',
        )
      : undefined;
  }
  pendingTool(scope: SubagentScope, call: ChildToolIdentity): boolean {
    return this.effect(scope, `tool:${call.callId}`, call)?.result === null;
  }
  finishTool(scope: SubagentScope, call: ChildToolIdentity, result: CodexToolResult): void {
    if (!this.hasEffectOutcomeTable) throw Error('Child effect metadata is read-only');
    const outcome = callbackOutcome(result);
    this.db
      .transaction(() => {
        const previous = this.effect(scope, `tool:${call.callId}`, call);
        if (!previous) throw Error('Effect was not claimed');
        if (previous.result !== null && previous.outcome !== outcome)
          throw Error('Child effect outcome changed');
        this.finish(scope, `tool:${call.callId}`, call, result);
        if (previous.result !== null) return;
        this.db
          .prepare('INSERT INTO codex_subagent_effect_outcomes VALUES(?,?,?,?,?)')
          .run(
            scope.conversationId,
            scope.bindingRevision,
            `tool:${call.callId}`,
            this.receiptDigest(previous.identity, JSON.stringify(result)),
            outcome,
          );
      })
      .immediate();
  }
  controlResult(
    scope: SubagentScope,
    input: NativeSubagentControl,
  ): NativeSubagentControlStatus | undefined {
    const row = this.effect(scope, `control:${input.requestId}`, input);
    return row ? (row.result ? JSON.parse(row.result) : 'uncertain') : undefined;
  }
  claimControl(
    scope: SubagentScope,
    input: NativeSubagentControl,
  ): NativeSubagentControlStatus | undefined {
    if (this.claim(scope, `control:${input.requestId}`, input)) return undefined;
    const row = this.effect(scope, `control:${input.requestId}`, input)!;
    return row.result ? JSON.parse(row.result) : 'uncertain';
  }
  finishControl(
    scope: SubagentScope,
    input: NativeSubagentControl,
    status: NativeSubagentControlStatus,
  ): void {
    this.finish(scope, `control:${input.requestId}`, input, status);
  }
}

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
  constructor(
    private readonly db: Database.Database,
    initialize = true,
  ) {
    if (!initialize) return;
    db.exec(`CREATE TABLE IF NOT EXISTS codex_subagents (
      conversation_id TEXT NOT NULL, binding_revision TEXT NOT NULL, thread_id TEXT NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY(conversation_id,binding_revision,thread_id));
      CREATE TABLE IF NOT EXISTS codex_subagent_effects (
      conversation_id TEXT NOT NULL, binding_revision TEXT NOT NULL, effect_id TEXT NOT NULL,
      identity TEXT NOT NULL, result TEXT,
      PRIMARY KEY(conversation_id,binding_revision,effect_id));`);
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
        'SELECT identity,result FROM codex_subagent_effects WHERE conversation_id=? AND binding_revision=? AND effect_id=?',
      )
      .get(scope.conversationId, scope.bindingRevision, key) as
      { identity: string; result: string | null } | undefined;
    if (row && !isDeepStrictEqual(JSON.parse(row.identity), identity))
      throw Error('Effect identity changed');
    return row;
  }
  private claim(scope: SubagentScope, key: string, identity: unknown): boolean {
    if (this.effect(scope, key, identity)) return false;
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO codex_subagent_effects VALUES(?,?,?,?,NULL)')
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
    return row?.result ? JSON.parse(row.result) : undefined;
  }
  pendingTool(scope: SubagentScope, call: ChildToolIdentity): boolean {
    return this.effect(scope, `tool:${call.callId}`, call)?.result === null;
  }
  finishTool(scope: SubagentScope, call: ChildToolIdentity, result: CodexToolResult): void {
    this.finish(scope, `tool:${call.callId}`, call, result);
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

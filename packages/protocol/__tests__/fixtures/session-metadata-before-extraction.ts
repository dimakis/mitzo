// Frozen from accepted main 910b8960 before metadata extraction. Do not update to match production changes.
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { AgentLibraryVersionSchema } from '../../src/agent-library.js';
import { AgentContextSnapshotSchema } from '../../src/agent-context-recipe.js';
import { AccountBindingSchema } from '../../src/account-binding.js';
import {
  SessionRuntimeBindingSchema,
  type SessionRuntimeBinding,
} from '../../src/session-runtime-binding.js';
import { isRegisteredConversation } from '../../src/conversation-identity.js';
import type {
  SessionMeta,
  SessionSearchResult,
  AccountBinding,
  MitzoMode,
} from '../../src/types.js';

// Match conversation-identity.ts. SDK artifacts (including verified transcripts)
// are not admission evidence. Apply this predicate before pagination limits.
const LEGACY_CONVERSATION_EVIDENCE_SQL = `(
  s.is_active = 1 OR s.prompt_count > 0 OR s.num_turns > 0
  OR COALESCE(s.initial_prompt, '') != '' OR s.account_binding IS NOT NULL
  OR COALESCE(s.symposium_config, '') != ''
)`;
export const REGISTERED_CONVERSATION_SQL = `(
  s.conversation_source IN ('mitzo', 'external_import')
  OR (s.conversation_source = 'legacy' AND ${LEGACY_CONVERSATION_EVIDENCE_SQL})
) AND NOT EXISTS (
  SELECT 1 FROM internal_sdk_executions i WHERE i.sdk_session_id = s.session_id
)`;

export interface SessionRow {
  conversation_source: 'mitzo' | 'external_import' | 'legacy';
  session_type: string;
  symposium_config: string | null;
  symposium_revision: number;
  session_id: string;
  summary: string | null;
  branch: string | null;
  cwd: string | null;
  mode: string;
  is_active: number;
  is_hidden: number;
  prompt_count: number;
  manually_renamed: number;
  initial_prompt: string | null;
  sdk_transcript_verified: number;
  wt_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  num_turns: number;
  duration_ms: number;
  duration_api_ms: number;
  goal_id: string | null;
  telos_task_id: string | null;
  closed_by: string | null;
  last_speaker: string | null;
  last_speaker_at: number | null;
  state: string | null;
  last_state_change: number | null;
  execution_generation: number;
  execution_id: string | null;
  execution_phase: string | null;
  execution_terminal_reason: string | null;
  execution_updated_at: number | null;
  agent_name: string | null;
  agent_profile: string | null;
  agent_context: string | null;
  boot_context: string | null;
  account_binding: string | null;
  runtime_binding: string | null;
  selected_model: string | null;
  reasoning_effort: string | null;
  repository_workspace_id: string | null;
  created_at: number;
  updated_at: number;
}

export type SessionUpsert = Partial<
  Omit<SessionMeta, 'sessionType' | 'symposiumConfig' | 'symposiumRevision'>
> & { sessionId: string };

export interface SessionMetadataOwner {
  database(): Database.Database | null;
  statements: {
    getSession: Database.Statement;
    listSessions: Database.Statement;
    listSessionsLimited: Database.Statement;
    markInactive: Database.Statement;
    hide: Database.Statement;
    updateLastSpeaker: Database.Statement;
    getAttentionSessions: Database.Statement;
    recordUsage: Database.Statement;
  };
  assertConversationIdentity(id: string): void;
  getInternalSdkExecution(id: string): unknown;
  upsertSession(meta: SessionUpsert): void;
}

/** Borrows EventStore's connection and prepared statements. The owner retains
 * schema, migrations, backup and close; public hooks are resolved at call time. */
export class SessionMetadataBeforeExtraction {
  constructor(private readonly owner: SessionMetadataOwner) {}
  private get db() {
    return this.owner.database();
  }
  private get stmts() {
    return this.owner.statements;
  }
  /** Explicit absence is legacy; invalid/unsupported metadata always throws.
   * Kept separate from SessionMeta until a separately reviewed dispatcher exists.
   */
  getSessionRuntimeBinding(sessionId: string): SessionRuntimeBinding | null | undefined {
    this.owner.assertConversationIdentity(sessionId);
    const row = this.stmts.getSession.get(sessionId) as SessionRow | undefined;
    return row ? runtimeBindingFromRow(row) : undefined;
  }

  /** Enroll only a newly created row, atomically. An exact retry is a read and
   * never updates metadata. This API neither resolves authorization nor launches.
   */
  createSessionWithRuntimeBinding(meta: SessionUpsert, input: unknown): void {
    this.owner.assertConversationIdentity(meta.sessionId);
    if (
      ['sessionType', 'symposiumConfig', 'symposiumRevision'].some((key) =>
        Object.prototype.hasOwnProperty.call(meta, key),
      )
    )
      throw new Error('Session runtime allocation is ordinary-only');
    const binding = SessionRuntimeBindingSchema.parse(input);
    assertRuntimeAccount(binding, meta.accountBinding);
    assertRuntimeWorkspace(meta.repositoryWorkspaceId, meta.cwd);
    this.db!.transaction(() => {
      const existing = this.stmts.getSession.get(meta.sessionId) as SessionRow | undefined;
      if (existing) {
        const persisted = runtimeBindingFromRow(existing);
        if (persisted === null) throw new Error('Cannot enroll an existing legacy session');
        if (
          JSON.stringify(persisted) !== JSON.stringify(binding) ||
          existing.repository_workspace_id !== meta.repositoryWorkspaceId ||
          existing.cwd !== meta.cwd
        )
          throw new Error('Session runtime binding or workspace cannot be replaced');
        return;
      }
      if (this.db!.prepare('SELECT 1 FROM events WHERE session_id = ? LIMIT 1').get(meta.sessionId))
        throw new Error('Cannot enroll an existing historical conversation');
      this.owner.upsertSession(meta);
      this.db!.prepare('UPDATE sessions SET runtime_binding = ? WHERE session_id = ?').run(
        JSON.stringify(binding),
        meta.sessionId,
      );
    }).immediate();
  }

  upsertSession(meta: SessionUpsert): void {
    if (Object.prototype.hasOwnProperty.call(meta, 'runtimeBinding'))
      throw new Error('Runtime binding requires atomic new-session creation');
    this.owner.assertConversationIdentity(meta.sessionId);
    const existing = this.stmts.getSession.get(meta.sessionId) as SessionRow | undefined;
    const contextSnapshot =
      meta.agentContext !== undefined
        ? AgentContextSnapshotSchema.parse(meta.agentContext)
        : undefined;
    if (contextSnapshot) {
      const profile =
        meta.agentProfile ??
        (existing?.agent_profile
          ? AgentLibraryVersionSchema.parse(JSON.parse(existing.agent_profile))
          : undefined);
      const hash = (value: unknown) =>
        createHash('sha256').update(JSON.stringify(value)).digest('hex');
      if (
        !profile?.definition.contextRecipe ||
        contextSnapshot.profileId !== profile.profileId ||
        contextSnapshot.revision !== profile.revision ||
        contextSnapshot.profileHash !== profile.contentHash ||
        profile.contentHash !== hash(profile.definition) ||
        contextSnapshot.recipeHash !== hash(profile.definition.contextRecipe) ||
        contextSnapshot.source !== profile.definition.contextRecipe.source ||
        (profile.definition.contextRecipe.source === 'packs' &&
          hash(contextSnapshot.provenance?.packs) !==
            hash(profile.definition.contextRecipe.packs)) ||
        contextSnapshot.payloadHash !==
          hash(
            contextSnapshot.provenance
              ? { context: contextSnapshot.context, provenance: contextSnapshot.provenance }
              : contextSnapshot.context,
          )
      )
        throw Error('Compiled agent context does not match its profile or payload');
      if (existing?.agent_context && existing.agent_context !== JSON.stringify(contextSnapshot))
        throw Error('Agent context binding is immutable');
    }
    if (existing) {
      const runtime = runtimeBindingFromRow(existing);
      if (runtime !== null) {
        if (meta.accountBinding !== undefined) assertRuntimeAccount(runtime, meta.accountBinding);
        if (
          (meta.repositoryWorkspaceId !== undefined &&
            meta.repositoryWorkspaceId !== existing.repository_workspace_id) ||
          (meta.cwd !== undefined && meta.cwd !== existing.cwd)
        )
          throw new Error('Runtime-bound session workspace cannot be replaced or cleared');
      }
      const fields: string[] = [];
      const values: unknown[] = [];
      if (meta.repositoryWorkspaceId !== undefined) {
        if (
          existing.repository_workspace_id &&
          existing.repository_workspace_id !== meta.repositoryWorkspaceId
        )
          throw new Error('Repository conversation identity cannot be replaced');
        fields.push('repository_workspace_id = ?');
        values.push(meta.repositoryWorkspaceId);
      }
      if (meta.conversationSource !== undefined) {
        fields.push('conversation_source = ?');
        values.push(meta.conversationSource);
      }
      if (meta.summary !== undefined) {
        fields.push('summary = ?');
        values.push(meta.summary);
      }
      if (meta.branch !== undefined) {
        fields.push('branch = ?');
        values.push(meta.branch);
      }
      if (meta.cwd !== undefined) {
        fields.push('cwd = ?');
        values.push(meta.cwd);
      }
      if (meta.mode !== undefined) {
        fields.push('mode = ?');
        values.push(meta.mode);
      }
      if (meta.isActive !== undefined) {
        fields.push('is_active = ?');
        values.push(meta.isActive ? 1 : 0);
      }
      if (meta.initialPrompt !== undefined) {
        fields.push('initial_prompt = ?');
        values.push(meta.initialPrompt);
      }
      if (meta.sdkTranscriptVerified !== undefined) {
        fields.push('sdk_transcript_verified = ?');
        values.push(meta.sdkTranscriptVerified ? 1 : 0);
      }
      if (meta.goalId !== undefined) {
        fields.push('goal_id = ?');
        values.push(meta.goalId);
      }
      if (meta.telosTaskId !== undefined) {
        fields.push('telos_task_id = ?');
        values.push(meta.telosTaskId);
      }
      if (meta.wtId !== undefined) {
        fields.push('wt_id = ?');
        values.push(meta.wtId);
      }
      if (meta.closedBy !== undefined) {
        fields.push('closed_by = ?');
        values.push(meta.closedBy);
      }
      if (meta.agentName !== undefined) {
        fields.push('agent_name = ?');
        values.push(meta.agentName);
      }
      if (meta.agentProfile !== undefined) {
        const snapshot = AgentLibraryVersionSchema.parse(meta.agentProfile);
        if (existing.agent_profile && existing.agent_profile !== JSON.stringify(snapshot))
          throw Error('Agent profile binding is immutable');
        fields.push('agent_profile = ?');
        values.push(JSON.stringify(snapshot));
      }
      if (contextSnapshot) {
        fields.push('agent_context = ?');
        values.push(JSON.stringify(contextSnapshot));
      }
      if (meta.accountBinding !== undefined) {
        fields.push('account_binding = ?');
        values.push(meta.accountBinding ? JSON.stringify(meta.accountBinding) : null);
      }
      if (meta.selectedModel !== undefined) {
        fields.push('selected_model = ?');
        values.push(meta.selectedModel);
      }
      if (meta.reasoningEffort !== undefined) {
        fields.push('reasoning_effort = ?');
        values.push(meta.reasoningEffort);
      }
      if (meta.bootContext !== undefined) {
        fields.push('boot_context = ?');
        values.push(meta.bootContext);
      }
      if (meta.updatedAt !== undefined) {
        fields.push('updated_at = ?');
        values.push(meta.updatedAt);
      } else {
        fields.push("updated_at = unixepoch('now', 'subsec') * 1000");
      }
      values.push(meta.sessionId);
      this.db!.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE session_id = ?`).run(
        ...values,
      );
    } else {
      const cols = [
        'session_id',
        'conversation_source',
        'summary',
        'branch',
        'cwd',
        'mode',
        'is_active',
        'initial_prompt',
        'sdk_transcript_verified',
        'wt_id',
        'goal_id',
        'telos_task_id',
        'closed_by',
        'agent_name',
        'agent_profile',
        'agent_context',
        'boot_context',
        'account_binding',
        'selected_model',
        'reasoning_effort',
        'repository_workspace_id',
      ];
      const vals: unknown[] = [
        meta.sessionId,
        meta.conversationSource ?? 'mitzo',
        meta.summary ?? null,
        meta.branch ?? null,
        meta.cwd ?? null,
        meta.mode ?? 'agent',
        meta.isActive === false ? 0 : 1,
        meta.initialPrompt ?? null,
        meta.sdkTranscriptVerified ? 1 : 0,
        meta.wtId ?? null,
        meta.goalId ?? null,
        meta.telosTaskId ?? null,
        meta.closedBy ?? null,
        meta.agentName ?? null,
        meta.agentProfile
          ? JSON.stringify(AgentLibraryVersionSchema.parse(meta.agentProfile))
          : null,
        contextSnapshot ? JSON.stringify(contextSnapshot) : null,
        meta.bootContext ?? null,
        meta.accountBinding ? JSON.stringify(meta.accountBinding) : null,
        meta.selectedModel ?? null,
        meta.reasoningEffort ?? null,
        meta.repositoryWorkspaceId ?? null,
      ];
      if (meta.updatedAt !== undefined) {
        cols.push('updated_at');
        vals.push(meta.updatedAt);
      }
      if (meta.createdAt !== undefined) {
        cols.push('created_at');
        vals.push(meta.createdAt);
      }
      const placeholders = cols.map(() => '?').join(', ');
      this.db!.prepare(`INSERT INTO sessions (${cols.join(', ')}) VALUES (${placeholders})`).run(
        ...vals,
      );
    }
  }

  getSession(sessionId: string): SessionMeta | null {
    if (this.owner.getInternalSdkExecution(sessionId)) return null;
    const row = this.stmts.getSession.get(sessionId) as SessionRow | undefined;
    const meta = row ? rowToSession(row) : null;
    return isRegisteredConversation(meta) ? meta : null;
  }

  isSessionHidden(sessionId: string): boolean {
    const row = this.stmts.getSession.get(sessionId) as SessionRow | undefined;
    return row?.is_hidden === 1;
  }

  /**
   * Return the subset of `sessionIds` that already exist in the sessions table.
   * Batches into chunks of 500 to stay within SQLite's SQLITE_MAX_VARIABLE_NUMBER.
   */
  getKnownSessionIds(sessionIds: string[]): Set<string> {
    if (sessionIds.length === 0) return new Set();
    const CHUNK = 500;
    const result = new Set<string>();
    for (let i = 0; i < sessionIds.length; i += CHUNK) {
      const chunk = sessionIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db!.prepare(
        `SELECT s.session_id FROM sessions s WHERE s.session_id IN (${placeholders})
         AND ${REGISTERED_CONVERSATION_SQL}`,
      ).all(...chunk) as Array<{ session_id: string }>;
      for (const r of rows) result.add(r.session_id);
    }
    return result;
  }

  listSessions(limit?: number): SessionMeta[] {
    const rows = (
      limit == null ? this.stmts.listSessions.all() : this.stmts.listSessionsLimited.all(limit)
    ) as SessionRow[];
    return rows.map(rowToSession);
  }

  /**
   * Search saved conversation titles, user messages and assistant text deltas.
   * Prefer a matching message snippet when the title also matches.
   */
  searchSessions(query: string, limit = 20): SessionSearchResult[] {
    if (!query.trim()) return [];
    const escaped = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `%${escaped}%`;
    const rows = this.db!.prepare(
      `WITH candidates AS (SELECT
        e.session_id,
        s.summary,
        e.payload,
        e.created_at AS matched_at,
        e.seq AS matched_seq,
        s.updated_at,
        1 AS content_match
      FROM events e
      JOIN sessions s ON s.session_id = e.session_id
      WHERE s.is_hidden = 0
        AND ${REGISTERED_CONVERSATION_SQL}
        AND e.type IN ('user_message', 'block_delta')
        AND (
          json_extract(e.payload, '$.text') LIKE ? ESCAPE '\\'
          OR json_extract(e.payload, '$.delta') LIKE ? ESCAPE '\\'
        )
      UNION ALL
      SELECT s.session_id, s.summary, json_object('text', s.summary),
        s.updated_at AS matched_at, 0 AS matched_seq, s.updated_at, 0 AS content_match
      FROM sessions s
      WHERE s.is_hidden = 0 AND ${REGISTERED_CONVERSATION_SQL}
        AND s.summary LIKE ? ESCAPE '\\'
      ), matches AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY session_id ORDER BY content_match DESC, matched_at DESC, matched_seq DESC
        ) AS match_rank FROM candidates
      ) SELECT * FROM matches WHERE match_rank = 1
      ORDER BY matched_at DESC, matched_seq DESC LIMIT ?`,
    ).all(pattern, pattern, pattern, limit) as Array<{
      session_id: string;
      summary: string | null;
      payload: string;
      matched_at: number;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      sessionId: row.session_id,
      summary: row.summary,
      snippet: extractSnippet(row.payload, query),
      matchedAt: row.matched_at,
      updatedAt: row.updated_at,
    }));
  }

  markSessionInactive(sessionId: string): void {
    this.stmts.markInactive.run(sessionId);
  }

  hideSession(sessionId: string): void {
    this.stmts.hide.run(sessionId);
  }

  incrementPromptCount(sessionId: string): number {
    this.owner.assertConversationIdentity(sessionId);
    const row = this.stmts.getSession.get(sessionId) as SessionRow | undefined;
    const existing = row ? rowToSession(row) : null;
    if (!existing) {
      this.db!.prepare(
        "INSERT INTO sessions (session_id, conversation_source, prompt_count) VALUES (?, 'mitzo', 1)",
      ).run(sessionId);
      return 1;
    }
    this.db!.prepare(
      "UPDATE sessions SET prompt_count = prompt_count + 1, conversation_source = CASE WHEN conversation_source = 'legacy' THEN 'mitzo' ELSE conversation_source END, updated_at = unixepoch('now', 'subsec') * 1000 WHERE session_id = ?",
    ).run(sessionId);
    return existing.promptCount + 1;
  }

  markManuallyRenamed(sessionId: string): void {
    this.db!.prepare(
      "UPDATE sessions SET manually_renamed = 1, updated_at = unixepoch('now', 'subsec') * 1000 WHERE session_id = ?",
    ).run(sessionId);
  }

  updateLastSpeaker(sessionId: string, speaker: 'user' | 'assistant'): void {
    this.stmts.updateLastSpeaker.run(speaker, sessionId);
  }

  getAttentionSessions(): SessionMeta[] {
    const rows = this.stmts.getAttentionSessions.all();
    return (rows as SessionRow[]).map(rowToSession);
  }

  recordUsage(
    sessionId: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      totalCostUsd: number;
      numTurns: number;
      durationMs: number;
      durationApiMs: number;
    },
  ): void {
    this.stmts.recordUsage.run(
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheCreationTokens,
      usage.totalCostUsd,
      usage.numTurns,
      usage.durationMs,
      usage.durationApiMs,
      sessionId,
    );
  }
}

/** Extract a text snippet around the query match from a JSON payload string. */
function extractSnippet(payloadStr: string, query: string, contextChars = 80): string {
  // Try to pull the text/delta field from the payload
  let text: string;
  try {
    const payload = JSON.parse(payloadStr);
    text = (payload.text ?? payload.delta ?? '') as string;
  } catch {
    text = payloadStr;
  }
  if (!text) return '';

  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, contextChars * 2);

  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + query.length + contextChars);
  let snippet = text.slice(start, end).trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  return snippet;
}

export function rowToSession(row: SessionRow): SessionMeta {
  return {
    ...(row.repository_workspace_id ? { repositoryWorkspaceId: row.repository_workspace_id } : {}),
    sessionId: row.session_id,
    conversationSource: row.conversation_source,
    summary: row.summary,
    branch: row.branch,
    cwd: row.cwd,
    mode: row.mode as MitzoMode,
    isActive: row.is_active === 1,
    isHidden: row.is_hidden === 1,
    promptCount: row.prompt_count ?? 0,
    manuallyRenamed: (row.manually_renamed ?? 0) === 1,
    initialPrompt: row.initial_prompt ?? null,
    sdkTranscriptVerified: row.sdk_transcript_verified === 1,
    wtId: row.wt_id ?? null,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheCreationTokens: row.cache_creation_tokens ?? 0,
    totalCostUsd: row.total_cost_usd ?? 0,
    numTurns: row.num_turns ?? 0,
    durationMs: row.duration_ms ?? 0,
    durationApiMs: row.duration_api_ms ?? 0,
    goalId: row.goal_id ?? null,
    telosTaskId: row.telos_task_id ?? null,
    closedBy: (row.closed_by as SessionMeta['closedBy']) ?? null,
    lastSpeaker: (row.last_speaker as SessionMeta['lastSpeaker']) ?? null,
    lastSpeakerAt: row.last_speaker_at ?? null,
    state: (row.state as SessionMeta['state']) ?? null,
    lastStateChange: row.last_state_change ?? null,
    executionGeneration: row.execution_generation ?? 0,
    executionId: row.execution_id ?? null,
    executionPhase: (row.execution_phase as SessionMeta['executionPhase']) ?? null,
    executionTerminalReason:
      (row.execution_terminal_reason as SessionMeta['executionTerminalReason']) ?? null,
    executionUpdatedAt: row.execution_updated_at ?? null,
    agentName: row.agent_name ?? null,
    ...(row.agent_profile
      ? { agentProfile: AgentLibraryVersionSchema.parse(JSON.parse(row.agent_profile)) }
      : {}),
    ...(row.agent_context
      ? { agentContext: AgentContextSnapshotSchema.parse(JSON.parse(row.agent_context)) }
      : {}),
    bootContext: row.boot_context ?? null,
    accountBinding: parseAccountBinding(row.account_binding),
    selectedModel: row.selected_model ?? null,
    reasoningEffort: row.reasoning_effort ?? null,
    sessionType: row.session_type === 'symposium' ? 'symposium' : 'chat',
    symposiumConfig: row.symposium_config ?? null,
    symposiumRevision: row.symposium_revision ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseAccountBinding(raw: string | null): AccountBinding | null {
  if (raw === null || raw === undefined) return null;
  try {
    const binding = AccountBindingSchema.safeParse(JSON.parse(raw));
    if (binding.success) return binding.data;
  } catch {
    /* Preserve a failed binding, never silently downgrade to the legacy route. */
  }
  return {
    accountId: 'unavailable',
    accountLabel: 'Unavailable account binding',
    provider: 'unavailable',
    model: 'unavailable',
    profileRevision: 'invalid',
  };
}

function assertRuntimeAccount(binding: SessionRuntimeBinding, input: unknown): void {
  const account = AccountBindingSchema.parse(input);
  if (
    account.accountId !== binding.account.accountId ||
    account.provider !== binding.account.provider ||
    account.profileRevision !== binding.account.profileRevision
  )
    throw new Error('Session runtime account identity does not match account binding');
}

function assertRuntimeWorkspace(workspaceId: unknown, cwd: unknown): void {
  if (
    typeof workspaceId !== 'string' ||
    !workspaceId.trim() ||
    typeof cwd !== 'string' ||
    !cwd.trim()
  )
    throw new Error('Session runtime requires existing workspace identity and cwd metadata');
}

function runtimeBindingFromRow(row: SessionRow): SessionRuntimeBinding | null {
  if (row.runtime_binding === null) return null;
  try {
    if (
      row.session_type !== 'chat' ||
      row.symposium_config !== null ||
      row.symposium_revision !== 0
    )
      throw new Error('Runtime binding requires an ordinary session without Symposium state');
    const binding = SessionRuntimeBindingSchema.parse(JSON.parse(row.runtime_binding));
    assertRuntimeAccount(binding, JSON.parse(row.account_binding ?? 'null'));
    assertRuntimeWorkspace(row.repository_workspace_id, row.cwd);
    return binding;
  } catch (error) {
    throw new Error('Invalid or unsupported session runtime binding', { cause: error });
  }
}

import type { CodexNativeExecutionPolicy } from './codex-native-execution-policy.js';
import type { SandboxOwnershipEvidence } from './sandbox-ownership-review.js';
import {
  OpenShellCodexCustodySchema,
  type OpenShellCodexCustody,
} from './openshell-codex-custody.js';
import type { RuntimeMigration } from './openshell-runtime-migration.js';
import {
  HostCodexCustodySchema,
  HostCodexCompanionUpgradePlanSchema,
  type HostCodexCustody,
} from './host-codex-custody.js';
import { FrozenHostCodexExecutable } from './frozen-host-codex-executable.js';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { chmodSync, closeSync, openSync, lstatSync } from 'node:fs';
import type { AccountBinding } from '@mitzo/protocol';
import { AgentSandboxContextScopeSchema } from '@mitzo/protocol';
import { z } from 'zod';
const HostBundleUpgrade = z.strictObject({
  version: z.literal(1),
  custody: HostCodexCustodySchema,
  plan: HostCodexCompanionUpgradePlanSchema,
});
import type { OpenShellRuntime, OpenShellAccountRoute } from './openshell-runtime.js';
import { validateOpenShellCliEnvironment } from './openshell-cli-environment.js';
import type { PersistedWebSearchGrant, WebSearchGrant } from './web-search-policy.js';
import {
  normalizeCodexToolResult,
  MAX_CODEX_RICH_RESULT_BYTES,
  type CodexToolResult,
} from './codex-tool-result.js';

export interface ArtifactRuntime {
  runtime: OpenShellRuntime & { sandboxId: string };
  route: OpenShellAccountRoute;
}
export function sameArtifactRuntimeIdentity(
  left: ArtifactRuntime | null,
  right: ArtifactRuntime,
): boolean {
  if (!left) return false;
  const stable = (value: ArtifactRuntime) => {
    const runtime = { ...value.runtime };
    delete runtime.created;
    delete runtime.resourceVersion;
    return { runtime, route: value.route };
  };
  return isDeepStrictEqual(stable(left), stable(right));
}
const RuntimeString = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\r\n\0]+$/);
const ArtifactRuntimeSchema = z
  .object({
    runtime: z
      .object({
        sandboxName: RuntimeString,
        sandboxId: RuntimeString,
        resourceVersion: RuntimeString.optional(),
        created: z.boolean().optional(),
        workdir: RuntimeString.refine(
          (value) => value.startsWith('/'),
          'Invalid sandbox workspace',
        ),
        appServerCommand: z.enum([
          '/sandbox/run-mitzo-app-server',
          '/sandbox/run-mitzo-subscription-app-server',
          '/usr/local/bin/symposium-subscription-app-server',
        ]),
        cli: RuntimeString,
        gateway: RuntimeString,
        workspace: RuntimeString,
        gatewayEndpoint: RuntimeString.optional(),
        gatewayInsecure: z.boolean(),
        cliEnvironment: z
          .record(z.string(), z.string())
          .transform(validateOpenShellCliEnvironment)
          .optional(),
      })
      .strict(),
    route: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('api'), provider: RuntimeString, model: RuntimeString }).strict(),
      z
        .object({
          kind: z.literal('chatgpt-subscription-native'),
          provider: RuntimeString,
          providerType: z.literal('codex'),
          providerId: RuntimeString,
          model: RuntimeString,
        })
        .strict(),
      z
        .object({
          kind: z.literal('chatgpt-subscription'),
          provider: RuntimeString,
          providerType: z.literal('openai-codex-oauth'),
          providerId: RuntimeString,
          grantId: RuntimeString,
          model: RuntimeString,
        })
        .strict(),
    ]),
  })
  .strict();

const KnowledgeAdoption = z
  .object({
    storeId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    contextSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sandboxId: RuntimeString,
    knowledgeRoot: z
      .string()
      .regex(/^\/sandbox\/workspaces\/knowledge\/knowledge-[a-f0-9]{64}\/mgmt$/),
    // Configured compatibility contract, not an observed retained-sandbox image digest.
    runtimeContractImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    compilerSha256: z.string().regex(/^[a-f0-9]{64}$/),
    recipeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type KnowledgeAdoptionSelection = z.infer<typeof KnowledgeAdoption>;
const AgentContextAdoption = z.strictObject({
  profileId: RuntimeString,
  revision: z.number().int().positive(),
  profileHash: z.string().regex(/^[a-f0-9]{64}$/),
  recipeHash: z.string().regex(/^[a-f0-9]{64}$/),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  contextSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sandbox: AgentSandboxContextScopeSchema.safeExtend({
    effectiveRecipeHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
export type AgentContextAdoptionSelection = z.infer<typeof AgentContextAdoption>;

const CommandInput = z
  .object({
    id: z.string().min(1).max(200),
    prompt: z.string().min(1).max(1_000_000),
    // Raw user-authored intent is retained separately from the provider prompt,
    // which may contain context files or rendered skill instructions.
    intent: z.string().max(1_000_000).optional(),
    model: z.string().min(1).optional(),
    reasoningEffort: z.string().min(1).max(32).nullable().optional(),
    images: z
      .array(
        z
          .object({
            data: z
              .string()
              .min(1)
              .max(14_000_000)
              .regex(/^[A-Za-z0-9+/]*={0,2}$/),
            mediaType: z
              .string()
              .refine(
                (value) => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value),
                'Unsupported image type',
              ),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    allowedTools: z.array(z.string()).optional(),
    environmentContinuation: z
      .object({
        sourceCommandId: z.string().min(1),
        sourceTurnId: z.string().min(1),
        sourceThreadId: z.string().min(1),
        sourceGeneration: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
const WebSearchGrantSchema = z.enum(['unresolved', 'denied', 'allowed']);
export type CodexCommandInput = z.infer<typeof CommandInput>;
export type CodexCommand = CodexCommandInput & {
  status: 'queued' | 'running' | 'completed' | 'interrupted' | 'failed' | 'cancelled';
  attempt: number;
};
export const CodexNativeTurnTargetSchema = z.strictObject({
  commandId: z.string().min(1).max(200),
  attempt: z.number().int().positive().safe(),
  threadId: RuntimeString,
  turnId: RuntimeString,
  generation: z.number().int().nonnegative().safe(),
});
export type CodexNativeTurnTarget = z.infer<typeof CodexNativeTurnTargetSchema>;
const CompletedPreparedRepositorySourceSchema = CodexNativeTurnTargetSchema.extend({
  callId: z.string().min(1).max(200),
  toolName: z.literal('PrepareLocalRepository'),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
/** Historical correlation only; current operator, read and custody authority
 * must be supplied separately at the completed-turn admission barrier. */
export type CompletedPreparedRepositorySource = z.infer<
  typeof CompletedPreparedRepositorySourceSchema
>;
export function preparedRepositoryResultSha256(result: CodexToolResult): string {
  const checked = normalizeCodexToolResult(result);
  // Match recordToolResult/replayToolResult's durable public projection exactly.
  // Private executor metadata is deliberately not part of the retained result.
  const durable = {
    content: checked.content,
    isError: checked.isError,
    ...(checked.contentItems ? { contentItems: checked.contentItems } : {}),
  };
  return createHash('sha256').update(JSON.stringify(durable)).digest('hex');
}
const NativeTurnHistorySchema = z
  .array(
    CodexNativeTurnTargetSchema.omit({ commandId: true }).extend({
      interruptRequestId: z.string().min(1).max(200).optional(),
    }),
  )
  .max(1000);
const NativePolicyPath = RuntimeString.refine((path) => isAbsolute(path) && resolve(path) === path);
const NativePolicyRoots = z
  .array(NativePolicyPath)
  .max(256)
  .refine(
    (paths) => isDeepStrictEqual(paths, [...new Set(paths)].sort()),
    'Native policy roots are not canonical',
  );
const NativeExecutionPolicySnapshotSchema = z
  .strictObject({
    version: z.literal('native-mac-permissions-v1'),
    bindingRevision: RuntimeString,
    policyRevision: z.string().regex(/^[a-f0-9]{64}$/),
    profileRevision: z.string().regex(/^[a-f0-9]{64}$/),
    enforcement: z.literal('configured'),
    scopeKind: z.literal('base-profile'),
    grantState: z.literal('upstream-owned'),
    cwd: NativePolicyPath,
    readableRoots: NativePolicyRoots,
    writableRoots: NativePolicyRoots,
    workspaceRoots: NativePolicyRoots,
    deniedRoots: NativePolicyRoots,
    writeProtectedRoots: NativePolicyRoots,
    networkAccess: z.literal('restricted'),
    approvalPolicy: z.literal('on-request'),
    permissions: z.enum(['mitzo-native-ask', 'mitzo-native-agent']),
    reviewer: z.literal('user'),
    reviewerAvailability: z.literal('unqualified'),
  })
  .superRefine((policy, context) => {
    const digest = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const profileRevision = digest([
      policy.bindingRevision,
      policy.readableRoots,
      policy.deniedRoots,
      policy.writeProtectedRoots,
    ]);
    const policyRevision = digest([
      profileRevision,
      policy.cwd,
      policy.workspaceRoots,
      policy.permissions,
    ]);
    if (
      policy.profileRevision !== profileRevision ||
      policy.policyRevision !== policyRevision ||
      !isDeepStrictEqual(
        policy.writableRoots,
        policy.permissions === 'mitzo-native-ask' ? [] : policy.workspaceRoots,
      )
    )
      context.addIssue({ code: 'custom', message: 'Native policy snapshot revision changed' });
  });
const NativeExecutionReceiptBase = z.strictObject({
  version: z.literal(1),
  attempt: z.number().int().positive().safe(),
  threadId: RuntimeString,
  generation: z.number().int().nonnegative().safe(),
  policy: NativeExecutionPolicySnapshotSchema,
  preparedAt: z.number().int().nonnegative().safe(),
  replacement: z
    .strictObject({
      parentThreadId: RuntimeString.nullable(),
      parentGeneration: z.number().int().nonnegative().safe(),
    })
    .optional(),
});
const NativeExecutionReceiptSchema = z.discriminatedUnion('phase', [
  NativeExecutionReceiptBase.extend({ phase: z.literal('prepared') }),
  NativeExecutionReceiptBase.extend({
    phase: z.literal('accepted'),
    turnId: RuntimeString,
    acceptedAt: z.number().int().nonnegative().safe(),
  }),
]);
const NativeExecutionHistorySchema = z
  .array(NativeExecutionReceiptSchema)
  .max(100)
  .refine(
    (history) =>
      new Set(history.map((receipt) => receipt.attempt)).size === history.length &&
      history.every(
        (receipt, index) => index === 0 || history[index - 1].attempt < receipt.attempt,
      ),
    'Native execution attempts are ambiguous',
  );
export type CodexNativeExecutionReceipt = z.infer<typeof NativeExecutionReceiptSchema>;

export interface CodexTargetedInterruptReceipt {
  requestId: string;
  target: CodexNativeTurnTarget;
  /** A one-way local cancellation claim, never a provider or terminal receipt. */
  disposition: 'claimed';
}

/**
 * `intent` was added after command rows were already durable. Compare it for
 * modern rows, but omit it from both sides when a historical row truly lacks
 * the field. Its old provider prompt may be rendered/context-expanded, so it
 * cannot reconstruct raw intent safely. Do not rewrite the row: a missing
 * historical intent must still remain conservative at turn preflight.
 */
function idempotencyInput(input: CodexCommandInput, includeIntent: boolean): string {
  return JSON.stringify({
    id: input.id,
    prompt: input.prompt,
    ...(includeIntent ? { intent: input.intent } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.images !== undefined ? { images: input.images } : {}),
    ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
    ...(input.environmentContinuation
      ? { environmentContinuation: input.environmentContinuation }
      : {}),
  });
}

const CapacityRecoverySchema = z
  .object({
    revision: z.number().int().nonnegative(),
    id: z.string().uuid(),
    sourceCommandId: z.string().min(1),
    status: z.enum(['waiting', 'queued', 'running', 'exhausted', 'stopped']),
    attempts: z.number().int().min(0).max(5),
    maxAttempts: z.literal(5),
    nextRetryAt: z.number().int().optional(),
    latestCommandId: z.string().min(1),
    latestAttempt: z.number().int().positive(),
    latestTurnId: z.string().min(1),
    threadId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    model: z.string().min(1),
    reasoningEffort: z.string().nullable().optional(),
    toolSurfaceRevision: z.string().nullable(),
    webSearchRevision: z.number().int(),
    artifactIdentity: z.string(),
    childCommandId: z.string().optional(),
    supersedingCommandId: z.string().optional(),
  })
  .strict();
export type CapacityRecovery = z.infer<typeof CapacityRecoverySchema>;
interface CapacityContinuation {
  sourceCommandId: string;
  recoveryId: string;
  ordinal: number;
  threadId: string;
  turnId: string | null;
  dispatched: number;
  terminal: string | null;
}

interface Conversation {
  conversationId: string;
  cwd: string;
  threadId: string | null;
  threadGeneration: number;
  lastCompletedTurnId: string | null;
  recovery: number;
  recoveryStrategy: 'resume' | 'fork';
  webSearchGrant: WebSearchGrant;
  webSearchGrantRevision: number;
  webSearchGrantUpdatedAt: number | null;
  toolSurfaceRevision: string | null;
  rolloverContext: string | null;
}
/** Private server-owned database. A single owning server calls recoverAtStartup before accepting work. */
export class CodexConversationStore {
  private db: Database.Database;
  constructor(
    path: string,
    private readonly ownership: { requireOwner?: boolean } = {},
  ) {
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
    this.db = new Database(path);
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS codex_runtime_migrations (conversation_id TEXT PRIMARY KEY, binding TEXT NOT NULL, generation INTEGER NOT NULL, data TEXT NOT NULL)',
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS codex_conversations (
      id TEXT PRIMARY KEY, binding TEXT NOT NULL, cwd TEXT NOT NULL, thread_id TEXT,
      thread_generation INTEGER NOT NULL DEFAULT 0,
      recovery INTEGER NOT NULL DEFAULT 0,
      recovery_strategy TEXT NOT NULL DEFAULT 'resume',
      web_search_grant TEXT NOT NULL DEFAULT 'unresolved',
      web_search_grant_revision INTEGER NOT NULL DEFAULT 0,
      web_search_grant_updated_at INTEGER,
      tool_surface_revision TEXT,
      rollover_context TEXT);
      CREATE TABLE IF NOT EXISTS codex_commands (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES codex_conversations(id),
        id TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL,
        recovery_acknowledged INTEGER NOT NULL DEFAULT 0, retry_not_before INTEGER,
        retryable INTEGER, ambiguous INTEGER, attempt INTEGER NOT NULL DEFAULT 1, native_turns TEXT, native_execution_history TEXT,
        UNIQUE(conversation_id,id));
      CREATE TABLE IF NOT EXISTS codex_tools (
        conversation_id TEXT NOT NULL, command_id TEXT NOT NULL, call_id TEXT NOT NULL,
        turn_id TEXT, tool_name TEXT, request_hash TEXT, result_content TEXT, result_is_error INTEGER, result_content_items TEXT,
        PRIMARY KEY(conversation_id,call_id),
        FOREIGN KEY(conversation_id,command_id) REFERENCES codex_commands(conversation_id,id));
      CREATE INDEX IF NOT EXISTS codex_commands_queue_status ON codex_commands(conversation_id,status,sequence);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS codex_thread_acceptances (
      conversation_id TEXT NOT NULL REFERENCES codex_conversations(id),
      command_id TEXT NOT NULL, attempt INTEGER NOT NULL,
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, generation INTEGER NOT NULL,
      ownership_pending INTEGER NOT NULL, accepted_at INTEGER NOT NULL, terminal_conflict INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(conversation_id,command_id,attempt));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS codex_pending_thread_dispatches (
      conversation_id TEXT PRIMARY KEY REFERENCES codex_conversations(id),
      parent_thread_id TEXT, thread_id TEXT NOT NULL,
      command_id TEXT NOT NULL, attempt INTEGER NOT NULL, parent_generation INTEGER);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS codex_startup_reservations (
      conversation_id TEXT PRIMARY KEY REFERENCES codex_conversations(id),
      phase TEXT NOT NULL CHECK(phase IN ('provisioning','provider_initializing')));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS codex_knowledge_adoptions (
      conversation_id TEXT NOT NULL, command_id TEXT NOT NULL,
      attempt INTEGER NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      selection TEXT NOT NULL, accepted_at INTEGER NOT NULL,
      PRIMARY KEY(conversation_id, command_id, attempt),
      FOREIGN KEY(conversation_id, command_id) REFERENCES codex_commands(conversation_id,id));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS codex_agent_context_adoptions (
      conversation_id TEXT NOT NULL, command_id TEXT NOT NULL,
      attempt INTEGER NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      selection TEXT NOT NULL, accepted_at INTEGER NOT NULL,
      PRIMARY KEY(conversation_id, command_id, attempt),
      FOREIGN KEY(conversation_id, command_id) REFERENCES codex_commands(conversation_id,id));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS codex_capacity_native_acks (
      conversation_id TEXT NOT NULL REFERENCES codex_conversations(id),command_id TEXT NOT NULL,attempt INTEGER NOT NULL,
      thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,generation INTEGER NOT NULL,accepted_at INTEGER NOT NULL,
      PRIMARY KEY(conversation_id,command_id,attempt),FOREIGN KEY(conversation_id,command_id) REFERENCES codex_commands(conversation_id,id));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS codex_capacity_recoveries (
      conversation_id TEXT PRIMARY KEY REFERENCES codex_conversations(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codex_capacity_continuations (
      conversation_id TEXT NOT NULL REFERENCES codex_conversations(id),command_id TEXT NOT NULL,
      source_command_id TEXT NOT NULL,recovery_id TEXT NOT NULL,ordinal INTEGER NOT NULL,
      thread_id TEXT NOT NULL,turn_id TEXT,dispatched INTEGER NOT NULL,terminal TEXT,
      PRIMARY KEY(conversation_id,command_id),FOREIGN KEY(conversation_id,command_id) REFERENCES codex_commands(conversation_id,id));`);
    this.db.transaction(() => {
      const toolColumns = this.db.prepare('PRAGMA table_info(codex_tools)').all() as Array<{
        name: string;
      }>;
      for (const [name, type] of [
        ['turn_id', 'TEXT'],
        ['tool_name', 'TEXT'],
        ['request_hash', 'TEXT'],
        ['result_content', 'TEXT'],
        ['result_is_error', 'INTEGER'],
        ['result_content_items', 'TEXT'],
      ] as const)
        if (!toolColumns.some((column) => column.name === name))
          this.db.exec(`ALTER TABLE codex_tools ADD COLUMN ${name} ${type}`);
      const conversationColumns = this.db
        .prepare('PRAGMA table_info(codex_conversations)')
        .all() as Array<{ name: string }>;
      if (!conversationColumns.some((column) => column.name === 'openshell_custody'))
        this.db.exec('ALTER TABLE codex_conversations ADD COLUMN openshell_custody TEXT');
      if (!conversationColumns.some((column) => column.name === 'host_custody'))
        this.db.exec('ALTER TABLE codex_conversations ADD COLUMN host_custody TEXT');
      if (!conversationColumns.some((column) => column.name === 'host_bundle_upgrade'))
        this.db.exec('ALTER TABLE codex_conversations ADD COLUMN host_bundle_upgrade TEXT');
      if (!conversationColumns.some((column) => column.name === 'artifact_runtime'))
        this.db.exec('ALTER TABLE codex_conversations ADD COLUMN artifact_runtime TEXT');
      if (!conversationColumns.some((column) => column.name === 'owner_kind'))
        this.db.exec(
          "ALTER TABLE codex_conversations ADD COLUMN owner_kind TEXT CHECK(owner_kind IN ('ordinary','symposium'))",
        );
      if (!conversationColumns.some((column) => column.name === 'thread_generation'))
        this.db.exec(
          'ALTER TABLE codex_conversations ADD COLUMN thread_generation INTEGER NOT NULL DEFAULT 0',
        );
      if (!conversationColumns.some((column) => column.name === 'automatic_recovery'))
        this.db.exec(
          'ALTER TABLE codex_conversations ADD COLUMN automatic_recovery INTEGER NOT NULL DEFAULT 0',
        );
      const addsRecoveryStrategy = !conversationColumns.some(
        (column) => column.name === 'recovery_strategy',
      );
      if (addsRecoveryStrategy)
        this.db.exec(
          "ALTER TABLE codex_conversations ADD COLUMN recovery_strategy TEXT NOT NULL DEFAULT 'resume'",
        );
      if (!conversationColumns.some((column) => column.name === 'web_search_grant'))
        this.db.exec(
          "ALTER TABLE codex_conversations ADD COLUMN web_search_grant TEXT NOT NULL DEFAULT 'unresolved'",
        );
      if (!conversationColumns.some((column) => column.name === 'web_search_grant_revision'))
        this.db.exec(
          'ALTER TABLE codex_conversations ADD COLUMN web_search_grant_revision INTEGER NOT NULL DEFAULT 0',
        );
      if (!conversationColumns.some((column) => column.name === 'web_search_grant_updated_at'))
        this.db.exec(
          'ALTER TABLE codex_conversations ADD COLUMN web_search_grant_updated_at INTEGER',
        );
      if (!conversationColumns.some((column) => column.name === 'tool_surface_revision'))
        this.db.exec('ALTER TABLE codex_conversations ADD COLUMN tool_surface_revision TEXT');
      if (!conversationColumns.some((column) => column.name === 'rollover_context'))
        this.db.exec('ALTER TABLE codex_conversations ADD COLUMN rollover_context TEXT');
      this.db.exec(`CREATE TABLE IF NOT EXISTS codex_thread_generations (
        conversation_id TEXT NOT NULL REFERENCES codex_conversations(id),
        generation INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        parent_thread_id TEXT,
        reason TEXT NOT NULL,
        last_completed_turn_id TEXT,
        created_at INTEGER NOT NULL,
        retired_at INTEGER,
        PRIMARY KEY(conversation_id,generation),
        UNIQUE(conversation_id,thread_id));
        INSERT OR IGNORE INTO codex_thread_generations(
          conversation_id,generation,thread_id,parent_thread_id,reason,created_at)
        SELECT id,thread_generation,thread_id,NULL,'legacy',unixepoch('now') * 1000
        FROM codex_conversations WHERE thread_id IS NOT NULL;`);
      const columns = this.db.prepare('PRAGMA table_info(codex_commands)').all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === 'recovery_acknowledged')) {
        this.db.exec(
          'ALTER TABLE codex_commands ADD COLUMN recovery_acknowledged INTEGER NOT NULL DEFAULT 0',
        );
        // Before this column existed, a cleared conversation recovery flag was
        // the only durable evidence that its interrupted work was acknowledged.
        // Keep recovery=1 rows conservative because their individual history is
        // ambiguous until the user acknowledges it after this upgrade.
        this.db.exec(`UPDATE codex_commands
          SET recovery_acknowledged=1
          WHERE status IN ('interrupted','failed')
            AND conversation_id IN (SELECT id FROM codex_conversations WHERE recovery=0)`);
      }
      if (!columns.some((column) => column.name === 'retry_not_before'))
        this.db.exec('ALTER TABLE codex_commands ADD COLUMN retry_not_before INTEGER');
      if (!columns.some((column) => column.name === 'retryable'))
        this.db.exec('ALTER TABLE codex_commands ADD COLUMN retryable INTEGER');
      if (!columns.some((column) => column.name === 'ambiguous'))
        this.db.exec('ALTER TABLE codex_commands ADD COLUMN ambiguous INTEGER');
      if (!columns.some((column) => column.name === 'attempt'))
        this.db.exec('ALTER TABLE codex_commands ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1');
      if (!columns.some((column) => column.name === 'native_turns'))
        this.db.exec('ALTER TABLE codex_commands ADD COLUMN native_turns TEXT');
      if (!columns.some((column) => column.name === 'native_execution_history'))
        this.db.exec('ALTER TABLE codex_commands ADD COLUMN native_execution_history TEXT');
      const pendingColumns = this.db
        .prepare('PRAGMA table_info(codex_pending_thread_dispatches)')
        .all() as Array<{ name: string }>;
      if (!pendingColumns.some((column) => column.name === 'parent_generation'))
        this.db.exec(
          'ALTER TABLE codex_pending_thread_dispatches ADD COLUMN parent_generation INTEGER',
        );
      // Legacy recovery rows could not persist a failure class. A failed (not
      // merely interrupted) active command is the conservative signal that the
      // provider thread, rather than only its process transport, needs a new
      // generation before more user intent is admitted.
      if (addsRecoveryStrategy)
        this.db.exec(`UPDATE codex_conversations SET recovery_strategy='fork'
          WHERE recovery=1 AND id IN (
            SELECT conversation_id FROM codex_commands
            WHERE status='failed' AND recovery_acknowledged=0
          )`);
    })();
  }
  private key(b: AccountBinding) {
    return JSON.stringify([b.accountId, b.provider, b.model, b.profileRevision]);
  }
  /** Presence is metadata only; callers still need exact native account/custody. */
  hasConversation(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM codex_conversations WHERE id=?').get(id));
  }
  /** Existing native ACK history also covers workers started before dispatch
   * boundary events were added. Queue/claim/thread creation alone prove no turn. */
  hasAcceptedProviderTurn(id: string, binding: AccountBinding): boolean {
    if (!this.hasConversation(id)) return false;
    this.read(id, binding);
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM codex_capacity_native_acks WHERE conversation_id=? LIMIT 1')
        .get(id),
    );
  }
  acceptedProviderTurnForCommand(
    id: string,
    binding: AccountBinding,
    commandId: string,
    expectedPrompt?: string,
  ) {
    this.read(id, binding);
    return this.db
      .prepare(
        `SELECT a.thread_id AS threadId,a.turn_id AS turnId FROM codex_capacity_native_acks a
         JOIN codex_commands c ON c.conversation_id=a.conversation_id AND c.id=a.command_id
         WHERE a.conversation_id=? AND a.command_id=?
         AND (? IS NULL OR (json_extract(c.input,'$.prompt')=? AND COALESCE(json_extract(c.input,'$.intent'),json_extract(c.input,'$.prompt'))=?))
         ORDER BY a.attempt DESC LIMIT 1`,
      )
      .get(
        id,
        commandId,
        expectedPrompt ?? null,
        expectedPrompt ?? null,
        expectedPrompt ?? null,
      ) as { threadId: string; turnId: string } | undefined;
  }
  read(id: string, b: AccountBinding): Conversation {
    const row = this.db
      .prepare(
        `SELECT c.id AS conversationId,c.binding,c.cwd,c.thread_id AS threadId,
          c.thread_generation AS threadGeneration,c.recovery,
          c.recovery_strategy AS recoveryStrategy,
          c.web_search_grant AS webSearchGrant,
          c.web_search_grant_revision AS webSearchGrantRevision,
          c.web_search_grant_updated_at AS webSearchGrantUpdatedAt,
          c.tool_surface_revision AS toolSurfaceRevision,
          c.rollover_context AS rolloverContext,
          g.last_completed_turn_id AS lastCompletedTurnId
        FROM codex_conversations c
        LEFT JOIN codex_thread_generations g
          ON g.conversation_id=c.id AND g.generation=c.thread_generation
        WHERE c.id=?`,
      )
      .get(id) as (Conversation & { binding: string }) | undefined;
    if (!row || row.binding !== this.key(b))
      throw new Error('Codex conversation binding unavailable or changed');
    return {
      conversationId: row.conversationId,
      cwd: row.cwd,
      threadId: row.threadId,
      threadGeneration: row.threadGeneration,
      lastCompletedTurnId: row.lastCompletedTurnId,
      recovery: row.recovery,
      recoveryStrategy: row.recoveryStrategy,
      webSearchGrant: WebSearchGrantSchema.parse(row.webSearchGrant),
      webSearchGrantRevision: row.webSearchGrantRevision,
      webSearchGrantUpdatedAt: row.webSearchGrantUpdatedAt,
      toolSurfaceRevision: row.toolSurfaceRevision,
      rolloverContext: row.rolloverContext,
    };
  }
  /** Acknowledged provider context, distinct from selection or successful file upload. */
  recordAgentContextAdoption(
    id: string,
    binding: AccountBinding,
    commandId: string,
    threadId: string,
    turnId: string,
    selection: AgentContextAdoptionSelection,
  ): void {
    const encoded = JSON.stringify(AgentContextAdoption.parse(selection));
    this.db.transaction(() => {
      const state = this.read(id, binding);
      const command = this.commands(id, binding).find((entry) => entry.id === commandId);
      if (state.threadId !== threadId || command?.status !== 'running')
        throw Error('Agent context adoption requires the running provider thread');
      const native = this.db
        .prepare(
          'SELECT thread_id,turn_id,generation FROM codex_capacity_native_acks WHERE conversation_id=? AND command_id=? AND attempt=?',
        )
        .get(id, commandId, command.attempt) as
        { thread_id: string; turn_id: string; generation: number } | undefined;
      if (
        !native ||
        native.thread_id !== threadId ||
        native.turn_id !== turnId ||
        native.generation !== state.threadGeneration
      )
        throw Error('Agent context adoption requires the exact native acknowledgement');
      const previous = this.db
        .prepare(
          'SELECT thread_id,turn_id,selection FROM codex_agent_context_adoptions WHERE conversation_id=? AND command_id=? AND attempt=?',
        )
        .get(id, commandId, command.attempt) as
        { thread_id: string; turn_id: string; selection: string } | undefined;
      if (previous) {
        if (
          previous.thread_id !== threadId ||
          previous.turn_id !== turnId ||
          previous.selection !== encoded
        )
          throw Error('Conflicting agent context adoption');
        return;
      }
      this.db
        .prepare('INSERT INTO codex_agent_context_adoptions VALUES (?,?,?,?,?,?,?)')
        .run(id, commandId, command.attempt, threadId, turnId, encoded, Date.now());
    })();
  }
  agentContextAdoptions(id: string, binding: AccountBinding) {
    this.read(id, binding);
    return (
      this.db
        .prepare(
          'SELECT command_id AS commandId,attempt,thread_id AS threadId,turn_id AS turnId,selection,accepted_at AS acceptedAt FROM codex_agent_context_adoptions WHERE conversation_id=? ORDER BY accepted_at,command_id,attempt',
        )
        .all(id) as {
        commandId: string;
        attempt: number;
        threadId: string;
        turnId: string;
        selection: string;
        acceptedAt: number;
      }[]
    ).map((row) => ({ ...row, selection: AgentContextAdoption.parse(JSON.parse(row.selection)) }));
  }
  recordKnowledgeAdoption(
    id: string,
    binding: AccountBinding,
    commandId: string,
    threadId: string,
    turnId: string,
    selection: KnowledgeAdoptionSelection,
  ): void {
    const encoded = JSON.stringify(KnowledgeAdoption.parse(selection));
    RuntimeString.parse(threadId);
    RuntimeString.parse(turnId);
    this.db.transaction(() => {
      if (this.read(id, binding).threadId !== threadId)
        throw new Error('Knowledge adoption provider thread differs');
      const command = this.commands(id, binding).find((entry) => entry.id === commandId);
      if (!command || command.status !== 'running')
        throw new Error('Knowledge adoption requires a running command');
      const previous = this.db
        .prepare(
          'SELECT thread_id,turn_id,selection FROM codex_knowledge_adoptions WHERE conversation_id=? AND command_id=? AND attempt=?',
        )
        .get(id, commandId, command.attempt) as
        { thread_id: string; turn_id: string; selection: string } | undefined;
      if (previous) {
        if (
          previous.thread_id !== threadId ||
          previous.turn_id !== turnId ||
          previous.selection !== encoded
        )
          throw new Error('Conflicting knowledge adoption');
        return;
      }
      this.db
        .prepare('INSERT INTO codex_knowledge_adoptions VALUES (?,?,?,?,?,?,?)')
        .run(id, commandId, command.attempt, threadId, turnId, encoded, Date.now());
    })();
  }
  knowledgeAdoptions(id: string, binding: AccountBinding) {
    this.read(id, binding);
    const rows = this.db
      .prepare(
        'SELECT command_id AS commandId,attempt,thread_id AS threadId,turn_id AS turnId,selection,accepted_at AS acceptedAt FROM codex_knowledge_adoptions WHERE conversation_id=? ORDER BY accepted_at,command_id,attempt',
      )
      .all(id) as {
      commandId: string;
      attempt: number;
      threadId: string;
      turnId: string;
      selection: string;
      acceptedAt: number;
    }[];
    return rows.map((row) => ({
      ...row,
      selection: KnowledgeAdoption.parse(JSON.parse(row.selection)),
    }));
  }

  /** Private account-bound routing; never infer a sandbox from conversation IDs. */
  readOpenShellCustody(id: string, binding: AccountBinding): OpenShellCodexCustody | null {
    this.read(id, binding);
    const row = this.db
      .prepare('SELECT owner_kind,openshell_custody FROM codex_conversations WHERE id=?')
      .get(id) as { owner_kind: string | null; openshell_custody: string | null };
    if (row.owner_kind !== 'ordinary') throw new Error('OpenShell Codex custody owner unavailable');
    return row.openshell_custody === null
      ? null
      : OpenShellCodexCustodySchema.parse(JSON.parse(row.openshell_custody));
  }
  setOpenShellCustody(id: string, binding: AccountBinding, raw: unknown): void {
    const snapshot = OpenShellCodexCustodySchema.parse(raw);
    this.db
      .transaction(() => {
        const conversation = this.read(id, binding);
        const previous = this.readOpenShellCustody(id, binding);
        if (previous) {
          if (!isDeepStrictEqual(previous, snapshot))
            throw new Error('OpenShell Codex custody cannot be replaced');
          return;
        }
        if (
          conversation.threadId ||
          this.commands(id, binding).length ||
          this.readHostCustody(id, binding)
        )
          throw new Error('Legacy Codex history has no OpenShell custody authority');
        const changed = this.db
          .prepare(
            'UPDATE codex_conversations SET openshell_custody=? WHERE id=? AND openshell_custody IS NULL',
          )
          .run(JSON.stringify(snapshot), id).changes;
        if (changed !== 1) throw new Error('OpenShell Codex custody changed concurrently');
      })
      .immediate();
  }
  readHostCustody(id: string, binding: AccountBinding): HostCodexCustody | null {
    this.read(id, binding);
    const row = this.db
      .prepare('SELECT owner_kind,host_custody FROM codex_conversations WHERE id=?')
      .get(id) as { owner_kind: string | null; host_custody: string | null };
    if (row.owner_kind !== 'ordinary') throw new Error('Host Codex custody owner unavailable');
    return row.host_custody === null
      ? null
      : HostCodexCustodySchema.parse(JSON.parse(row.host_custody));
  }
  /** Exact write before native thread effects. Legacy provider history cannot
   * acquire invented physical or operator custody retroactively.
   */
  setHostCustody(id: string, binding: AccountBinding, raw: unknown): void {
    const snapshot = HostCodexCustodySchema.parse(raw);
    this.db
      .transaction(() => {
        const conversation = this.read(id, binding);
        const previous = this.readHostCustody(id, binding);
        if (previous) {
          if (!isDeepStrictEqual(previous, snapshot)) {
            const { codeModeHost, ...originalExecutable } = snapshot.executable;
            const journal = this.hostBundleUpgrade(id, binding);
            const companionPlan =
              codeModeHost && (({ ownedIdentity: _owned, ...plan }) => plan)(codeModeHost);
            // A reviewed cold bootstrap can complete the runtime distribution.
            // This never replaces an owner, credential, main binary or history,
            // and cannot repair unknown/running work by adopting another bundle.
            if (
              previous.executable.codeModeHost ||
              !journal ||
              !isDeepStrictEqual(journal.custody, previous) ||
              !isDeepStrictEqual(journal.plan, companionPlan) ||
              !codeModeHost ||
              this.hasRunningCommand(id, binding) ||
              !isDeepStrictEqual({ ...snapshot, executable: originalExecutable }, previous) ||
              codeModeHost.path !==
                join(dirname(previous.executable.path), 'codex-code-mode-host') ||
              codeModeHost.source !==
                join(dirname(previous.executable.source), 'codex-code-mode-host') ||
              !isDeepStrictEqual(
                codeModeHost.sourceDirectory,
                previous.executable.sourceDirectory,
              ) ||
              !isDeepStrictEqual(codeModeHost.ownedDirectory, previous.executable.ownedDirectory)
            )
              throw new Error('Host Codex custody cannot be replaced');
            this.db
              .prepare('UPDATE codex_conversations SET host_custody=? WHERE id=?')
              .run(JSON.stringify(snapshot), id);
          }
          return;
        }
        if (conversation.threadId || this.commands(id, binding).length)
          throw new Error('Legacy Codex history has no host custody authority');
        const changed = this.db
          .prepare(
            'UPDATE codex_conversations SET host_custody=? WHERE id=? AND host_custody IS NULL',
          )
          .run(JSON.stringify(snapshot), id).changes;
        if (changed !== 1) throw new Error('Host Codex custody changed concurrently');
      })
      .immediate();
  }
  private hostBundleUpgrade(id: string, binding: AccountBinding) {
    this.read(id, binding);
    const row = this.db
      .prepare('SELECT host_bundle_upgrade FROM codex_conversations WHERE id=?')
      .get(id) as { host_bundle_upgrade: string | null };
    return row.host_bundle_upgrade === null
      ? undefined
      : HostBundleUpgrade.parse(JSON.parse(row.host_bundle_upgrade));
  }
  /** Durable intent precedes every companion file effect. No native launch or
   * provider await occurs before completion CAS commits. Interrupted copies can
   * be rebuilt only under this exact original custody/source/home journal.
   */
  completeHostRuntimeBundle(
    id: string,
    binding: AccountBinding,
    raw: HostCodexCustody,
    executable: FrozenHostCodexExecutable,
  ): void {
    const custody = HostCodexCustodySchema.parse(raw);
    const plan = executable.companionUpgradePlan();
    if (
      !plan ||
      custody.executable.codeModeHost ||
      !isDeepStrictEqual(executable.custodySnapshot(), custody.executable)
    )
      throw Error('Original host bundle upgrade required');
    const intended = HostBundleUpgrade.parse({ version: 1, custody, plan });
    this.db
      .transaction(() => {
        if (
          !isDeepStrictEqual(this.readHostCustody(id, binding), custody) ||
          this.hasRunningCommand(id, binding)
        )
          throw Error('Original host bundle upgrade required');
        this.assertNoPendingThreadDispatch(id, binding);
        this.assertNoPendingThreadOwnership(id, binding);
        const previous = this.hostBundleUpgrade(id, binding);
        if (previous) {
          if (!isDeepStrictEqual(previous, intended)) throw Error('Host bundle upgrade changed');
        } else {
          if (lstatSync(plan.path, { throwIfNoEntry: false }))
            throw Error('Unexplained host bundle artifact');
          this.db
            .prepare('UPDATE codex_conversations SET host_bundle_upgrade=? WHERE id=?')
            .run(JSON.stringify(intended), id);
        }
      })
      .immediate();
    executable.completeRuntimeBundle(plan);
    this.db
      .transaction(() => {
        if (
          !isDeepStrictEqual(this.hostBundleUpgrade(id, binding), intended) ||
          !isDeepStrictEqual(this.readHostCustody(id, binding), custody)
        )
          throw Error('Host bundle upgrade changed');
        this.setHostCustody(id, binding, { ...custody, executable: executable.custodySnapshot() });
        this.db
          .prepare('UPDATE codex_conversations SET host_bundle_upgrade=NULL WHERE id=?')
          .run(id);
      })
      .immediate();
  }
  readArtifactRuntime(id: string, binding: AccountBinding): ArtifactRuntime | null {
    this.read(id, binding);
    const row = this.db
      .prepare('SELECT artifact_runtime FROM codex_conversations WHERE id=?')
      .get(id) as { artifact_runtime: string | null };
    return row.artifact_runtime === null
      ? null
      : ArtifactRuntimeSchema.parse(JSON.parse(row.artifact_runtime));
  }
  /** Includes archived owners; returns provenance only, with no route secrets or adoption authority. */
  listSandboxOwnership(): SandboxOwnershipEvidence[] {
    const rows = this.db
      .prepare(
        `SELECT c.id,c.binding,c.owner_kind,c.artifact_runtime,m.data AS migration,m.binding AS migration_binding
      FROM codex_conversations c LEFT JOIN codex_runtime_migrations m ON m.conversation_id=c.id
      WHERE c.artifact_runtime IS NOT NULL OR m.data IS NOT NULL`,
      )
      .all() as Array<{
      id: string;
      binding: string;
      owner_kind: string | null;
      artifact_runtime: string | null;
      migration: string | null;
      migration_binding: string | null;
    }>;
    return rows.flatMap((row) => {
      const binding = z
        .tuple([z.string(), z.string(), z.string(), z.string()])
        .parse(JSON.parse(row.binding));
      const result: SandboxOwnershipEvidence[] = [];
      const add = (raw: unknown, relation: string) => {
        const { runtime } = ArtifactRuntimeSchema.parse(raw);
        result.push({
          conversationId: row.id,
          physicalId: runtime.sandboxId,
          sandboxName: runtime.sandboxName,
          workspace: runtime.workspace,
          gateway: runtime.gateway,
          gatewayEndpoint: runtime.gatewayEndpoint ?? null,
          accountId: binding[0],
          ownerKind: row.owner_kind,
          relation,
        });
      };
      if (row.artifact_runtime) add(JSON.parse(row.artifact_runtime), 'runtime');
      if (row.migration) {
        if (row.migration_binding !== row.binding)
          throw new Error('Runtime migration account binding changed');
        const migration = JSON.parse(row.migration) as RuntimeMigration;
        add(migration.source, 'migration_source');
        if (migration.candidate) add(migration.candidate, 'migration_candidate');
      }
      return result;
    });
  }
  setArtifactRuntime(id: string, binding: AccountBinding, value: ArtifactRuntime): void {
    this.db.transaction(() => {
      this.read(id, binding);
      // Explicit allowlist prevents later runtime additions from persisting credentials.
      const {
        sandboxName,
        sandboxId,
        resourceVersion,
        created,
        workdir,
        appServerCommand,
        cli,
        gateway,
        workspace,
        gatewayEndpoint,
        gatewayInsecure,
        cliEnvironment,
      } = value.runtime;
      const safe = ArtifactRuntimeSchema.parse({
        runtime: {
          sandboxName,
          sandboxId,
          resourceVersion,
          created,
          workdir,
          appServerCommand,
          cli,
          gateway,
          workspace,
          gatewayEndpoint,
          gatewayInsecure,
          cliEnvironment,
        },
        route: value.route,
      });
      this.db
        .prepare('UPDATE codex_conversations SET artifact_runtime=? WHERE id=?')
        .run(JSON.stringify(safe), id);
    })();
  }
  readRuntimeMigration(id: string, binding: AccountBinding): RuntimeMigration | null {
    this.read(id, binding);
    const row = this.db
      .prepare('SELECT binding,data FROM codex_runtime_migrations WHERE conversation_id=?')
      .get(id) as { binding: string; data: string } | undefined;
    if (!row) return null;
    if (row.binding !== this.key(binding))
      throw new Error('Runtime migration account binding changed');
    return JSON.parse(row.data) as RuntimeMigration;
  }
  hasAmbiguousRuntimeActivity(id: string, binding: AccountBinding): boolean {
    const conversation = this.read(id, binding);
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM codex_commands WHERE conversation_id=? AND (status='running' OR (ambiguous=1 AND recovery_acknowledged=0))",
      )
      .get(id) as { count: number };
    return row.count > 0 || conversation.recoveryStrategy !== 'resume';
  }
  beginRuntimeMigration(id: string, binding: AccountBinding, record: RuntimeMigration) {
    return this.db.transaction(() => {
      const conversation = this.read(id, binding);
      if (
        conversation.threadId !== record.identity.thread ||
        conversation.threadGeneration !== record.threadGeneration
      )
        throw new Error('Runtime migration provider thread changed');
      const owner = this.db
        .prepare('SELECT owner_kind FROM codex_conversations WHERE id=?')
        .get(id) as { owner_kind: string | null };
      if (owner.owner_kind !== 'ordinary')
        throw new Error('Runtime migration requires authoritative ordinary ownership');
      const authoritativeSource = this.readArtifactRuntime(id, binding);
      if (authoritativeSource && !sameArtifactRuntimeIdentity(authoritativeSource, record.source))
        throw new Error('Runtime migration source ownership differs from authoritative mapping');
      if (!authoritativeSource) {
        // Reviewed adapter has observed actual owned image/policy; conversation
        // thread and account profile remain the authority, never labels alone.
        this.setArtifactRuntime(id, binding, record.source);
        record = { ...record, bootstrappedSource: true };
      }
      this.db
        .prepare('INSERT OR IGNORE INTO codex_runtime_migrations VALUES (?,?,?,?)')
        .run(id, this.key(binding), record.generation, JSON.stringify(record));
      return this.readRuntimeMigration(id, binding)!;
    })();
  }
  repairRejectedRuntimeMigrationName(id: string, binding: AccountBinding, generation: number) {
    return this.db.transaction(() => {
      const current = this.readRuntimeMigration(id, binding);
      if (!current || current.generation !== generation)
        throw new Error('Runtime migration generation changed');
      // Only the legacy CLI's explicit pre-create validation rejection permits
      // a name change. Uncertain creates and existing candidates keep their name.
      if (
        current.phase !== 'blocked' ||
        current.resumePhase !== 'checkpointed' ||
        !current.checkpoint ||
        current.candidate ||
        !/^mitzo-migrate-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
          current.candidateName,
        ) ||
        !/name exceeds\s*\n\s*│ maximum length \(50 > 19\)"\s*$/.test(current.failure ?? '')
      )
        return current;
      const conversation = this.read(id, binding);
      if (
        conversation.threadId !== current.identity.thread ||
        conversation.threadGeneration !== current.threadGeneration ||
        this.hasAmbiguousRuntimeActivity(id, binding) ||
        !sameArtifactRuntimeIdentity(this.readArtifactRuntime(id, binding), current.source)
      )
        throw new Error('Runtime migration source ownership changed before name repair');
      const next = {
        ...current,
        generation: generation + 1,
        phase: 'checkpointed' as const,
        candidateName: `mitzo-${createHash('sha256').update(current.candidateName).digest('hex').slice(0, 12)}`,
        failure: undefined,
        retryable: undefined,
        retryNotBefore: undefined,
        resumePhase: undefined,
      };
      const update = this.db
        .prepare(
          'UPDATE codex_runtime_migrations SET generation=?,data=? WHERE conversation_id=? AND binding=? AND generation=?',
        )
        .run(next.generation, JSON.stringify(next), id, this.key(binding), generation);
      if (update.changes !== 1) throw new Error('Runtime migration generation changed');
      return next;
    })();
  }
  advanceRuntimeMigration(
    id: string,
    binding: AccountBinding,
    generation: number,
    patch: Partial<RuntimeMigration>,
  ) {
    return this.db.transaction(() => {
      const current = this.readRuntimeMigration(id, binding);
      if (!current || current.generation !== generation || current.phase === 'committed')
        throw new Error('Runtime migration generation changed');
      const next = { ...current, ...patch, generation: generation + 1 };
      // Immutable capture origin cannot be replaced by a target image or new thread.
      if (
        Object.prototype.hasOwnProperty.call(patch, 'sourcePolicyAttestation') ||
        patch.identity ||
        patch.source ||
        patch.threadGeneration !== undefined ||
        patch.targetImage ||
        patch.targetPolicy ||
        patch.candidateName ||
        patch.bootstrappedSource !== undefined
      )
        throw new Error('Runtime migration immutable origin changed');
      const update = this.db
        .prepare(
          'UPDATE codex_runtime_migrations SET generation=?,data=? WHERE conversation_id=? AND binding=? AND generation=?',
        )
        .run(next.generation, JSON.stringify(next), id, this.key(binding), generation);
      if (update.changes !== 1) throw new Error('Runtime migration generation changed');
      return next;
    })();
  }
  commitRuntimeMigration(id: string, binding: AccountBinding, generation: number): ArtifactRuntime {
    return this.db.transaction(() => {
      const record = this.readRuntimeMigration(id, binding);
      const conversation = this.read(id, binding);
      if (
        !record ||
        record.generation !== generation ||
        record.phase !== 'restored' ||
        !record.candidate
      )
        throw new Error('Runtime migration is not verified for switch');
      if (
        conversation.threadId !== record.identity.thread ||
        conversation.threadGeneration !== record.threadGeneration ||
        this.hasAmbiguousRuntimeActivity(id, binding)
      )
        throw new Error('Runtime migration provider activity changed before switch');
      if (!sameArtifactRuntimeIdentity(this.readArtifactRuntime(id, binding), record.source))
        throw new Error('Runtime migration source ownership changed before switch');
      this.setArtifactRuntime(id, binding, record.candidate);
      this.advanceRuntimeMigration(id, binding, generation, { phase: 'committed' });
      return this.readArtifactRuntime(id, binding)!;
    })();
  }
  readWebSearchGrant(id: string, b: AccountBinding): PersistedWebSearchGrant {
    const row = this.read(id, b);
    return {
      grant: row.webSearchGrant,
      revision: row.webSearchGrantRevision,
      updatedAt: row.webSearchGrantUpdatedAt,
    };
  }
  setWebSearchGrant(
    id: string,
    b: AccountBinding,
    expectedRevision: number,
    grant: Exclude<WebSearchGrant, 'unresolved'>,
    updatedAt = Date.now(),
  ): PersistedWebSearchGrant {
    this.read(id, b);
    const result = this.db
      .prepare(
        `UPDATE codex_conversations
        SET web_search_grant=?,web_search_grant_revision=web_search_grant_revision+1,
          web_search_grant_updated_at=?
        WHERE id=? AND web_search_grant_revision=?`,
      )
      .run(grant, updatedAt, id, expectedRevision);
    if (result.changes !== 1) throw new Error('Web search grant changed concurrently');
    return this.readWebSearchGrant(id, b);
  }
  create(
    id: string,
    b: AccountBinding,
    cwd: string,
    toolSurfaceRevision: string | null = null,
    ownerKind: 'ordinary' | 'symposium' = 'ordinary',
  ) {
    this.db
      .transaction(() => {
        this.db
          .prepare(
            'INSERT OR IGNORE INTO codex_conversations(id,binding,cwd,tool_surface_revision,owner_kind) VALUES (?,?,?,?,?)',
          )
          .run(id, this.key(b), cwd, toolSurfaceRevision, ownerKind);
        if (this.read(id, b).cwd !== cwd) throw new Error('Codex conversation workspace changed');
        const row = this.db
          .prepare('SELECT owner_kind FROM codex_conversations WHERE id=?')
          .get(id) as { owner_kind: string | null };
        if (
          (row.owner_kind === null && this.ownership.requireOwner) ||
          (row.owner_kind !== null && row.owner_kind !== ownerKind)
        )
          throw new Error('Codex conversation owner is unavailable or changed');
      })
      .immediate();
  }
  /** Reserve only newly created ledger rows, never infer undispatched legacy history. */
  reserveStartup(id: string, b: AccountBinding, cwd: string) {
    this.db
      .transaction(() => {
        const existing = this.db.prepare('SELECT id FROM codex_conversations WHERE id=?').get(id);
        this.create(id, b, cwd);
        if (!existing)
          this.db
            .prepare(
              "INSERT INTO codex_startup_reservations(conversation_id,phase) VALUES (?,'provisioning')",
            )
            .run(id);
      })
      .immediate();
  }
  startupNeedsProvisioning(id: string, b: AccountBinding): boolean {
    const conversation = this.read(id, b);
    const row = this.db
      .prepare('SELECT phase FROM codex_startup_reservations WHERE conversation_id=?')
      .get(id) as { phase: string } | undefined;
    if (row?.phase !== 'provisioning') return false;
    this.assertNoPendingThreadDispatch(id, b);
    this.assertNoPendingThreadOwnership(id, b);
    if (conversation.threadId || this.commands(id, b).length || this.readArtifactRuntime(id, b))
      throw new Error('Codex startup reservation conflicts with provider history');
    return true;
  }
  /** A transport-started startup needs an acknowledged thread before normal resume. */
  assertStartupResumeSafe(id: string, b: AccountBinding) {
    const conversation = this.read(id, b);
    const row = this.db
      .prepare('SELECT phase FROM codex_startup_reservations WHERE conversation_id=?')
      .get(id) as { phase: string } | undefined;
    if (row?.phase === 'provider_initializing' && !conversation.threadId)
      throw new Error('Codex startup provider initialization outcome is unverified');
  }
  /** Persist the handoff before any app-server process or provider RPC can start. */
  markStartupProviderInitializing(id: string, b: AccountBinding) {
    this.read(id, b);
    this.db
      .prepare(
        "UPDATE codex_startup_reservations SET phase='provider_initializing' WHERE conversation_id=? AND phase='provisioning'",
      )
      .run(id);
  }
  /** A pre-RPC fence: a lost acknowledgment must never recreate/replay a child. */
  beginThreadReplacementDispatch(
    id: string,
    b: AccountBinding,
    parent: string | undefined,
    thread: string,
    command: CodexCommand,
  ) {
    this.db.transaction(() => {
      const state = this.read(id, b);
      if ((state.threadId ?? undefined) !== parent)
        throw new Error('Codex provider thread generation changed');
      const active = this.commands(id, b).find((c) => c.id === command.id);
      if (active?.status !== 'running' || active.attempt !== command.attempt)
        throw new Error('Codex replacement dispatch command changed');
      this.db
        .prepare(
          'INSERT INTO codex_pending_thread_dispatches(conversation_id,parent_thread_id,thread_id,command_id,attempt,parent_generation) VALUES (?,?,?,?,?,?)',
        )
        .run(id, parent ?? null, thread, command.id, command.attempt, state.threadGeneration);
    })();
  }
  assertNoPendingThreadDispatch(id: string, b: AccountBinding) {
    this.read(id, b);
    if (
      this.db
        .prepare('SELECT 1 FROM codex_pending_thread_dispatches WHERE conversation_id=?')
        .get(id)
    )
      throw new Error('Codex pending provider thread dispatch requires explicit recovery');
  }
  rejectThreadReplacementDispatch(
    id: string,
    b: AccountBinding,
    thread: string,
    command: CodexCommand,
  ) {
    this.db.transaction(() => {
      this.read(id, b);
      const deleted = this.db
        .prepare(
          'DELETE FROM codex_pending_thread_dispatches WHERE conversation_id=? AND thread_id=? AND command_id=? AND attempt=?',
        )
        .run(id, thread, command.id, command.attempt);
      if (deleted.changes !== 1) throw new Error('Codex replacement rejection fence changed');
    })();
  }
  acceptThreadReplacement(
    id: string,
    b: AccountBinding,
    parent: string | undefined,
    thread: string,
    command: CodexCommand,
    revision: string,
    context?: string,
    reason: 'tool_surface_change' | 'provider_transport_failure' = 'tool_surface_change',
    turnId?: string,
  ) {
    this.db.transaction(() => {
      if (!turnId) throw new Error('Codex replacement acknowledgment turn is missing');
      const pending = this.db
        .prepare('SELECT * FROM codex_pending_thread_dispatches WHERE conversation_id=?')
        .get(id) as
        | {
            parent_thread_id: string | null;
            thread_id: string;
            command_id: string;
            attempt: number;
          }
        | undefined;
      if (
        !pending ||
        pending.parent_thread_id !== (parent ?? null) ||
        pending.thread_id !== thread ||
        pending.command_id !== command.id ||
        pending.attempt !== command.attempt
      )
        throw new Error('Codex replacement acknowledgment changed');
      const active = this.commands(id, b).find((c) => c.id === command.id);
      if (active?.status !== 'running' || active.attempt !== command.attempt)
        throw new Error('Codex replacement acknowledgment command changed');
      if (parent) this.replaceThread(id, b, parent, thread, reason, undefined, revision, context);
      else this.bindThread(id, b, thread, revision);
      this.db
        .prepare(
          'INSERT INTO codex_thread_acceptances(conversation_id,command_id,attempt,thread_id,turn_id,generation,ownership_pending,accepted_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          command.id,
          command.attempt,
          thread,
          turnId,
          this.read(id, b).threadGeneration,
          1,
          Date.now(),
        );
      this.db
        .prepare('DELETE FROM codex_pending_thread_dispatches WHERE conversation_id=?')
        .run(id);
    })();
  }
  readThreadAcceptances(id: string, b: AccountBinding) {
    this.read(id, b);
    const rows = this.db
      .prepare(
        'SELECT command_id AS commandId, attempt, thread_id AS threadId, turn_id AS turnId, generation, ownership_pending AS ownershipPending, accepted_at AS acceptedAt, terminal_conflict AS terminalConflict FROM codex_thread_acceptances WHERE conversation_id=? ORDER BY accepted_at',
      )
      .all(id) as Array<{
      commandId: string;
      attempt: number;
      threadId: string;
      turnId: string;
      generation: number;
      ownershipPending: number;
      acceptedAt: number;
      terminalConflict: number;
    }>;
    return rows.map((row) => ({
      ...row,
      ownershipPending: !!row.ownershipPending,
      terminalConflict: !!row.terminalConflict,
    }));
  }
  pendingThreadOwnership(id: string, b: AccountBinding) {
    const current = this.read(id, b);
    const pending = this.readThreadAcceptances(id, b).filter((row) => row.ownershipPending);
    if (!pending.length) return undefined;
    if (pending.some((row) => row.terminalConflict))
      throw new Error(
        'Codex accepted provider turn has conflicting terminal outcomes; inspect recovery',
      );
    if (
      pending.length !== 1 ||
      pending[0].threadId !== current.threadId ||
      pending[0].generation !== current.threadGeneration
    )
      throw new Error('Codex accepted provider thread ownership identity changed');
    return pending[0];
  }
  completeThreadOwnership(id: string, b: AccountBinding, thread: string) {
    this.db.transaction(() => {
      const pending = this.pendingThreadOwnership(id, b);
      if (!pending || pending.threadId !== thread)
        throw new Error('Codex provider thread ownership fence changed');
      const changed = this.db
        .prepare(
          'UPDATE codex_thread_acceptances SET ownership_pending=0 WHERE conversation_id=? AND command_id=? AND attempt=? AND ownership_pending=1',
        )
        .run(id, pending.commandId, pending.attempt);
      if (changed.changes !== 1) throw new Error('Codex provider thread ownership fence changed');
    })();
  }
  recordAcceptedThreadConflict(
    id: string,
    b: AccountBinding,
    command: Pick<CodexCommand, 'id' | 'attempt'>,
    thread: string,
    turn: string,
  ) {
    this.db.transaction(() => {
      const current = this.read(id, b);
      if (current.threadId !== thread)
        throw new Error('Codex accepted provider thread identity changed');
      const updated = this.db
        .prepare(
          'UPDATE codex_thread_acceptances SET terminal_conflict=1,ownership_pending=1 WHERE conversation_id=? AND command_id=? AND attempt=? AND thread_id=? AND turn_id=? AND generation=?',
        )
        .run(id, command.id, command.attempt, thread, turn, current.threadGeneration);
      if (updated.changes !== 1)
        throw new Error('Codex accepted provider terminal conflict differs');
      this.db
        .prepare(
          "UPDATE codex_commands SET status='interrupted',ambiguous=1,recovery_acknowledged=0 WHERE conversation_id=? AND id=? AND attempt=?",
        )
        .run(id, command.id, command.attempt);
      this.db.prepare('UPDATE codex_conversations SET recovery=1 WHERE id=?').run(id);
      this.db
        .prepare(
          'UPDATE codex_thread_generations SET last_completed_turn_id=NULL WHERE conversation_id=? AND generation=? AND last_completed_turn_id=?',
        )
        .run(id, current.threadGeneration, turn);
    })();
  }
  assertNoPendingThreadOwnership(id: string, b: AccountBinding) {
    if (this.pendingThreadOwnership(id, b))
      throw new Error('Codex accepted provider thread ownership requires recovery');
  }
  bindThread(id: string, b: AccountBinding, threadId: string, toolSurfaceRevision?: string) {
    this.db.transaction(() => {
      const current = this.read(id, b);
      if (!threadId || (current.threadId && current.threadId !== threadId))
        throw new Error('Codex provider thread changed');
      this.db
        .prepare(
          'UPDATE codex_conversations SET thread_id=?,tool_surface_revision=COALESCE(?,tool_surface_revision) WHERE id=?',
        )
        .run(threadId, toolSurfaceRevision ?? null, id);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO codex_thread_generations(
            conversation_id,generation,thread_id,parent_thread_id,reason,created_at)
          VALUES (?,?,?,?,?,?)`,
        )
        .run(id, current.threadGeneration, threadId, null, 'initial', Date.now());
    })();
  }
  replaceThread(
    id: string,
    b: AccountBinding,
    expectedThreadId: string,
    threadId: string,
    reason: 'provider_transport_failure' | 'tool_surface_change' | 'attempt_home_change',
    lastCompletedTurnId?: string,
    toolSurfaceRevision?: string,
    rolloverContext?: string,
  ) {
    return this.db.transaction(() => {
      const current = this.read(id, b);
      if (!threadId || threadId === expectedThreadId || current.threadId !== expectedThreadId)
        throw new Error('Codex provider thread generation changed');
      const generation = current.threadGeneration + 1;
      const now = Date.now();
      this.db
        .prepare(
          'UPDATE codex_thread_generations SET retired_at=? WHERE conversation_id=? AND generation=?',
        )
        .run(now, id, current.threadGeneration);
      this.db
        .prepare(
          `INSERT INTO codex_thread_generations(
            conversation_id,generation,thread_id,parent_thread_id,reason,
            last_completed_turn_id,created_at)
          VALUES (?,?,?,?,?,?,?)`,
        )
        .run(id, generation, threadId, expectedThreadId, reason, lastCompletedTurnId ?? null, now);
      this.db
        .prepare(
          `UPDATE codex_conversations
          SET thread_id=?,thread_generation=?,tool_surface_revision=COALESCE(?,tool_surface_revision),
            rollover_context=COALESCE(?,rollover_context)
          WHERE id=?`,
        )
        .run(threadId, generation, toolSurfaceRevision ?? null, rolloverContext ?? null, id);
      return generation;
    })();
  }
  assertAttemptHomeReplacement(
    id: string,
    binding: AccountBinding,
    previous: string,
    next: string,
  ) {
    const current = this.read(id, binding);
    if (current.threadId !== next || !current.rolloverContext?.trim())
      throw new Error('Codex attempt migration lacks retained continuity');
    const rows = this.db
      .prepare(
        `SELECT thread_id, parent_thread_id, reason FROM codex_thread_generations WHERE conversation_id=? ORDER BY generation DESC`,
      )
      .all(id) as Array<{ thread_id: string; parent_thread_id: string | null; reason: string }>;
    let cursor = next;
    for (const row of rows) {
      if (row.thread_id !== cursor) continue;
      if (row.reason !== 'attempt_home_change' || !row.parent_thread_id)
        throw new Error('Codex attempt migration lineage changed');
      cursor = row.parent_thread_id;
      if (cursor === previous) return;
    }
    throw new Error('Codex attempt migration predecessor is unavailable');
  }

  /** Host-owned lineage only; a thread ID supplied by a provider is insufficient. */
  assertToolSurfaceReplacement(
    id: string,
    binding: AccountBinding,
    previous: string,
    next: string,
  ) {
    const current = this.read(id, binding);
    if (current.threadId !== next || !current.rolloverContext?.trim())
      throw new Error('Codex thread migration lacks retained continuity');
    const rows = this.db
      .prepare(
        `SELECT thread_id, parent_thread_id, reason FROM codex_thread_generations
      WHERE conversation_id=? ORDER BY generation DESC`,
      )
      .all(id) as Array<{ thread_id: string; parent_thread_id: string | null; reason: string }>;
    let cursor = next;
    for (const row of rows) {
      if (row.thread_id !== cursor) continue;
      if (row.reason !== 'tool_surface_change' || !row.parent_thread_id)
        throw new Error('Codex thread migration lineage is not a tool refresh');
      cursor = row.parent_thread_id;
      if (cursor === previous) return;
    }
    throw new Error('Codex thread migration predecessor is unavailable');
  }

  clearRolloverContext(id: string, b: AccountBinding, expectedThreadId: string) {
    this.read(id, b);
    this.db
      .prepare('UPDATE codex_conversations SET rollover_context=NULL WHERE id=? AND thread_id=?')
      .run(id, expectedThreadId);
  }
  enqueue(
    id: string,
    b: AccountBinding,
    input: CodexCommandInput,
    supersedeCapacity = false,
  ): boolean {
    return this.db.transaction(() => {
      this.read(id, b);
      const data = CommandInput.parse(input);
      const json = JSON.stringify(data);
      const old = this.db
        .prepare('SELECT input FROM codex_commands WHERE conversation_id=? AND id=?')
        .get(id, data.id) as { input: string } | undefined;
      if (old) {
        const stored = JSON.parse(old.input) as Record<string, unknown>;
        const oldInput = CommandInput.parse(stored);
        const includesIntent = Object.hasOwn(stored, 'intent');
        if (idempotencyInput(oldInput, includesIntent) !== idempotencyInput(data, includesIntent))
          throw new Error('Codex message ID reused with different input');
        return false;
      }
      this.db
        .prepare(
          "INSERT INTO codex_commands(conversation_id,id,input,status) VALUES (?,?,?,'queued')",
        )
        .run(id, data.id, json);
      if (supersedeCapacity) {
        this.db
          .prepare(
            `UPDATE codex_commands SET status='cancelled'
          WHERE conversation_id=? AND status='queued'
          AND json_extract(input, '$.environmentContinuation') IS NOT NULL`,
          )
          .run(id);
        const recovery = this.capacityRecovery(id, b);
        if (
          recovery &&
          ['waiting', 'queued', 'running', 'exhausted', 'stopped'].includes(recovery.status)
        ) {
          const runningChild =
            recovery.childCommandId &&
            this.db
              .prepare(
                "SELECT 1 FROM codex_commands WHERE conversation_id=? AND id=? AND status='running'",
              )
              .get(id, recovery.childCommandId);
          const stopped = this.stopCapacityRecovery(id, b, recovery.id, recovery.sourceCommandId);
          if (runningChild) {
            stopped.supersedingCommandId = data.id;
            this.writeCapacityRecovery(id, stopped);
          }
        }
      }
      return true;
    })();
  }
  /** Trusted host-only continuation; no model text or credential payload selects authority. */
  queueEnvironmentContinuation(
    id: string,
    b: AccountBinding,
    sourceCommandId: string,
    sourceTurnId: string,
    callId: string,
  ): boolean {
    return this.db.transaction(() => {
      const state = this.read(id, b);
      const commands = this.commands(id, b);
      const source = commands.find((command) => command.id === sourceCommandId);
      if (
        !source ||
        source.status !== 'running' ||
        source.environmentContinuation ||
        !source.intent?.trim() ||
        source.allowedTools ||
        state.recovery ||
        !state.threadId ||
        commands.some((command) => command.status === 'queued')
      )
        return false;
      const receipt = this.db
        .prepare(
          `SELECT 1 FROM codex_tools
        WHERE conversation_id=? AND command_id=? AND call_id=? AND turn_id=?
        AND result_content IS NOT NULL AND result_is_error=0`,
        )
        .get(id, sourceCommandId, callId, sourceTurnId);
      if (!receipt) return false;
      return this.enqueue(id, b, {
        id: `environment-${createHash('sha256').update(sourceCommandId).digest('hex')}`,
        prompt:
          'Mitzo has applied the integration access approved during the preceding turn. Continue only the unfinished part of the original user-authorized request in this conversation. First inspect retained results and current state; do not repeat completed actions or retry an uncertain mutation. Keep the original scope and all current permission, skill and mode limits. If the request is already complete, report that without performing new work.',
        intent: source.intent,
        model: source.model ?? b.model,
        reasoningEffort: source.reasoningEffort,
        environmentContinuation: {
          sourceCommandId,
          sourceTurnId,
          sourceThreadId: state.threadId,
          sourceGeneration: state.threadGeneration,
        },
      });
    })();
  }
  commands(id: string, b: AccountBinding): CodexCommand[] {
    this.read(id, b);
    return (
      this.db
        .prepare(
          'SELECT input,status,attempt FROM codex_commands WHERE conversation_id=? ORDER BY sequence',
        )
        .all(id) as { input: string; status: CodexCommand['status']; attempt: number }[]
    ).map((row) => ({
      ...CommandInput.parse(JSON.parse(row.input)),
      status: row.status,
      attempt: row.attempt,
    }));
  }
  /** Polling must not deserialize historical prompts, images, or tool inputs. */
  /** Current inference snapshots only; never hydrate completed prompts/images
   * for a runtime or tool authorization fence.
   */
  nextQueuedCommandId(id: string, binding: AccountBinding): string | undefined {
    this.read(id, binding);
    const row = this.db
      .prepare(
        "SELECT id FROM codex_commands WHERE conversation_id=? AND status='queued' ORDER BY sequence LIMIT 1",
      )
      .get(id) as { id: string } | undefined;
    return row?.id;
  }
  pendingModelSelections(
    id: string,
    binding: AccountBinding,
  ): Array<{ model: string; thinking: string | null }> {
    this.read(id, binding);
    const rows = this.db
      .prepare(
        `SELECT json_extract(input,'$.model') AS model,
      json_extract(input,'$.reasoningEffort') AS thinking FROM codex_commands
      WHERE conversation_id=? AND status IN ('queued','running') ORDER BY sequence`,
      )
      .all(id);
    return z
      .array(
        z.strictObject({
          model: z.string().min(1).nullable(),
          thinking: z.string().min(1).nullable(),
        }),
      )
      .parse(rows)
      .map(({ model, thinking }) => ({ model: model ?? binding.model, thinking }));
  }
  queueOverview(id: string, b: AccountBinding) {
    this.read(id, b);
    const limit = 100;
    const queued = this.db
      .prepare(
        "SELECT id, substr(json_extract(input, '$.prompt'), 1, 160) AS preview FROM codex_commands WHERE conversation_id=? AND status='queued' AND NOT EXISTS (SELECT 1 FROM codex_capacity_continuations child WHERE child.conversation_id=codex_commands.conversation_id AND child.command_id=codex_commands.id AND child.ordinal>0) ORDER BY sequence LIMIT ?",
      )
      .all(id, limit + 1) as Array<{ id: string; preview: string }>;
    const cancelled = this.db
      .prepare(
        "SELECT id FROM codex_commands WHERE conversation_id=? AND status='cancelled' AND NOT EXISTS (SELECT 1 FROM codex_capacity_continuations child WHERE child.conversation_id=codex_commands.conversation_id AND child.command_id=codex_commands.id AND child.ordinal>0) ORDER BY sequence DESC LIMIT ?",
      )
      .all(id, limit + 1) as Array<{ id: string }>;
    return {
      queued: queued.slice(0, limit),
      cancelledIds: cancelled.slice(0, limit).map((c) => c.id),
      hasMore: queued.length > limit,
    };
  }
  /** Lightweight status for the frequent session metadata poll. It deliberately
   * leaves command JSON in SQLite: full command deserialization can include
   * historical prompts and image payloads. */
  queueSummary(id: string, b: AccountBinding) {
    this.read(id, b);
    const counts = this.db
      .prepare(
        "SELECT SUM(status='queued' AND NOT EXISTS (SELECT 1 FROM codex_capacity_continuations child WHERE child.conversation_id=codex_commands.conversation_id AND child.command_id=codex_commands.id AND child.ordinal>0)) AS queued, SUM(status='interrupted' AND recovery_acknowledged=0) AS interrupted, SUM(status='failed' AND recovery_acknowledged=0) AS failed FROM codex_commands WHERE conversation_id=? AND NOT EXISTS (SELECT 1 FROM codex_capacity_continuations lineage JOIN codex_capacity_continuations resolved ON resolved.conversation_id=lineage.conversation_id AND resolved.source_command_id=lineage.source_command_id WHERE lineage.conversation_id=codex_commands.conversation_id AND lineage.command_id=codex_commands.id AND resolved.terminal='completed')",
      )
      .get(id) as { queued: number | null; interrupted: number | null; failed: number | null };
    const latest = this.db
      .prepare(
        "SELECT json_extract(input, '$.model') AS model, json_extract(input, '$.reasoningEffort') AS reasoning_effort, json_type(input, '$.reasoningEffort') AS reasoning_effort_type FROM codex_commands WHERE conversation_id=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(id) as
      | {
          model: string | null;
          reasoning_effort: string | null;
          reasoning_effort_type: string | null;
        }
      | undefined;
    const failed = this.db
      .prepare(
        `SELECT id,attempt,retry_not_before,retryable,ambiguous
        FROM codex_commands
        WHERE conversation_id=? AND status='failed' AND recovery_acknowledged=0 AND NOT EXISTS (SELECT 1 FROM codex_capacity_continuations lineage JOIN codex_capacity_continuations resolved ON resolved.conversation_id=lineage.conversation_id AND resolved.source_command_id=lineage.source_command_id WHERE lineage.conversation_id=codex_commands.conversation_id AND lineage.command_id=codex_commands.id AND resolved.terminal='completed')
        ORDER BY sequence DESC LIMIT 1`,
      )
      .get(id) as
      | {
          id: string;
          attempt: number;
          retry_not_before: number | null;
          retryable: number | null;
          ambiguous: number | null;
        }
      | undefined;
    const capacity = this.capacityRecovery(id, b);
    return {
      ...(capacity
        ? {
            capacityRecovery: {
              id: capacity.id,
              sourceCommandId: capacity.sourceCommandId,
              status: capacity.status,
              attempts: capacity.attempts,
              maxAttempts: capacity.maxAttempts,
              requiresInspection: this.capacityRequiresInspection(id, capacity.sourceCommandId),
              ...(capacity.nextRetryAt ? { nextRetryAt: capacity.nextRetryAt } : {}),
            },
          }
        : {}),
      queued: counts.queued ?? 0,
      interrupted: counts.interrupted ?? 0,
      failed: counts.failed ?? 0,
      model: latest?.model ?? b.model,
      // SQLite's json_extract returns null for either an omitted property or
      // an explicit JSON null. json_type keeps the user's explicit reset.
      reasoningEffort:
        latest?.reasoning_effort_type === null ? undefined : latest?.reasoning_effort,
      ...(failed?.retry_not_before ? { retryAvailableAt: failed.retry_not_before } : {}),
      ...(failed ? { retryable: failed.retryable === 1 && !this.retryFenced(id, failed) } : {}),
      ...(failed ? { requiresRetryConfirmation: failed.ambiguous === 1 } : {}),
    };
  }
  /** Lifecycle callers must use this raw snapshot rather than the UI-oriented
   * queue summary, which intentionally degrades errors to an empty result. */
  lifecycleQueue(id: string, b: AccountBinding) {
    const conversation = this.read(id, b);
    const counts = this.db
      .prepare(
        "SELECT SUM(status='queued') AS queued, SUM(status='running') AS running FROM codex_commands WHERE conversation_id=?",
      )
      .get(id) as { queued: number | null; running: number | null };
    return {
      queued: counts.queued ?? 0,
      running: counts.running ?? 0,
      recovery: !!conversation.recovery,
    };
  }
  /** Retain the command ID so a retried send cannot resurrect cancelled work. */
  cancelQueued(
    id: string,
    b: AccountBinding,
    commandId: string,
  ): 'cancelled' | 'not_queued' | 'not_found' {
    return this.db.transaction(() => {
      this.read(id, b);
      if (
        this.db
          .prepare(
            'SELECT 1 FROM codex_capacity_continuations WHERE conversation_id=? AND command_id=? AND ordinal>0',
          )
          .get(id, commandId)
      )
        return 'not_queued';
      const update = this.db
        .prepare(
          "UPDATE codex_commands SET status='cancelled' WHERE conversation_id=? AND id=? AND status='queued'",
        )
        .run(id, commandId);
      const row = this.db
        .prepare('SELECT status FROM codex_commands WHERE conversation_id=? AND id=?')
        .get(id, commandId) as { status: string } | undefined;
      if (!row) return 'not_found';
      if (row.status !== 'cancelled') return 'not_queued';
      // A retry against an existing cancellation is idempotent, but it must not
      // clear a recovery fence that was retained for another uncertain action.
      if (update.changes === 0) return 'cancelled';
      // Cancellation resolves a recovery fence only when it removes all work
      // and all *unacknowledged* interrupted/failed uncertainty. An earlier
      // recovery acknowledgement is durable per command, so old history does
      // not block cancellation after a later restart.
      const unresolved = this.db
        .prepare(
          "SELECT 1 FROM codex_commands WHERE conversation_id=? AND (status IN ('queued','running') OR (status IN ('interrupted','failed') AND recovery_acknowledged=0)) LIMIT 1",
        )
        .get(id);
      if (!unresolved)
        this.db.prepare('UPDATE codex_conversations SET recovery=0 WHERE id=?').run(id);
      return 'cancelled';
    })();
  }
  /** Provider call IDs do not provide semantic side-effect deduplication. Some
   * provider-native tools also execute outside claimTool(), so every ambiguous
   * turn requires explicit confirmation rather than guessing that it was safe. */
  private retryFenced(id: string, command?: { id: string; attempt: number }): boolean {
    return !!(
      (command &&
        this.db
          .prepare(
            'SELECT 1 FROM codex_capacity_continuations WHERE conversation_id=? AND (command_id=? OR source_command_id=?)',
          )
          .get(id, command.id, command.id)) ||
      this.db
        .prepare(
          "SELECT 1 FROM codex_capacity_recoveries WHERE conversation_id=? AND json_extract(data,'$.status') IN ('waiting','queued','running')",
        )
        .get(id) ||
      this.db
        .prepare('SELECT 1 FROM codex_pending_thread_dispatches WHERE conversation_id=?')
        .get(id) ||
      this.db
        .prepare(
          'SELECT 1 FROM codex_thread_acceptances WHERE conversation_id=? AND ownership_pending=1',
        )
        .get(id) ||
      (command &&
        this.db
          .prepare(
            'SELECT 1 FROM codex_thread_acceptances WHERE conversation_id=? AND command_id=? AND attempt=?',
          )
          .get(id, command.id, command.attempt))
    );
  }
  retryLatestFailed(
    id: string,
    b: AccountBinding,
    now = Date.now(),
    confirmAmbiguous = false,
  ): 'queued' | 'not_found' | 'too_early' | 'not_retryable' | 'confirmation_required' {
    return this.db.transaction(() => {
      this.read(id, b);
      // A pending replacement still owns this exact attempt. Retry must not
      // mutate its identity before admission or ownership reconciliation.
      if (this.retryFenced(id)) return 'not_retryable';
      const row = this.db
        .prepare(
          `SELECT id,attempt,retry_not_before,retryable,ambiguous
          FROM codex_commands
          WHERE conversation_id=? AND status='failed' AND recovery_acknowledged=0
          ORDER BY sequence DESC LIMIT 1`,
        )
        .get(id) as
        | {
            id: string;
            attempt: number;
            retry_not_before: number | null;
            retryable: number | null;
            ambiguous: number | null;
          }
        | undefined;
      if (!row) return 'not_found';
      // A durable native ACK is not a failed dispatch, including ledgers written
      // by older transport callbacks. Ownership repair cannot authorize replay.
      if (this.retryFenced(id, row)) return 'not_retryable';
      if (row.retryable !== 1) return 'not_retryable';
      if (row.retry_not_before && now < row.retry_not_before) return 'too_early';
      if (row.ambiguous === 1 && !confirmAmbiguous) return 'confirmation_required';
      this.db
        .prepare(
          "UPDATE codex_commands SET status='queued', recovery_acknowledged=1, retry_not_before=NULL, attempt=attempt+1 WHERE conversation_id=? AND id=? AND status='failed'",
        )
        .run(id, row.id);
      return 'queued';
    })();
  }
  private nativeExecutions(raw: string | null): CodexNativeExecutionReceipt[] {
    if (raw === null) return [];
    if (Buffer.byteLength(raw) > 512 * 1024)
      throw Error('Native execution history capacity exceeded');
    return NativeExecutionHistorySchema.parse(JSON.parse(raw));
  }
  private saveNativeExecutions(
    id: string,
    commandId: string,
    history: CodexNativeExecutionReceipt[],
  ) {
    const value = JSON.stringify(NativeExecutionHistorySchema.parse(history));
    if (Buffer.byteLength(value) > 512 * 1024)
      throw Error('Native execution history capacity exceeded');
    const result = this.db
      .prepare(
        'UPDATE codex_commands SET native_execution_history=? WHERE conversation_id=? AND id=?',
      )
      .run(value, id, commandId);
    if (result.changes !== 1) throw Error('Native execution command unavailable');
  }
  /** Private observations only. The current trusted runtime owner must assert its
   * existing binding before preparing/reading/accepting or using this receipt.
   * This history is not a permission grant or authorization to replay an RPC. */
  readNativeExecutionHistory(
    id: string,
    b: AccountBinding,
    commandId: string,
  ): CodexNativeExecutionReceipt[] {
    this.read(id, b);
    const row = this.db
      .prepare(
        'SELECT native_execution_history FROM codex_commands WHERE conversation_id=? AND id=?',
      )
      .get(id, commandId) as { native_execution_history: string | null } | undefined;
    return row ? this.nativeExecutions(row.native_execution_history) : [];
  }
  readNativeExecution(
    id: string,
    b: AccountBinding,
    command: Pick<CodexCommand, 'id' | 'attempt'>,
  ): CodexNativeExecutionReceipt | undefined {
    return this.readNativeExecutionHistory(id, b, command.id).find(
      (receipt) => receipt.attempt === command.attempt,
    );
  }
  prepareNativeExecution(
    id: string,
    b: AccountBinding,
    command: Pick<CodexCommand, 'id' | 'attempt'>,
    threadId: string,
    policy: CodexNativeExecutionPolicy,
  ): void {
    this.db.transaction(() => {
      const state = this.read(id, b);
      const active = this.db
        .prepare(
          'SELECT status,attempt,native_turns FROM codex_commands WHERE conversation_id=? AND id=?',
        )
        .get(id, command.id) as
        { status: string; attempt: number; native_turns: string | null } | undefined;
      if (active?.status !== 'running' || active.attempt !== command.attempt)
        throw Error('Native execution preparation identity changed');
      const pending = this.db
        .prepare(
          'SELECT parent_thread_id,thread_id,command_id,attempt,parent_generation FROM codex_pending_thread_dispatches WHERE conversation_id=?',
        )
        .get(id) as
        | {
            parent_thread_id: string | null;
            thread_id: string;
            command_id: string;
            attempt: number;
            parent_generation: number | null;
          }
        | undefined;
      let generation = state.threadGeneration;
      let replacement: { parentThreadId: string | null; parentGeneration: number } | undefined;
      if (pending) {
        if (
          pending.parent_thread_id !== (state.threadId ?? null) ||
          pending.parent_generation !== state.threadGeneration ||
          pending.thread_id !== threadId ||
          pending.command_id !== command.id ||
          pending.attempt !== command.attempt ||
          pending.thread_id === pending.parent_thread_id
        )
          throw Error('Native execution pending replacement identity or generation changed');
        replacement = {
          parentThreadId: pending.parent_thread_id,
          parentGeneration: state.threadGeneration,
        };
        generation += pending.parent_thread_id === null ? 0 : 1;
      } else if (state.threadId !== threadId)
        throw Error('Native execution preparation thread changed');
      const snapshot = NativeExecutionPolicySnapshotSchema.parse(policy);
      const history = this.readNativeExecutionHistory(id, b, command.id);
      const existing = history.find((receipt) => receipt.attempt === command.attempt);
      if (existing) {
        if (
          existing.threadId !== threadId ||
          existing.generation !== generation ||
          (pending && !isDeepStrictEqual(existing.replacement, replacement)) ||
          !isDeepStrictEqual(existing.policy, snapshot)
        )
          throw Error('Native execution preparation changed');
        return;
      }
      if (
        this.nativeTurns(active.native_turns).some((turn) => turn.attempt === command.attempt) ||
        this.db
          .prepare(
            'SELECT 1 FROM codex_capacity_native_acks WHERE conversation_id=? AND command_id=? AND attempt=?',
          )
          .get(id, command.id, command.attempt) ||
        this.db
          .prepare(
            'SELECT 1 FROM codex_thread_acceptances WHERE conversation_id=? AND command_id=? AND attempt=?',
          )
          .get(id, command.id, command.attempt)
      )
        throw Error('Native execution policy was not prepared before acknowledgement');
      const receipt = NativeExecutionReceiptSchema.parse({
        version: 1,
        phase: 'prepared',
        attempt: command.attempt,
        threadId,
        generation,
        ...(replacement ? { replacement } : {}),
        policy: snapshot,
        preparedAt: Date.now(),
      });
      this.saveNativeExecutions(id, command.id, [...history, receipt]);
    })();
  }
  /** Link an existing parsed native ACK. A caller-supplied turn string, queued
   * command or prepared base profile cannot create native turn acceptance. */
  acceptNativeExecution(
    id: string,
    b: AccountBinding,
    command: Pick<CodexCommand, 'id' | 'attempt'>,
    threadId: string,
    turnId: string,
  ): void {
    this.db.transaction(() => {
      const state = this.read(id, b);
      const active = this.db
        .prepare(
          'SELECT status,attempt,native_turns FROM codex_commands WHERE conversation_id=? AND id=?',
        )
        .get(id, command.id) as
        { status: string; attempt: number; native_turns: string | null } | undefined;
      if (
        active?.status !== 'running' ||
        active.attempt !== command.attempt ||
        state.threadId !== threadId
      )
        throw Error('Native execution acknowledgement identity changed');
      // NativeTurnTarget intentionally hides ownership-pending turns from control
      // authority. This observation links only its exact already-persisted ACK.
      const targets = this.nativeTurns(active.native_turns).filter(
        (turn) => turn.attempt === command.attempt,
      );
      const target = targets[0];
      if (
        targets.length !== 1 ||
        target.threadId !== threadId ||
        target.turnId !== turnId ||
        target.generation !== state.threadGeneration
      )
        throw Error('Native execution acknowledgement unavailable or changed');
      const ownership = this.pendingThreadOwnership(id, b);
      if (
        ownership &&
        (ownership.commandId !== command.id ||
          ownership.attempt !== command.attempt ||
          ownership.threadId !== threadId ||
          ownership.turnId !== turnId ||
          ownership.generation !== target.generation)
      )
        throw Error('Native execution pending ownership changed');
      const history = this.readNativeExecutionHistory(id, b, command.id);
      const existing = history.find((receipt) => receipt.attempt === command.attempt);
      if (!existing || existing.threadId !== threadId || existing.generation !== target.generation)
        throw Error('Native execution preparation unavailable or changed');
      if (existing.replacement) {
        const origin = existing.replacement;
        const accepted = this.readThreadAcceptances(id, b).filter(
          (receipt) => receipt.commandId === command.id && receipt.attempt === command.attempt,
        );
        const lineage = this.db
          .prepare(
            'SELECT thread_id,parent_thread_id FROM codex_thread_generations WHERE conversation_id=? AND generation=?',
          )
          .get(id, target.generation) as
          { thread_id: string; parent_thread_id: string | null } | undefined;
        const parent =
          origin.parentThreadId === null
            ? undefined
            : (this.db
                .prepare(
                  'SELECT thread_id FROM codex_thread_generations WHERE conversation_id=? AND generation=?',
                )
                .get(id, origin.parentGeneration) as { thread_id: string } | undefined);
        if (
          target.generation !==
            origin.parentGeneration + (origin.parentThreadId === null ? 0 : 1) ||
          lineage?.thread_id !== threadId ||
          lineage.parent_thread_id !== origin.parentThreadId ||
          (origin.parentThreadId !== null && parent?.thread_id !== origin.parentThreadId) ||
          accepted.length !== 1 ||
          accepted[0].threadId !== threadId ||
          accepted[0].turnId !== turnId ||
          accepted[0].generation !== target.generation ||
          accepted[0].terminalConflict
        )
          throw Error('Native execution replacement acknowledgement or lineage changed');
      }
      if (existing.phase === 'accepted') {
        if (existing.turnId !== turnId) throw Error('Native execution acknowledgement changed');
        return;
      }
      const accepted = NativeExecutionReceiptSchema.parse({
        ...existing,
        phase: 'accepted',
        turnId,
        acceptedAt: Date.now(),
      });
      this.saveNativeExecutions(
        id,
        command.id,
        history.map((receipt) => (receipt === existing ? accepted : receipt)),
      );
    })();
  }
  private nativeTurns(raw: string | null) {
    if (raw === null) return [] as z.infer<typeof NativeTurnHistorySchema>;
    if (Buffer.byteLength(raw) > 64 * 1024) throw Error('Native turn history unavailable');
    return NativeTurnHistorySchema.parse(JSON.parse(raw));
  }
  private saveNativeTurns(
    id: string,
    commandId: string,
    turns: z.infer<typeof NativeTurnHistorySchema>,
  ) {
    const value = JSON.stringify(NativeTurnHistorySchema.parse(turns));
    if (Buffer.byteLength(value) > 64 * 1024) throw Error('Native turn history capacity exceeded');
    this.db
      .prepare('UPDATE codex_commands SET native_turns=? WHERE conversation_id=? AND id=?')
      .run(value, id, commandId);
  }
  /** Actual parsed turn/start ACK only, independent of capacity or thread adoption.
   * Legacy missing records remain unknown. No caller-provided command input can
   * populate this private column; original input/idempotency bytes stay intact. */
  recordNativeTurnAck(
    id: string,
    b: AccountBinding,
    command: CodexCommand,
    threadId: string,
    turnId: string,
  ) {
    this.db.transaction(() => {
      const current = this.read(id, b);
      const row = this.db
        .prepare(
          'SELECT status,attempt,native_turns FROM codex_commands WHERE conversation_id=? AND id=?',
        )
        .get(id, command.id) as
        { status: string; attempt: number; native_turns: string | null } | undefined;
      if (
        !row ||
        row.status !== 'running' ||
        row.attempt !== command.attempt ||
        current.threadId !== threadId
      )
        throw Error('Native turn acknowledgement identity changed');
      const parsed = CodexNativeTurnTargetSchema.parse({
        commandId: command.id,
        attempt: command.attempt,
        threadId,
        turnId,
        generation: current.threadGeneration,
      });
      const target = {
        attempt: parsed.attempt,
        threadId: parsed.threadId,
        turnId: parsed.turnId,
        generation: parsed.generation,
      };
      let turns: z.infer<typeof NativeTurnHistorySchema>;
      try {
        turns = this.nativeTurns(row.native_turns);
      } catch {
        // This control metadata is not capacity or ordinary turn acceptance.
        // Preserve malformed/unknown custody; never replace it with a new grant.
        return;
      }
      const existing = turns.filter((t) => t.attempt === command.attempt);
      if (existing.length > 1) throw Error('Native turn acknowledgement is ambiguous');
      if (existing.length) {
        const original = this.nativeTarget(command.id, existing[0]);
        if (!isDeepStrictEqual(original, parsed))
          throw Error('Native turn acknowledgement changed');
        return;
      }
      const appended = [...turns, target];
      if (
        !NativeTurnHistorySchema.safeParse(appended).success ||
        Buffer.byteLength(JSON.stringify(appended)) > 64 * 1024
      )
        return;
      this.saveNativeTurns(id, command.id, appended);
    })();
  }
  private nativeTarget(
    commandId: string,
    value: z.infer<typeof NativeTurnHistorySchema>[number],
  ): CodexNativeTurnTarget {
    return {
      commandId,
      attempt: value.attempt,
      threadId: value.threadId,
      turnId: value.turnId,
      generation: value.generation,
    };
  }
  nativeTurnTarget(
    id: string,
    b: AccountBinding,
    commandId: string,
    attempt: number,
  ): CodexNativeTurnTarget | undefined {
    const current = this.read(id, b);
    const row = this.db
      .prepare(
        'SELECT status,attempt,native_turns FROM codex_commands WHERE conversation_id=? AND id=?',
      )
      .get(id, commandId) as
      { status: string; attempt: number; native_turns: string | null } | undefined;
    if (!row || row.status !== 'running' || row.attempt !== attempt) return;
    const targets = this.nativeTurns(row.native_turns).filter((t) => t.attempt === attempt);
    if (targets.length !== 1) return;
    if (
      targets[0].threadId !== current.threadId ||
      targets[0].generation !== current.threadGeneration
    )
      return;
    if (this.pendingThreadOwnership(id, b)) return;
    return this.nativeTarget(commandId, targets[0]);
  }
  /** Post-terminal correlation, never a revived callback or read capability.
   * A later nonqueued command prevents adopting an earlier task behind it. */
  completedNativeTurnTarget(
    id: string,
    binding: AccountBinding,
  ): CodexNativeTurnTarget | undefined {
    const state = this.read(id, binding);
    if (state.recovery || this.pendingThreadOwnership(id, binding)) return;
    const row = this.db
      .prepare(
        `SELECT id,status,attempt,native_turns FROM codex_commands
      WHERE conversation_id=? AND status!='queued' ORDER BY sequence DESC LIMIT 1`,
      )
      .get(id) as
      { id: string; status: string; attempt: number; native_turns: string | null } | undefined;
    if (!row || row.status !== 'completed') return;
    const turns = this.nativeTurns(row.native_turns).filter((turn) => turn.attempt === row.attempt);
    if (turns.length !== 1) return;
    const target = this.nativeTarget(row.id, turns[0]);
    const receipt = this.readNativeExecution(id, binding, { id: row.id, attempt: row.attempt });
    if (
      target.threadId !== state.threadId ||
      target.generation !== state.threadGeneration ||
      target.turnId !== state.lastCompletedTurnId ||
      receipt?.phase !== 'accepted' ||
      receipt.threadId !== target.threadId ||
      receipt.turnId !== target.turnId ||
      receipt.generation !== target.generation
    )
      return;
    this.assertNoPendingThreadDispatch(id, binding);
    return Object.freeze(target);
  }
  completedPreparedRepositoryResultSha256(
    id: string,
    binding: AccountBinding,
    target: Readonly<CodexNativeTurnTarget>,
    callId: string,
    requestHash: string,
  ): string {
    if (!isDeepStrictEqual(this.completedNativeTurnTarget(id, binding), target))
      throw Error('Completed prepared repository target changed');
    const identity = {
      turnId: target.turnId,
      toolName: 'PrepareLocalRepository' as const,
      requestHash,
    };
    const result = this.replayToolResult(id, binding, target.commandId, callId, identity);
    if (!result || result.isError) throw Error('Completed prepared repository result unavailable');
    const resultSha256 = preparedRepositoryResultSha256(result);
    this.assertCompletedPreparedRepositorySource(id, binding, {
      ...target,
      ...identity,
      callId,
      resultSha256,
    });
    return resultSha256;
  }
  targetedInterruptReceipt(
    id: string,
    b: AccountBinding,
    requestId: string,
  ): CodexTargetedInterruptReceipt | undefined {
    this.read(id, b);
    z.string().min(1).max(200).parse(requestId);
    const rows = this.db
      .prepare(
        `SELECT c.id,c.native_turns FROM codex_commands c
      WHERE c.conversation_id=? AND c.native_turns IS NOT NULL AND EXISTS (
        SELECT 1 FROM json_each(c.native_turns) t WHERE json_extract(t.value,'$.interruptRequestId')=?) LIMIT 2`,
      )
      .all(id, requestId) as Array<{ id: string; native_turns: string }>;
    if (rows.length > 1) throw Error('Interruption request identity is ambiguous');
    if (!rows.length) return;
    const turns = this.nativeTurns(rows[0].native_turns).filter(
      (t) => t.interruptRequestId === requestId,
    );
    if (turns.length !== 1) throw Error('Interruption request identity is ambiguous');
    return { requestId, target: this.nativeTarget(rows[0].id, turns[0]), disposition: 'claimed' };
  }
  /** Local target CAS and one-way cancellation claim under the existing command
   * owner's writer lock. A claim is not proof of RPC send or terminal settlement. */
  claimTargetedInterrupt(
    id: string,
    b: AccountBinding,
    requestId: string,
    rawTarget: CodexNativeTurnTarget,
  ) {
    const target = CodexNativeTurnTargetSchema.parse(rawTarget);
    z.string().min(1).max(200).parse(requestId);
    return this.db
      .transaction(() => {
        const previous = this.targetedInterruptReceipt(id, b, requestId);
        if (previous) {
          if (!isDeepStrictEqual(previous.target, target))
            throw Error('Interruption request reused with a different target');
          return { fresh: false, receipt: previous };
        }
        if (
          !isDeepStrictEqual(this.nativeTurnTarget(id, b, target.commandId, target.attempt), target)
        )
          return;
        const row = this.db
          .prepare('SELECT native_turns FROM codex_commands WHERE conversation_id=? AND id=?')
          .get(id, target.commandId) as { native_turns: string };
        const turns = this.nativeTurns(row.native_turns);
        const accepted = turns.find((t) =>
          isDeepStrictEqual(this.nativeTarget(target.commandId, t), target),
        );
        if (!accepted) return;
        if (accepted.interruptRequestId)
          throw Error('Native turn already has an interruption claim');
        accepted.interruptRequestId = requestId;
        this.saveNativeTurns(id, target.commandId, turns);
        this.pauseForRecovery(id, b);
        return { fresh: true, receipt: { requestId, target, disposition: 'claimed' as const } };
      })
      .immediate();
  }
  recordCapacityAck(
    id: string,
    b: AccountBinding,
    command: CodexCommand,
    thread: string,
    turn: string,
  ) {
    this.db.transaction(() => {
      const current = this.read(id, b);
      const saved = this.commands(id, b).find((c) => c.id === command.id);
      if (
        !turn ||
        current.threadId !== thread ||
        saved?.status !== 'running' ||
        saved.attempt !== command.attempt
      )
        throw new Error('Capacity native acknowledgment identity changed');
      this.db
        .prepare(
          'INSERT INTO codex_capacity_native_acks(conversation_id,command_id,attempt,thread_id,turn_id,generation,accepted_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(id, command.id, command.attempt, thread, turn, current.threadGeneration, Date.now());
    })();
  }
  capacityRecovery(id: string, b: AccountBinding): CapacityRecovery | undefined {
    this.read(id, b);
    const row = this.db
      .prepare('SELECT data FROM codex_capacity_recoveries WHERE conversation_id=?')
      .get(id) as { data: string } | undefined;
    return row ? CapacityRecoverySchema.parse(JSON.parse(row.data)) : undefined;
  }
  private writeCapacityRecovery(id: string, value: CapacityRecovery) {
    value.revision += 1;
    this.db
      .prepare(
        'INSERT INTO codex_capacity_recoveries(conversation_id,data) VALUES (?,?) ON CONFLICT(conversation_id) DO UPDATE SET data=excluded.data',
      )
      .run(id, JSON.stringify(CapacityRecoverySchema.parse(value)));
  }
  private capacityArtifactIdentity(id: string, b: AccountBinding): string {
    const artifact = this.readArtifactRuntime(id, b);
    if (!artifact) return 'host';
    const runtime = { ...artifact.runtime };
    delete runtime.created;
    delete runtime.resourceVersion;
    return createHash('sha256')
      .update(JSON.stringify({ runtime, route: artifact.route }))
      .digest('hex');
  }
  assertCapacityIdentity(id: string, b: AccountBinding, recovery: CapacityRecovery) {
    const current = this.read(id, b);
    this.assertNoPendingThreadDispatch(id, b);
    this.assertNoPendingThreadOwnership(id, b);
    const owner = this.db
      .prepare('SELECT owner_kind FROM codex_conversations WHERE id=?')
      .get(id) as { owner_kind: string };
    if (
      owner.owner_kind !== 'ordinary' ||
      current.recoveryStrategy !== 'resume' ||
      current.threadId !== recovery.threadId ||
      current.threadGeneration !== recovery.generation ||
      current.toolSurfaceRevision !== recovery.toolSurfaceRevision ||
      current.webSearchGrantRevision !== recovery.webSearchRevision ||
      this.capacityArtifactIdentity(id, b) !== recovery.artifactIdentity
    )
      throw new Error('Capacity recovery identity changed');
  }
  /** Called only for an exact accepted native capacity terminal, never an RPC rejection. */
  recordCapacityFailure(
    id: string,
    b: AccountBinding,
    command: CodexCommand,
    thread: string,
    turn: string,
    now = Date.now(),
  ): CapacityRecovery {
    return this.db.transaction(() => {
      const current = this.read(id, b);
      if (!thread || !turn || current.threadId !== thread)
        throw new Error('Capacity recovery identity changed');
      const saved = this.commands(id, b).find((c) => c.id === command.id);
      if (saved?.status !== 'failed' || saved.attempt !== command.attempt)
        throw new Error('Capacity terminal command changed');
      const ack = this.db
        .prepare(
          'SELECT thread_id,turn_id,generation FROM codex_capacity_native_acks WHERE conversation_id=? AND command_id=? AND attempt=?',
        )
        .get(id, command.id, command.attempt) as
        { thread_id: string; turn_id: string; generation: number } | undefined;
      if (
        !ack ||
        ack.thread_id !== thread ||
        ack.turn_id !== turn ||
        ack.generation !== current.threadGeneration
      )
        throw new Error('Capacity source lacks an exact native acknowledgment');
      const previous = this.capacityRecovery(id, b);
      const continuation = this.capacityContinuation(id, b, command.id);
      if (continuation) {
        if (
          !previous ||
          previous.id !== continuation.recoveryId ||
          previous.childCommandId !== command.id ||
          !['running', 'stopped'].includes(previous.status)
        )
          throw new Error('Capacity recovery episode changed');
        this.assertCapacityIdentity(id, b, previous);
      }
      const recovery: CapacityRecovery =
        continuation && previous
          ? { ...previous }
          : {
              revision: 0,
              id: randomUUID(),
              sourceCommandId: command.id,
              status: 'waiting',
              attempts: 0,
              maxAttempts: 5,
              latestCommandId: command.id,
              latestAttempt: command.attempt,
              latestTurnId: turn,
              threadId: thread,
              generation: current.threadGeneration,
              model: command.model ?? b.model,
              ...(command.reasoningEffort !== undefined
                ? { reasoningEffort: command.reasoningEffort }
                : {}),
              toolSurfaceRevision: current.toolSurfaceRevision,
              webSearchRevision: current.webSearchGrantRevision,
              artifactIdentity: this.capacityArtifactIdentity(id, b),
            };
      this.assertCapacityIdentity(id, b, recovery);
      delete recovery.supersedingCommandId;
      recovery.latestCommandId = command.id;
      recovery.latestAttempt = command.attempt;
      recovery.latestTurnId = turn;
      recovery.childCommandId = undefined;
      recovery.status =
        previous?.status === 'stopped' && continuation
          ? 'stopped'
          : recovery.attempts >= 5
            ? 'exhausted'
            : 'waiting';
      recovery.nextRetryAt = recovery.status === 'waiting' ? now + 30_000 : undefined;
      this.db
        .prepare(
          `INSERT INTO codex_capacity_continuations(conversation_id,command_id,source_command_id,recovery_id,ordinal,thread_id,turn_id,dispatched,terminal) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id,command_id) DO UPDATE SET turn_id=excluded.turn_id,terminal=excluded.terminal`,
        )
        .run(
          id,
          command.id,
          recovery.sourceCommandId,
          recovery.id,
          continuation?.ordinal ?? 0,
          thread,
          turn,
          1,
          'capacity',
        );
      this.writeCapacityRecovery(id, recovery);
      return recovery;
    })();
  }
  capacityContinuation(
    id: string,
    b: AccountBinding,
    commandId: string,
  ): CapacityContinuation | undefined {
    this.read(id, b);
    return this.db
      .prepare(
        `SELECT source_command_id AS sourceCommandId,recovery_id AS recoveryId,ordinal,thread_id AS threadId,turn_id AS turnId,dispatched,terminal FROM codex_capacity_continuations WHERE conversation_id=? AND command_id=? AND ordinal>0`,
      )
      .get(id, commandId) as CapacityContinuation | undefined;
  }
  private capacityRequiresInspection(id: string, sourceCommandId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM codex_capacity_continuations WHERE conversation_id=? AND source_command_id=? AND ordinal>0 AND dispatched=1 AND (terminal IS NULL OR terminal NOT IN ('capacity','completed'))",
      )
      .get(id, sourceCommandId);
  }
  queueCapacityRetry(
    id: string,
    b: AccountBinding,
    recoveryId: string,
    sourceCommandId: string,
    now = Date.now(),
    manual = false,
  ): CodexCommandInput {
    return this.db.transaction(() => {
      const recovery = this.capacityRecovery(id, b);
      if (!recovery || recovery.id !== recoveryId || recovery.sourceCommandId !== sourceCommandId)
        throw new Error('Capacity recovery episode changed');
      this.assertCapacityIdentity(id, b, recovery);
      if (recovery.status === 'queued' || recovery.status === 'running')
        throw new Error('Capacity recovery already active');
      if (!manual && recovery.status === 'exhausted')
        throw new Error('Capacity recovery exhausted');
      if (!manual && (recovery.status !== 'waiting' || now < (recovery.nextRetryAt ?? Infinity)))
        throw new Error('Capacity recovery must wait');
      if (this.capacityRequiresInspection(id, recovery.sourceCommandId))
        throw new Error('Capacity recovery requires inspection of an uncertain continuation');
      const source = this.commands(id, b).find((c) => c.id === recovery.latestCommandId);
      const sourceProof = this.db
        .prepare(
          'SELECT terminal,turn_id FROM codex_capacity_continuations WHERE conversation_id=? AND command_id=?',
        )
        .get(id, recovery.latestCommandId) as { terminal: string; turn_id: string } | undefined;
      if (
        source?.status !== 'failed' ||
        source.attempt !== recovery.latestAttempt ||
        sourceProof?.terminal !== 'capacity' ||
        sourceProof.turn_id !== recovery.latestTurnId ||
        this.commands(id, b).some((c) => c.status === 'running')
      )
        throw new Error('Capacity recovery source is not a verified idle failure');
      if (manual && (recovery.status === 'exhausted' || recovery.status === 'stopped')) {
        recovery.id = randomUUID();
        recovery.attempts = 0;
      }
      const child = {
        id: randomUUID(),
        prompt: 'Continue saved work after provider capacity failure.',
        model: recovery.model,
        ...(recovery.reasoningEffort !== undefined
          ? { reasoningEffort: recovery.reasoningEffort }
          : {}),
      };
      this.enqueue(id, b, child);
      this.db
        .prepare(
          'INSERT INTO codex_capacity_continuations(conversation_id,command_id,source_command_id,recovery_id,ordinal,thread_id,dispatched) VALUES (?,?,?,?,?,?,0)',
        )
        .run(
          id,
          child.id,
          recovery.sourceCommandId,
          recovery.id,
          recovery.attempts + 1,
          recovery.threadId,
        );
      recovery.childCommandId = child.id;
      recovery.status = 'queued';
      recovery.nextRetryAt = undefined;
      this.writeCapacityRecovery(id, recovery);
      // This is a new linked command, not acknowledgment or replay of old work.
      this.db
        .prepare(
          "UPDATE codex_conversations SET recovery=0,automatic_recovery=0,recovery_strategy='resume' WHERE id=?",
        )
        .run(id);
      return child;
    })();
  }
  cancelUndispatchedCapacityContinuation(id: string, b: AccountBinding, commandId: string) {
    this.db.transaction(() => {
      this.read(id, b);
      const recovery = this.capacityRecovery(id, b);
      const child = this.capacityContinuation(id, b, commandId);
      if (!recovery || recovery.childCommandId !== commandId || !child || child.dispatched)
        throw new Error('Capacity continuation is not safely cancellable');
      const update = this.db
        .prepare(
          "UPDATE codex_commands SET status='cancelled' WHERE conversation_id=? AND id=? AND status IN ('queued','running')",
        )
        .run(id, commandId);
      if (!update.changes) throw new Error('Capacity continuation changed before cancellation');
      this.stopCapacityRecovery(id, b, recovery.id, recovery.sourceCommandId);
    })();
  }
  beginCapacityDispatch(id: string, b: AccountBinding, commandId: string) {
    this.db.transaction(() => {
      const recovery = this.capacityRecovery(id, b);
      if (!recovery || recovery.status !== 'running' || recovery.childCommandId !== commandId)
        throw new Error('Capacity recovery dispatch changed');
      this.assertCapacityIdentity(id, b, recovery);
      const command = this.commands(id, b).find((c) => c.id === commandId);
      if (command?.status !== 'running')
        throw new Error('Capacity recovery command is not running');
      const update = this.db
        .prepare(
          'UPDATE codex_capacity_continuations SET dispatched=1 WHERE conversation_id=? AND command_id=? AND dispatched=0 AND ordinal=?',
        )
        .run(id, commandId, recovery.attempts + 1);
      if (update.changes !== 1 || recovery.attempts >= 5)
        throw new Error('Capacity recovery dispatch already reserved');
      recovery.attempts += 1;
      this.writeCapacityRecovery(id, recovery);
    })();
  }
  acceptCapacityTurn(
    id: string,
    b: AccountBinding,
    commandId: string,
    thread: string,
    turn: string,
  ) {
    this.db.transaction(() => {
      const recovery = this.capacityRecovery(id, b);
      if (
        !recovery ||
        !['running', 'stopped'].includes(recovery.status) ||
        recovery.childCommandId !== commandId ||
        thread !== recovery.threadId ||
        !turn
      )
        throw new Error('Capacity acceptance changed');
      this.assertCapacityIdentity(id, b, recovery);
      const result = this.db
        .prepare(
          'UPDATE codex_capacity_continuations SET turn_id=? WHERE conversation_id=? AND command_id=? AND dispatched=1 AND turn_id IS NULL',
        )
        .run(turn, id, commandId);
      if (result.changes !== 1) throw new Error('Capacity acceptance already recorded');
    })();
  }
  conflictCapacityTurn(id: string, b: AccountBinding, thread: string, turn: string) {
    this.read(id, b);
    const result = this.db
      .prepare(
        "UPDATE codex_capacity_continuations SET terminal='conflict' WHERE conversation_id=? AND thread_id=? AND turn_id=?",
      )
      .run(id, thread, turn);
    if (result.changes) {
      const recovery = this.capacityRecovery(id, b);
      if (recovery) this.stopCapacityRecovery(id, b, recovery.id, recovery.sourceCommandId);
    }
  }
  completeCapacityTurn(
    id: string,
    b: AccountBinding,
    commandId: string,
    turn: string,
    status: string,
  ): boolean {
    return this.db.transaction(() => {
      const child = this.capacityContinuation(id, b, commandId);
      if (!child) return false;
      this.db
        .prepare(
          'UPDATE codex_capacity_continuations SET terminal=?,turn_id=? WHERE conversation_id=? AND command_id=?',
        )
        .run(status, turn, id, commandId);
      const recovery = this.capacityRecovery(id, b);
      if (!recovery || recovery.childCommandId !== commandId) return false;
      let resumeSupersedingIntent = false;
      if (status === 'completed') {
        const intent =
          recovery.supersedingCommandId &&
          this.db
            .prepare(
              "SELECT 1 FROM codex_commands WHERE conversation_id=? AND id=? AND status='queued'",
            )
            .get(id, recovery.supersedingCommandId);
        const unsettled = this.db
          .prepare(
            "SELECT 1 FROM codex_commands WHERE conversation_id=? AND status IN ('failed','interrupted') AND recovery_acknowledged=0 AND NOT EXISTS (SELECT 1 FROM codex_capacity_continuations lineage JOIN codex_capacity_continuations resolved ON resolved.conversation_id=lineage.conversation_id AND resolved.source_command_id=lineage.source_command_id WHERE lineage.conversation_id=codex_commands.conversation_id AND lineage.command_id=codex_commands.id AND resolved.terminal='completed')",
          )
          .get(id);
        if (
          intent &&
          !unsettled &&
          child.dispatched &&
          child.turnId === turn &&
          this.commands(id, b).find((command) => command.id === commandId)?.status === 'completed'
        ) {
          try {
            this.assertCapacityIdentity(id, b, recovery);
            resumeSupersedingIntent = true;
          } catch {
            /* Uncertain ownership remains fenced for explicit recovery. */
          }
        }
        this.db.prepare('DELETE FROM codex_capacity_recoveries WHERE conversation_id=?').run(id);
        if (resumeSupersedingIntent)
          this.db.prepare('UPDATE codex_conversations SET recovery=0 WHERE id=?').run(id);
      } else {
        delete recovery.supersedingCommandId;
        recovery.status = 'stopped';
        recovery.nextRetryAt = undefined;
        this.writeCapacityRecovery(id, recovery);
      }
      return resumeSupersedingIntent;
    })();
  }
  stopCapacityRecovery(id: string, b: AccountBinding, recoveryId: string, sourceCommandId: string) {
    return this.db.transaction(() => {
      const recovery = this.capacityRecovery(id, b);
      if (!recovery || recovery.id !== recoveryId || recovery.sourceCommandId !== sourceCommandId)
        throw new Error('Capacity recovery episode changed');
      if (recovery.childCommandId)
        this.db
          .prepare(
            "UPDATE codex_commands SET status='cancelled' WHERE conversation_id=? AND id=? AND status='queued'",
          )
          .run(id, recovery.childCommandId);
      delete recovery.supersedingCommandId;
      recovery.status = 'stopped';
      recovery.nextRetryAt = undefined;
      this.writeCapacityRecovery(id, recovery);
      this.db.prepare('UPDATE codex_conversations SET recovery=1 WHERE id=?').run(id);
      return recovery;
    })();
  }
  /** Observe active work without hydrating retained prompts/images. */
  hasRunningCommand(id: string, binding: AccountBinding): boolean {
    this.read(id, binding);
    return (
      this.db
        .prepare(
          "SELECT 1 FROM codex_commands WHERE conversation_id=? AND status='running' LIMIT 1",
        )
        .get(id) !== undefined
    );
  }
  /** Bounded native status observation without hydrating retained prompts/images. */
  commandStatus(
    id: string,
    binding: AccountBinding,
    commandId: string,
  ): CodexCommand['status'] | undefined {
    this.read(id, binding);
    const row = this.db
      .prepare('SELECT status FROM codex_commands WHERE conversation_id=? AND id=?')
      .get(id, commandId) as { status: string } | undefined;
    if (!row) return undefined;
    return z
      .enum(['queued', 'running', 'completed', 'interrupted', 'failed', 'cancelled'])
      .parse(row.status);
  }
  claimNext(id: string, b: AccountBinding): CodexCommand | undefined {
    return this.db.transaction(() => {
      if (this.read(id, b).recovery)
        throw new Error('Codex recovery requires explicit acknowledgement');
      const commands = this.commands(id, b);
      if (commands.some((c) => c.status === 'running'))
        throw new Error('Codex conversation already running');
      const recovery = this.capacityRecovery(id, b);
      if (
        recovery?.status === 'waiting' ||
        recovery?.status === 'running' ||
        recovery?.status === 'exhausted' ||
        recovery?.status === 'stopped'
      )
        return;
      if (recovery?.status === 'queued') this.assertCapacityIdentity(id, b, recovery);
      const next =
        recovery?.status === 'queued'
          ? commands.find((c) => c.id === recovery.childCommandId && c.status === 'queued')
          : commands.find((c) => c.status === 'queued');
      if (!next) return;
      if (next.environmentContinuation) {
        const source = commands.find(
          (command) => command.id === next.environmentContinuation!.sourceCommandId,
        );
        const state = this.read(id, b);
        if (
          source?.status !== 'completed' ||
          state.threadId !== next.environmentContinuation.sourceThreadId ||
          state.threadGeneration !== next.environmentContinuation.sourceGeneration ||
          state.lastCompletedTurnId !== next.environmentContinuation.sourceTurnId
        ) {
          this.db
            .prepare(
              "UPDATE codex_commands SET status='cancelled' WHERE conversation_id=? AND id=? AND status='queued'",
            )
            .run(id, next.id);
          return;
        }
      }
      this.db
        .prepare("UPDATE codex_commands SET status='running' WHERE conversation_id=? AND id=?")
        .run(id, next.id);
      if (recovery?.status === 'queued') {
        recovery.status = 'running';
        this.writeCapacityRecovery(id, recovery);
      }
      return { ...next, status: 'running' as const };
    })();
  }
  finish(
    id: string,
    b: AccountBinding,
    commandId: string,
    status: 'completed' | 'interrupted' | 'failed',
    providerTurnId?: string,
  ) {
    this.db.transaction(() => {
      const current = this.read(id, b);
      const updated = this.db
        .prepare(
          "UPDATE codex_commands SET status=?, recovery_acknowledged=0 WHERE conversation_id=? AND id=? AND status='running'",
        )
        .run(status, id, commandId);
      if (updated.changes === 1 && status === 'completed' && providerTurnId)
        this.db
          .prepare(
            `UPDATE codex_thread_generations SET last_completed_turn_id=?
            WHERE conversation_id=? AND generation=?`,
          )
          .run(providerTurnId, id, current.threadGeneration);
      // A started turn can still fail before it establishes context on the
      // replacement thread. Retire the handoff only with a durable completion.
      if (updated.changes === 1 && status === 'completed' && current.threadId)
        this.db
          .prepare(
            'UPDATE codex_conversations SET rollover_context=NULL WHERE id=? AND thread_id=?',
          )
          .run(id, current.threadId);
    })();
  }
  pauseForRecovery(
    id: string,
    b: AccountBinding,
    commandId?: string,
    status: 'interrupted' | 'failed' = 'interrupted',
    recoveryStrategy: 'resume' | 'fork' = 'resume',
    retryNotBefore?: number,
    retryable = true,
    ambiguous = false,
    automaticRecovery = false,
  ) {
    this.db.transaction(() => {
      this.read(id, b);
      const pending = !!this.db
        .prepare(
          "SELECT 1 FROM codex_commands WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1",
        )
        .get(id);
      if (commandId)
        this.db
          .prepare(
            "UPDATE codex_commands SET status=?, recovery_acknowledged=0, retry_not_before=?, retryable=?, ambiguous=? WHERE conversation_id=? AND id=? AND status='running'",
          )
          .run(status, retryNotBefore ?? null, retryable ? 1 : 0, ambiguous ? 1 : 0, id, commandId);
      if (pending)
        this.db
          .prepare(
            `UPDATE codex_conversations SET recovery=1, automatic_recovery=?,
              recovery_strategy=CASE
                WHEN recovery_strategy='fork' OR ?='fork' THEN 'fork'
                ELSE 'resume'
              END
            WHERE id=?`,
          )
          .run(automaticRecovery ? 1 : 0, recoveryStrategy, id);
    })();
  }
  claimTool(
    id: string,
    b: AccountBinding,
    commandId: string,
    callId: string,
    identity?: { turnId: string; toolName: string; requestHash: string },
  ): boolean {
    return this.db.transaction(() => {
      this.read(id, b);
      if (
        this.db
          .prepare('SELECT 1 FROM codex_tools WHERE conversation_id=? AND call_id=?')
          .get(id, callId)
      )
        return false;
      if (!this.commands(id, b).some((c) => c.id === commandId && c.status === 'running'))
        throw new Error('Codex command is not running');
      this.db
        .prepare(
          `INSERT INTO codex_tools
        (conversation_id,command_id,call_id,turn_id,tool_name,request_hash)
        VALUES (?,?,?,?,?,?)`,
        )
        .run(
          id,
          commandId,
          callId,
          identity?.turnId ?? null,
          identity?.toolName ?? null,
          identity?.requestHash ?? null,
        );
      return true;
    })();
  }
  /** Read-only custody of an already claimed actual native callback. Generic
   * native ACK metadata supplies identity; no capacity row/turn is created here.
   * Only the original verified host-tool entry may capture and retain this proof. */
  pendingNativeHostTool(
    id: string,
    binding: AccountBinding,
    callId: string,
    identity: { turnId: string; toolName: string; requestHash: string },
  ) {
    return this.db.transaction(() => {
      this.read(id, binding);
      const row = this.db
        .prepare(
          `SELECT t.command_id AS commandId,
        t.turn_id AS turnId,t.tool_name AS toolName,t.request_hash AS requestHash,
        t.result_content AS resultContent,t.result_is_error AS resultIsError,c.attempt
        FROM codex_tools t JOIN codex_commands c
        ON c.conversation_id=t.conversation_id AND c.id=t.command_id
        WHERE t.conversation_id=? AND t.call_id=? AND c.status='running'`,
        )
        .get(id, callId) as
        | {
            commandId: string;
            turnId: string | null;
            toolName: string | null;
            requestHash: string | null;
            resultContent: string | null;
            resultIsError: number | null;
            attempt: number;
          }
        | undefined;
      if (
        !row ||
        row.resultContent !== null ||
        row.resultIsError !== null ||
        row.turnId !== identity.turnId ||
        row.toolName !== identity.toolName ||
        row.requestHash !== identity.requestHash
      )
        return;
      const target = this.nativeTurnTarget(id, binding, row.commandId, row.attempt);
      if (!target || target.turnId !== identity.turnId) return;
      return Object.freeze({
        ...target,
        callId,
        toolName: row.toolName,
        requestHash: row.requestHash,
      });
    })();
  }
  /** Verify a completed source without reviving its expired native callback.
   * This does not authorize a read, a workspace change or another provider turn.
   * Old queued work is a hard boundary: never silently retarget that work or
   * place an automatic continuation behind a later explicit user command. */
  assertCompletedPreparedRepositorySource(
    id: string,
    binding: AccountBinding,
    rawSource: CompletedPreparedRepositorySource,
  ): void {
    this.assertPreparedRepositorySource(id, binding, rawSource);
  }
  private assertPreparedRepositorySource(
    id: string,
    binding: AccountBinding,
    rawSource: CompletedPreparedRepositorySource,
    exactQueuedChildId?: string,
  ): void {
    this.db.transaction(() => {
      const source = CompletedPreparedRepositorySourceSchema.parse(rawSource);
      const current = this.read(id, binding);
      const commands = this.commands(id, binding);
      const original = commands.find((command) => command.id === source.commandId);
      const row = this.db
        .prepare(
          'SELECT status,attempt,native_turns FROM codex_commands WHERE conversation_id=? AND id=?',
        )
        .get(id, source.commandId) as
        { status: string; attempt: number; native_turns: string | null } | undefined;
      const fail = () => {
        throw Error('Completed prepared repository source unavailable');
      };
      if (
        !row ||
        row.status !== 'completed' ||
        row.attempt !== source.attempt ||
        current.threadId !== source.threadId ||
        current.threadGeneration !== source.generation ||
        current.lastCompletedTurnId !== source.turnId ||
        current.recovery ||
        commands.some(
          (command) =>
            command.status === 'running' ||
            (command.status === 'queued' && command.id !== exactQueuedChildId),
        ) ||
        !original?.intent?.trim() ||
        original.allowedTools ||
        original.environmentContinuation ||
        commands.filter((command) => command.status !== 'queued').at(-1)?.id !== source.commandId
      )
        fail();
      this.assertNoPendingThreadOwnership(id, binding);
      this.assertNoPendingThreadDispatch(id, binding);
      const targets = this.nativeTurns(row!.native_turns).filter(
        (turn) => turn.attempt === source.attempt,
      );
      if (
        targets.length !== 1 ||
        !isDeepStrictEqual(this.nativeTarget(source.commandId, targets[0]), {
          commandId: source.commandId,
          attempt: source.attempt,
          threadId: source.threadId,
          turnId: source.turnId,
          generation: source.generation,
        })
      )
        fail();
      const receipt = this.readNativeExecution(id, binding, {
        id: source.commandId,
        attempt: source.attempt,
      });
      if (
        receipt?.phase !== 'accepted' ||
        receipt.threadId !== source.threadId ||
        receipt.turnId !== source.turnId ||
        receipt.generation !== source.generation
      )
        fail();
      const result = this.replayToolResult(id, binding, source.commandId, source.callId, source);
      if (
        !result ||
        result.isError ||
        preparedRepositoryResultSha256(result) !== source.resultSha256
      )
        fail();
    })();
  }
  assertQueuedPreparedRepositoryContinuation(
    id: string,
    binding: AccountBinding,
    source: CompletedPreparedRepositorySource,
    rawInput: CodexCommandInput,
  ): void {
    this.db.transaction(() => {
      const input = CommandInput.parse(rawInput);
      if (
        !/^prepared-repository-[a-f0-9]{64}$/.test(input.id) ||
        input.environmentContinuation ||
        input.allowedTools
      )
        throw Error('Prepared repository child identity unavailable');
      const expected = JSON.parse(
        JSON.stringify({
          ...input,
          environmentContinuation: {
            sourceCommandId: source.commandId,
            sourceTurnId: source.turnId,
            sourceThreadId: source.threadId,
            sourceGeneration: source.generation,
          },
        }),
      );
      const child = this.commands(id, binding).find((command) => command.id === input.id);
      if (!child) throw Error('Prepared repository child is not exactly queued');
      const { status, attempt, ...retained } = child;
      if (status !== 'queued' || attempt !== 1)
        throw Error('Prepared repository child is not exactly queued');
      if (!isDeepStrictEqual(retained, expected))
        throw Error('Prepared repository queued child changed');
      this.assertPreparedRepositorySource(id, binding, source, input.id);
    })();
  }
  /** Called only after the existing admission owner consumed the exact prepared
   * child. It shares FIFO's completed-turn/thread-generation fence and can never
   * insert behind old queued work or turn a child into another automatic loop. */
  enqueuePreparedRepositoryContinuation(
    id: string,
    binding: AccountBinding,
    source: CompletedPreparedRepositorySource,
    rawInput: CodexCommandInput,
  ): boolean {
    return this.db.transaction(() => {
      this.assertCompletedPreparedRepositorySource(id, binding, source);
      const input = CommandInput.parse(rawInput);
      const original = this.commands(id, binding).find(
        (command) => command.id === source.commandId,
      );
      if (
        !original?.intent?.trim() ||
        original.allowedTools ||
        original.environmentContinuation ||
        input.intent !== original.intent ||
        input.allowedTools ||
        input.environmentContinuation ||
        !/^prepared-repository-[a-f0-9]{64}$/.test(input.id)
      )
        throw Error('Prepared repository original task continuation unavailable');
      return this.enqueue(id, binding, {
        ...input,
        environmentContinuation: {
          sourceCommandId: source.commandId,
          sourceTurnId: source.turnId,
          sourceThreadId: source.threadId,
          sourceGeneration: source.generation,
        },
      });
    })();
  }
  /** Expected-old primary CAS for the already guarded repository operation.
   * Per-command frozen policy/turn history remains historical and unchanged. */
  adoptPreparedRepositoryWorkspace(
    id: string,
    binding: AccountBinding,
    source: CompletedPreparedRepositorySource,
    expectedCwd: string,
    nextCwd: string,
  ): void {
    this.db.transaction(() => {
      this.assertCompletedPreparedRepositorySource(id, binding, source);
      if (
        !isAbsolute(nextCwd) ||
        resolve(nextCwd) !== nextCwd ||
        nextCwd.includes('\0') ||
        nextCwd === expectedCwd
      )
        throw Error('Prepared repository native workspace invalid');
      const changed = this.db
        .prepare('UPDATE codex_conversations SET cwd=? WHERE id=? AND cwd=?')
        .run(nextCwd, id, expectedCwd);
      if (changed.changes !== 1) throw Error('Prepared repository native workspace changed');
    })();
  }
  /** A completed host result is persisted before it is exposed to the transport.
   * A duplicate RPC can replay exactly the same result after a lost response. */
  recordToolResult(
    id: string,
    b: AccountBinding,
    commandId: string,
    callId: string,
    identity: { turnId: string; toolName: string; requestHash: string },
    result: CodexToolResult,
  ): void {
    const checked = normalizeCodexToolResult(result);
    const items = checked.contentItems ? JSON.stringify(checked.contentItems) : null;
    this.db.transaction(() => {
      this.read(id, b);
      const row = this.db
        .prepare(
          `SELECT command_id,turn_id,tool_name,request_hash,result_content,result_is_error,result_content_items
        FROM codex_tools WHERE conversation_id=? AND call_id=?`,
        )
        .get(id, callId) as
        | {
            command_id: string;
            turn_id: string | null;
            tool_name: string | null;
            request_hash: string | null;
            result_content: string | null;
            result_is_error: number | null;
            result_content_items: string | null;
          }
        | undefined;
      if (
        !row ||
        row.command_id !== commandId ||
        row.turn_id !== identity.turnId ||
        row.tool_name !== identity.toolName ||
        row.request_hash !== identity.requestHash
      )
        throw new Error('Codex tool result identity changed');
      if (row.result_content !== null) {
        if (
          row.result_content !== checked.content ||
          row.result_is_error !== Number(checked.isError) ||
          row.result_content_items !== items
        )
          throw new Error('Codex tool result changed');
        return;
      }
      this.db
        .prepare(
          `UPDATE codex_tools SET result_content=?,result_is_error=?,result_content_items=?
        WHERE conversation_id=? AND command_id=? AND call_id=?`,
        )
        .run(checked.content, Number(checked.isError), items, id, commandId, callId);
    })();
  }
  replayToolResult(
    id: string,
    b: AccountBinding,
    commandId: string,
    callId: string,
    identity: { turnId: string; toolName: string; requestHash: string },
  ): CodexToolResult | null {
    this.read(id, b);
    const row = this.db
      .prepare(
        `SELECT command_id,turn_id,tool_name,request_hash,result_content,result_is_error,result_content_items
      FROM codex_tools WHERE conversation_id=? AND call_id=?`,
      )
      .get(id, callId) as
      | {
          command_id: string;
          turn_id: string | null;
          tool_name: string | null;
          request_hash: string | null;
          result_content: string | null;
          result_is_error: number | null;
          result_content_items: string | null;
        }
      | undefined;
    if (
      !row ||
      row.command_id !== commandId ||
      row.turn_id !== identity.turnId ||
      row.tool_name !== identity.toolName ||
      row.request_hash !== identity.requestHash
    )
      throw new Error('Codex tool replay identity changed');
    if (row.result_content === null) return null;
    if (
      row.result_content_items !== null &&
      Buffer.byteLength(row.result_content_items) > MAX_CODEX_RICH_RESULT_BYTES
    )
      throw Error('Stored tool result exceeds bound');
    return normalizeCodexToolResult({
      content: row.result_content,
      isError: row.result_is_error === 1,
      ...(row.result_content_items !== null
        ? { contentItems: JSON.parse(row.result_content_items) }
        : {}),
    });
  }
  recoverAtStartup(ownerKind?: 'ordinary' | 'symposium') {
    this.db.transaction(() => {
      const rows = this.db
        .prepare(
          'SELECT conversation_id,data FROM codex_capacity_recoveries' +
            (ownerKind === undefined
              ? ''
              : ' WHERE conversation_id IN (SELECT id FROM codex_conversations WHERE owner_kind=?)'),
        )
        .all(...(ownerKind === undefined ? [] : [ownerKind])) as Array<{
        conversation_id: string;
        data: string;
      }>;
      for (const row of rows) {
        const recovery = CapacityRecoverySchema.parse(JSON.parse(row.data));
        if (
          recovery.status === 'waiting' ||
          recovery.status === 'queued' ||
          recovery.status === 'running' ||
          recovery.supersedingCommandId !== undefined
        ) {
          if (recovery.childCommandId)
            this.db
              .prepare(
                "UPDATE codex_commands SET status='cancelled' WHERE conversation_id=? AND id=? AND status='queued'",
              )
              .run(row.conversation_id, recovery.childCommandId);
          delete recovery.supersedingCommandId;
          recovery.status = 'stopped';
          recovery.nextRetryAt = undefined;
          this.writeCapacityRecovery(row.conversation_id, recovery);
          this.db
            .prepare('UPDATE codex_conversations SET recovery=1 WHERE id=?')
            .run(row.conversation_id);
        }
      }

      const scope = ownerKind === undefined ? '' : ' AND owner_kind=?';
      this.db
        .prepare(
          "UPDATE codex_conversations SET recovery=1 WHERE id IN (SELECT conversation_id FROM codex_commands WHERE status IN ('running','queued'))" +
            scope,
        )
        .run(...(ownerKind === undefined ? [] : [ownerKind]));
      this.db
        .prepare(
          "UPDATE codex_commands SET status='interrupted', recovery_acknowledged=0 WHERE status='running'" +
            (ownerKind === undefined
              ? ''
              : ' AND conversation_id IN (SELECT id FROM codex_conversations WHERE owner_kind=?)'),
        )
        .run(...(ownerKind === undefined ? [] : [ownerKind]));
    })();
  }
  automaticRecoveryPending(id: string, b: AccountBinding): boolean {
    this.read(id, b);
    return !!this.db
      .prepare(
        'SELECT 1 FROM codex_conversations WHERE id=? AND recovery=1 AND automatic_recovery=1',
      )
      .get(id);
  }
  stopAutomaticRecovery(id: string, b: AccountBinding) {
    this.read(id, b);
    this.db.prepare('UPDATE codex_conversations SET automatic_recovery=0 WHERE id=?').run(id);
  }
  acknowledgeRecovery(id: string, b: AccountBinding) {
    this.db.transaction(() => {
      this.assertNoPendingThreadDispatch(id, b);
      this.assertNoPendingThreadOwnership(id, b);
      const capacity = this.capacityRecovery(id, b);
      if (capacity && capacity.status !== 'stopped')
        throw new Error('Capacity recovery must be stopped before continuing queued work');
      if (capacity)
        this.db.prepare('DELETE FROM codex_capacity_recoveries WHERE conversation_id=?').run(id);
      this.db
        .prepare(
          "UPDATE codex_commands SET recovery_acknowledged=1 WHERE conversation_id=? AND status IN ('interrupted','failed')",
        )
        .run(id);
      this.db
        .prepare(
          "UPDATE codex_conversations SET recovery=0,automatic_recovery=0,recovery_strategy='resume' WHERE id=?",
        )
        .run(id);
    })();
  }
  close() {
    this.db.close();
  }
}

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { lstatSync, realpathSync, mkdirSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  AccountBindingSchema,
  AgentLibraryVersionSchema,
  OrdinaryWorkspaceSettingsSchema,
  ORDINARY_WORKSPACE_CAPABILITIES,
  type AccountBinding,
  type AgentLibraryVersion,
  type OrdinaryWorkspaceSettings,
} from '@mitzo/protocol';
import { contextDigest } from './agent-context-compiler.js';
import { nativeStartupSessionId } from './ordinary-repository-startup.js';
import {
  OrdinaryRepositoryPreparationSchema,
  OrdinaryRepositoryRuntimeSelectionSchema,
  ordinaryPreparationFingerprint,
  type OrdinaryRepositoryPreparation,
  type OrdinaryRepositoryRuntimeSelection,
} from './ordinary-repository-preparation.js';

interface Readiness {
  capture(
    binding: AccountBinding,
    selection: OrdinaryRepositoryRuntimeSelection,
    signal: AbortSignal,
  ): Promise<OrdinaryRepositoryPreparation>;
  assert(
    proof: OrdinaryRepositoryPreparation,
    binding: AccountBinding,
    signal: AbortSignal,
    requireModelReadiness?: boolean,
    selection?: Pick<OrdinaryWorkspaceSettings['selection'], 'model' | 'thinking'>,
  ): Promise<void>;
}
const identity = z.strictObject({
  dev: z.number().int().nonnegative().safe(),
  ino: z.number().int().nonnegative().safe(),
});
const canonicalPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => isAbsolute(p) && resolve(p) === p);
const preparation = z.strictObject({
  version: z.literal(1),
  kind: z.literal('ordinary'),
  preparationId: z.uuid(),
  proof: OrdinaryRepositoryPreparationSchema,
});
const workspace = z.strictObject({
  version: z.literal(1),
  kind: z.literal('ordinary'),
  id: z.uuid(),
  preparationId: z.uuid(),
  allocationOperationId: z.uuid(),
  preparationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  binding: AccountBindingSchema,
  settings: OrdinaryWorkspaceSettingsSchema,
  agentProfile: AgentLibraryVersionSchema,
  conversationId: z.string().min(1),
  directory: canonicalPath,
  state: z.enum(['reserved', 'claiming', 'claimed']),
  primaryDisposition: z
    .strictObject({
      version: z.literal(1),
      revision: z.number().int().positive().safe(),
      currentConversationId: z.string().min(1).nullable(),
    })
    .optional(),
  sandbox: z.literal(true).optional(),
  hostReservation: z.strictObject({
    version: z.literal(1),
    taskRoot: canonicalPath,
    rootIdentity: identity,
  }),
  taskIdentity: z
    .strictObject({ version: z.literal(1), directory: canonicalPath, root: identity })
    .optional(),
});
export type OrdinaryWorkspaceRecord = z.infer<typeof workspace>;
export interface OrdinaryWorkspaceSelectionInput {
  preparationId: string;
  binding: AccountBinding;
  settings: OrdinaryWorkspaceSettings;
  agentProfile: AgentLibraryVersion;
  /** Trusted operation requirements may only narrow the server-derived capability set. */
  requiredCapabilities?: readonly string[];
  signal: AbortSignal;
}
export interface OrdinaryWorkspaceReservationInput extends OrdinaryWorkspaceSelectionInput {
  allocationOperationId: string;
  taskRoot: string;
}
export interface OrdinaryWorkspaceClaimInput {
  id: string;
  conversationId: string;
  binding: AccountBinding;
  taskRoot: string;
  signal: AbortSignal;
}

function privateDirectory(path: string) {
  canonicalPath.parse(path);
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw Error('Ordinary workspace custody requires a private canonical directory');
  return { dev: info.dev, ino: info.ino };
}
function sameDirectory(path: string, expected: z.infer<typeof identity>) {
  if (!isDeepStrictEqual(privateDirectory(path), expected))
    throw Error('Ordinary workspace custody identity changed');
}

/** Workspace reservations under the existing preparation/allocation owner and
 * its SQLite transaction. Local directories are materialized here; OpenShell
 * physical sandboxes remain exclusively owned by their existing lifecycle manager. */
export class OrdinaryWorkspaceCustody {
  constructor(
    private db: Database.Database,
    private readiness: Readiness | undefined,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS ordinary_workspace_preparations (
      id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ordinary_workspaces (
      id TEXT PRIMARY KEY, record TEXT NOT NULL, conversation_id TEXT UNIQUE);`);
    this.migratePrimaryPointer();
  }
  /** Preserve every historical byte while allowing only the current pointer to retire. */
  private migratePrimaryPointer() {
    this.db
      .transaction(() => {
        const table = this.db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='ordinary_workspaces'",
          )
          .get() as { sql: string } | undefined;
        const knownTable =
          /^CREATE TABLE (?:IF NOT EXISTS )?ordinary_workspaces\s*\(\s*id TEXT PRIMARY KEY\s*,\s*record TEXT NOT NULL\s*,\s*conversation_id TEXT(?: NOT NULL)? UNIQUE\s*\)$/i;
        if (!table || !knownTable.test(table.sql.replace(/\s+/g, ' ').trim()))
          throw Error('Unsupported ordinary custody schema; preserve historical records');
        const columns = this.db.prepare('PRAGMA table_info(ordinary_workspaces)').all() as Array<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
          dflt_value: unknown;
        }>;
        const indexes = this.db.prepare('PRAGMA index_list(ordinary_workspaces)').all() as Array<{
          name: string;
          unique: number;
          origin: string;
          partial: number;
        }>;
        const triggers = this.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='ordinary_workspaces'",
          )
          .all();
        if (
          columns.length !== 3 ||
          columns.some(
            (c, i) =>
              c.name !== ['id', 'record', 'conversation_id'][i] ||
              c.type !== 'TEXT' ||
              c.pk !== (i === 0 ? 1 : 0) ||
              c.dflt_value !== null ||
              c.notnull !== (i === 1 ? 1 : i === 2 ? columns[2].notnull : 0),
          ) ||
          ![0, 1].includes(columns[2].notnull) ||
          triggers.length ||
          indexes.length !== 2 ||
          indexes.some(
            (i) =>
              i.unique !== 1 ||
              i.partial !== 0 ||
              !['pk', 'u'].includes(i.origin) ||
              (
                this.db.prepare('SELECT name FROM pragma_index_info(?)').all(i.name) as Array<{
                  name: string;
                }>
              )
                .map((c) => c.name)
                .join(',') !== (i.origin === 'pk' ? 'id' : 'conversation_id'),
          )
        )
          throw Error('Unsupported ordinary custody schema; preserve historical records');
        if (!columns[2].notnull) return;
        const references = this.db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE name!='ordinary_workspaces' AND sql IS NOT NULL",
          )
          .all() as Array<{ sql: string }>;
        if (references.some((object) => /\bordinary_workspaces\b/i.test(object.sql)))
          throw Error('Unsupported ordinary custody schema; preserve external references');
        this.db.exec(`ALTER TABLE ordinary_workspaces RENAME TO ordinary_workspaces_legacy_primary;
        CREATE TABLE ordinary_workspaces (id TEXT PRIMARY KEY, record TEXT NOT NULL, conversation_id TEXT UNIQUE);
        INSERT INTO ordinary_workspaces SELECT id,record,conversation_id FROM ordinary_workspaces_legacy_primary;
        DROP TABLE ordinary_workspaces_legacy_primary;`);
      })
      .immediate();
  }
  async prepare(input: {
    binding: AccountBinding;
    selection: OrdinaryRepositoryRuntimeSelection;
    signal: AbortSignal;
  }) {
    const binding = AccountBindingSchema.parse(structuredClone(input.binding));
    const selected = OrdinaryRepositoryRuntimeSelectionSchema.parse(
      structuredClone(input.selection),
    );
    input.signal.throwIfAborted();
    if (
      !(selected.runOn === 'local'
        ? ['openai-codex', 'openai', 'anthropic-vertex'].includes(binding.provider)
        : ['openai', 'openai-codex'].includes(binding.provider)) ||
      selected.runtime.harness !==
        (binding.provider === 'anthropic-vertex' ? 'claude-sdk' : 'codex')
    )
      throw Error('Ordinary workspace isolation requires a supported native owner');
    if (
      !isDeepStrictEqual(selected.runtime.account, {
        accountId: binding.accountId,
        provider: binding.provider,
        profileRevision: binding.profileRevision,
      })
    )
      throw Error('Original ordinary workspace account scope required');
    if (!this.readiness) throw Error('Ordinary workspace readiness is unavailable');
    const proof = OrdinaryRepositoryPreparationSchema.parse(
      await this.readiness.capture(binding, selected, input.signal),
    );
    if (
      proof.sourceIdentity ||
      (selected.runOn === 'openshell' && !proof.sandboxWorkdir) ||
      !isDeepStrictEqual(proof.originalBinding, binding) ||
      !isDeepStrictEqual(proof.runtimeBinding.account, selected.runtime.account) ||
      proof.runtimeBinding.harness.implementation !== selected.runtime.harness ||
      proof.runtimeBinding.execution.location !== selected.runOn ||
      proof.runtimeBinding.execution.targetId !== selected.runtime.targetId
    )
      throw Error('Original ordinary workspace readiness scope required');
    await this.readiness.assert(proof, binding, input.signal, true);
    input.signal.throwIfAborted();
    const saved = preparation.parse({
      version: 1,
      kind: 'ordinary',
      preparationId: randomUUID(),
      proof,
    });
    this.db
      .prepare('INSERT INTO ordinary_workspace_preparations VALUES (?,?)')
      .run(saved.preparationId, JSON.stringify(saved));
    return {
      version: 1 as const,
      kind: 'ordinary' as const,
      preparationId: saved.preparationId,
      runtimeBinding: structuredClone(proof.runtimeBinding),
      capabilities: [...ORDINARY_WORKSPACE_CAPABILITIES],
    };
  }
  private readPreparation(id: string) {
    z.uuid().parse(id);
    const row = this.db
      .prepare('SELECT record FROM ordinary_workspace_preparations WHERE id=?')
      .get(id) as { record: string } | undefined;
    if (!row) throw Error('Original ordinary workspace preparation unavailable');
    const saved = preparation.parse(JSON.parse(row.record));
    if (saved.preparationId !== id || saved.proof.sourceIdentity)
      throw Error('Ordinary preparation identity changed');
    return saved;
  }
  private async assertReadiness(
    id: string,
    binding: AccountBinding,
    signal: AbortSignal,
    selection?: Pick<OrdinaryWorkspaceSettings['selection'], 'model' | 'thinking'>,
  ) {
    signal.throwIfAborted();
    const saved = this.readPreparation(id);
    if (!this.readiness || !isDeepStrictEqual(saved.proof.originalBinding, binding))
      throw Error('Original ordinary account and preparation required');
    await this.readiness.assert(
      structuredClone(saved.proof),
      structuredClone(binding),
      signal,
      true,
      selection,
    );
    signal.throwIfAborted();
    if (!isDeepStrictEqual(saved, this.readPreparation(id)))
      throw Error('Ordinary preparation changed');
    return saved;
  }
  get(id: string): OrdinaryWorkspaceRecord {
    z.uuid().parse(id);
    const row = this.db
      .prepare('SELECT record,conversation_id FROM ordinary_workspaces WHERE id=?')
      .get(id) as { record: string; conversation_id: string | null } | undefined;
    if (!row) throw Error('Original ordinary workspace unavailable');
    const value = workspace.parse(JSON.parse(row.record));
    if (
      row.conversation_id !==
        (value.primaryDisposition
          ? value.primaryDisposition.currentConversationId
          : value.conversationId) ||
      (value.primaryDisposition?.currentConversationId !== undefined &&
        value.primaryDisposition.currentConversationId !== null &&
        value.primaryDisposition.currentConversationId !== value.conversationId) ||
      value.id !== id ||
      value.settings.workspace.preparationId !== value.preparationId ||
      value.id === value.conversationId ||
      Boolean(value.sandbox) !== (value.settings.binding.execution.location === 'openshell') ||
      (value.sandbox &&
        (value.directory !== this.readPreparation(value.preparationId).proof.sandboxWorkdir ||
          value.taskIdentity !== undefined))
    )
      throw Error('Ordinary workspace identity changed');
    return value;
  }
  forOperation(operationId: string) {
    z.uuid().parse(operationId);
    const allocation = this.db
      .prepare(
        'SELECT workspace_id,fingerprint FROM ordinary_preparation_allocations WHERE operation_id=?',
      )
      .get(operationId) as { workspace_id: string; fingerprint: string } | undefined;
    if (!allocation) return undefined;
    const record = this.get(allocation.workspace_id);
    if (
      record.allocationOperationId !== operationId ||
      record.preparationFingerprint !== allocation.fingerprint
    )
      throw Error('Ordinary allocation identity changed');
    return record;
  }
  forConversation(conversationId: string) {
    const row = this.db
      .prepare('SELECT id FROM ordinary_workspaces WHERE conversation_id=?')
      .get(conversationId) as { id: string } | undefined;
    if (!row) return undefined;
    if (
      this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='repository_workspaces'",
        )
        .get() &&
      this.db
        .prepare('SELECT id FROM repository_workspaces WHERE conversation_id=?')
        .get(conversationId)
    )
      throw Error('Ambiguous local workspace primary custody');
    return this.get(row.id);
  }
  private unchanged(record: OrdinaryWorkspaceRecord) {
    if (!isDeepStrictEqual(this.get(record.id), record))
      throw Error('Ordinary workspace reservation changed');
  }
  private save(previous: OrdinaryWorkspaceRecord, next: OrdinaryWorkspaceRecord) {
    this.unchanged(previous);
    const result = this.db
      .prepare('UPDATE ordinary_workspaces SET record=? WHERE id=? AND record=?')
      .run(JSON.stringify(workspace.parse(next)), previous.id, JSON.stringify(previous));
    if (result.changes !== 1) throw Error('Ordinary workspace reservation changed');
    return this.get(next.id);
  }
  async qualify(raw: OrdinaryWorkspaceSelectionInput) {
    const signal = raw.signal;
    signal.throwIfAborted();
    const selected = {
      preparationId: z.uuid().parse(raw.preparationId),
      binding: AccountBindingSchema.parse(structuredClone(raw.binding)),
      settings: OrdinaryWorkspaceSettingsSchema.parse(structuredClone(raw.settings)),
      agentProfile: AgentLibraryVersionSchema.parse(structuredClone(raw.agentProfile)),
      requiredCapabilities: [...new Set(raw.requiredCapabilities ?? [])].sort(),
    };
    if (
      selected.requiredCapabilities.some(
        (c) => !(ORDINARY_WORKSPACE_CAPABILITIES as readonly string[]).includes(c),
      )
    )
      throw Error('Required capability is unsupported by an ordinary non-Git workspace');
    const { settings, binding, agentProfile } = selected;
    if (
      settings.workspace.preparationId !== selected.preparationId ||
      settings.binding.harness.implementation !==
        (binding.provider === 'anthropic-vertex' ? 'claude-sdk' : 'codex') ||
      settings.selection.context.source !== 'none' ||
      settings.selection.permission.revision !== 0 ||
      settings.selection.model !== binding.model ||
      agentProfile.definition.contextRecipe !== undefined ||
      agentProfile.contentHash !== contextDigest(agentProfile.definition) ||
      !isDeepStrictEqual(settings.selection.agent, {
        profileId: agentProfile.profileId,
        revision: agentProfile.revision,
        ...(agentProfile.kind ? { kind: agentProfile.kind } : {}),
      })
    )
      throw Error('Original supported ordinary workspace settings required');
    const prepared = await this.assertReadiness(
      selected.preparationId,
      binding,
      signal,
      selected.settings.selection,
    );
    if (!isDeepStrictEqual(prepared.proof.runtimeBinding, settings.binding))
      throw Error('Ordinary runtime identity changed');
    return selected;
  }
  async reserve(raw: OrdinaryWorkspaceReservationInput) {
    const signal = raw.signal;
    const selection = await this.qualify(raw);
    const selected = {
      ...selection,
      allocationOperationId: z.uuid().parse(raw.allocationOperationId),
      taskRoot: canonicalPath.parse(raw.taskRoot),
    };
    const { settings, binding, agentProfile } = selected;
    const rootIdentity = privateDirectory(selected.taskRoot);
    const fingerprint = ordinaryPreparationFingerprint(selected);
    signal.throwIfAborted();
    return this.db
      .transaction(() => {
        sameDirectory(selected.taskRoot, rootIdentity);
        const existing = this.db
          .prepare(
            'SELECT workspace_id,fingerprint FROM ordinary_preparation_allocations WHERE operation_id=?',
          )
          .get(selected.allocationOperationId) as
          { workspace_id: string; fingerprint: string } | undefined;
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            throw Error('Original ordinary allocation cannot be replaced');
          const record = this.get(existing.workspace_id);
          if (
            record.preparationFingerprint !== fingerprint ||
            record.allocationOperationId !== selected.allocationOperationId
          )
            throw Error('Ordinary allocation identity changed');
          sameDirectory(record.hostReservation.taskRoot, record.hostReservation.rootIdentity);
          if (record.state === 'claiming')
            throw Error('Ordinary workspace claim is uncertain; preserve its original identity');
          if (record.state === 'claimed') this.validate(record.conversationId, record.directory);
          return record;
        }
        const id = randomUUID();
        const record = workspace.parse({
          version: 1,
          kind: 'ordinary',
          id,
          preparationId: selected.preparationId,
          allocationOperationId: selected.allocationOperationId,
          preparationFingerprint: fingerprint,
          binding,
          settings,
          agentProfile,
          conversationId: nativeStartupSessionId(`ordinary:${id}`),
          directory:
            settings.binding.execution.location === 'openshell'
              ? this.readPreparation(selected.preparationId).proof.sandboxWorkdir
              : join(selected.taskRoot, `ordinary-${id}`),
          ...(settings.binding.execution.location === 'openshell' ? { sandbox: true } : {}),
          state: 'reserved',
          hostReservation: { version: 1, taskRoot: selected.taskRoot, rootIdentity },
        });
        this.db
          .prepare('INSERT INTO ordinary_preparation_allocations VALUES (?,?,?)')
          .run(record.allocationOperationId, id, fingerprint);
        this.db
          .prepare('INSERT INTO ordinary_workspaces VALUES (?,?,?)')
          .run(id, JSON.stringify(record), record.conversationId);
        return record;
      })
      .immediate();
  }
  private assertClaimScope(record: OrdinaryWorkspaceRecord, input: OrdinaryWorkspaceClaimInput) {
    if (
      record.primaryDisposition?.currentConversationId === null ||
      this.forConversation(record.conversationId)?.id !== record.id ||
      record.conversationId !== input.conversationId ||
      record.hostReservation.taskRoot !== input.taskRoot ||
      !isDeepStrictEqual(record.binding, input.binding)
    )
      throw Error('Original ordinary workspace conversation and account scope required');
    sameDirectory(record.hostReservation.taskRoot, record.hostReservation.rootIdentity);
  }
  validate(conversationId: string, directory: string) {
    const record = this.forConversation(conversationId);
    if (
      !record ||
      record.state !== 'claimed' ||
      record.directory !== directory ||
      (record.sandbox
        ? record.taskIdentity !== undefined ||
          this.readPreparation(record.preparationId).proof.sandboxWorkdir !== directory
        : !record.taskIdentity || record.taskIdentity.directory !== directory)
    )
      throw Error('Original claimed ordinary workspace custody required');
    sameDirectory(record.hostReservation.taskRoot, record.hostReservation.rootIdentity);
    if (!record.sandbox) sameDirectory(directory, record.taskIdentity!.root);
    return record;
  }
  /** Synchronous custody fence for retained receipts and final work commits. */
  validateRetained(conversationId: string) {
    const record = this.forConversation(conversationId);
    if (!record || !['reserved', 'claimed'].includes(record.state))
      throw Error('Ordinary workspace claim is uncertain; preserve its original identity');
    sameDirectory(record.hostReservation.taskRoot, record.hostReservation.rootIdentity);
    if (record.state === 'claimed') this.validate(conversationId, record.directory);
    return record;
  }
  /** Recheck an existing reservation without allocation or materialization. */
  async revalidate(input: OrdinaryWorkspaceClaimInput) {
    const original = this.get(input.id);
    this.assertClaimScope(original, input);
    if (!['reserved', 'claimed'].includes(original.state))
      throw Error('Ordinary workspace claim is uncertain; preserve its original identity');
    await this.assertReadiness(
      original.preparationId,
      input.binding,
      input.signal,
      original.settings.selection,
    );
    this.unchanged(original);
    this.assertClaimScope(original, input);
    this.validateRetained(original.conversationId);
    return original;
  }
  async claim(input: OrdinaryWorkspaceClaimInput) {
    const binding = AccountBindingSchema.parse(structuredClone(input.binding));
    const selected = { ...input, binding };
    input.signal.throwIfAborted();
    const original = this.get(input.id);
    this.assertClaimScope(original, selected);
    if (original.state === 'claiming')
      throw Error('Ordinary workspace claim is uncertain; preserve its original identity');
    await this.assertReadiness(
      original.preparationId,
      binding,
      input.signal,
      original.settings.selection,
    );
    this.unchanged(original);
    this.assertClaimScope(original, selected);
    if (original.state === 'claimed')
      return this.validate(original.conversationId, original.directory);
    if (original.sandbox) {
      // This reservation has no filesystem, sandbox or provider effect. Keep
      // readiness failures recoverable, then commit its logical claim atomically.
      await this.assertReadiness(
        original.preparationId,
        binding,
        input.signal,
        original.settings.selection,
      );
      this.unchanged(original);
      this.assertClaimScope(original, selected);
      input.signal.throwIfAborted();
      return this.db
        .transaction(() => this.save(original, { ...original, state: 'claimed' }))
        .immediate();
    }
    const claiming = this.db
      .transaction(() => this.save(original, { ...original, state: 'claiming' }))
      .immediate();
    this.assertClaimScope(claiming, selected);
    input.signal.throwIfAborted();
    // Exclusive creation after the uncertainty journal. Never adopt, remove or
    // overwrite an existing directory when materialization is interrupted.
    mkdirSync(claiming.directory, { mode: 0o700 });
    const root = privateDirectory(claiming.directory);
    await this.assertReadiness(
      claiming.preparationId,
      binding,
      input.signal,
      claiming.settings.selection,
    );
    this.assertClaimScope(claiming, selected);
    sameDirectory(claiming.directory, root);
    input.signal.throwIfAborted();
    return this.db
      .transaction(() =>
        this.save(claiming, {
          ...claiming,
          state: 'claimed',
          taskIdentity: { version: 1, directory: claiming.directory, root },
        }),
      )
      .immediate();
  }
}

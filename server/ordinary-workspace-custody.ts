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

/** Private directory provider under the existing preparation/allocation owner and
 * its SQLite transaction. No session/task/command allocator or scheduler lives here. */
export class OrdinaryWorkspaceCustody {
  constructor(
    private db: Database.Database,
    private readiness: Readiness | undefined,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS ordinary_workspace_preparations (
      id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ordinary_workspaces (
      id TEXT PRIMARY KEY, record TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE);`);
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
      binding.provider !== 'openai-codex' ||
      selected.runOn !== 'local' ||
      selected.runtime.harness !== 'codex'
    )
      throw Error('Ordinary workspace isolation is supported only by the local Codex owner');
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
    const row = this.db.prepare('SELECT record FROM ordinary_workspaces WHERE id=?').get(id) as
      { record: string } | undefined;
    if (!row) throw Error('Original ordinary workspace unavailable');
    const value = workspace.parse(JSON.parse(row.record));
    if (
      value.id !== id ||
      value.settings.workspace.preparationId !== value.preparationId ||
      value.id === value.conversationId
    )
      throw Error('Ordinary workspace identity changed');
    return value;
  }
  forConversation(conversationId: string) {
    const row = this.db
      .prepare('SELECT id FROM ordinary_workspaces WHERE conversation_id=?')
      .get(conversationId) as { id: string } | undefined;
    return row ? this.get(row.id) : undefined;
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
      settings.binding.execution.location !== 'local' ||
      settings.binding.harness.implementation !== 'codex' ||
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
          directory: join(selected.taskRoot, `ordinary-${id}`),
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
      !record.taskIdentity ||
      record.taskIdentity.directory !== directory
    )
      throw Error('Original claimed ordinary workspace custody required');
    sameDirectory(record.hostReservation.taskRoot, record.hostReservation.rootIdentity);
    sameDirectory(directory, record.taskIdentity.root);
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
    if (original.state === 'claimed') this.validate(original.conversationId, original.directory);
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

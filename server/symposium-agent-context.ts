import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { PortableProfileDefinitionSchema } from './symposium-profile-portability.js';
import { AgentContextSnapshotSchema, type AgentContextSnapshot } from '@mitzo/protocol';
import {
  compileAgentContext,
  verifyCompiledAgentContext,
  type AgentContextCompileOptions,
} from './agent-context-compiler.js';
import type { SymposiumSeatExecution } from './symposium-orchestrator.js';
import type { SymposiumProfileStore } from './symposium-profiles.js';

export interface PreparedSymposiumAgentContext {
  snapshot: AgentContextSnapshot;
  bootContext: string;
}
function identity(execution: SymposiumSeatExecution) {
  const generation = execution.provenance.membershipGeneration;
  if (
    !Number.isSafeInteger(generation) ||
    !generation ||
    !execution.seat.profileBinding ||
    !execution.seat.contextGrant
  )
    throw Error('Exact seat context generation and grants required');
  return JSON.stringify([
    execution.sessionId,
    execution.seat.id,
    generation,
    execution.seat.profileBinding,
    execution.seat.contextGrant,
  ]);
}
export class SymposiumAgentContextStore {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;
  constructor(path: string, sharedDb?: Database.Database) {
    this.db = sharedDb ?? new Database(path);
    this.ownsDb = !sharedDb;
    if (this.ownsDb) this.db.pragma('journal_mode = WAL');
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS symposium_agent_context (identity TEXT PRIMARY KEY,snapshot TEXT NOT NULL); CREATE TABLE IF NOT EXISTS symposium_agent_context_accepted (identity TEXT NOT NULL,claim TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(identity,claim)); CREATE TRIGGER IF NOT EXISTS symposium_context_no_update BEFORE UPDATE ON symposium_agent_context BEGIN SELECT RAISE(ABORT,'Prepared context is immutable'); END; CREATE TRIGGER IF NOT EXISTS symposium_context_no_delete BEFORE DELETE ON symposium_agent_context BEGIN SELECT RAISE(ABORT,'Prepared context is immutable'); END;",
    );
  }
  close() {
    if (this.ownsDb) this.db.close();
  }
  getPrepared(execution: SymposiumSeatExecution): PreparedSymposiumAgentContext | undefined {
    const row = this.db
      .prepare('SELECT snapshot FROM symposium_agent_context WHERE identity=?')
      .get(identity(execution)) as { snapshot: string } | undefined;
    if (!row) return undefined;
    const snapshot = AgentContextSnapshotSchema.parse(JSON.parse(row.snapshot));
    return { snapshot, bootContext: snapshot.context.fullMarkdown };
  }
  prepare(execution: SymposiumSeatExecution, snapshot: AgentContextSnapshot) {
    return this.db.transaction(() => {
      const current = this.getPrepared(execution);
      if (current) {
        if (JSON.stringify(current.snapshot) !== JSON.stringify(snapshot))
          throw Error('Prepared seat snapshot changed');
        return current;
      }
      const parsed = AgentContextSnapshotSchema.parse(snapshot);
      this.db
        .prepare('INSERT INTO symposium_agent_context(identity,snapshot) VALUES(?,?)')
        .run(identity(execution), JSON.stringify(parsed));
      return { snapshot: parsed, bootContext: parsed.context.fullMarkdown };
    })();
  }
  accept(
    execution: SymposiumSeatExecution,
    prepared: PreparedSymposiumAgentContext,
    providerThreadId: string,
    providerTurnId: string,
  ) {
    if (!providerThreadId || !providerTurnId)
      throw Error('Provider context receipt requires exact turn and thread');
    return this.db.transaction(() => {
      const stored = this.getPrepared(execution);
      if (!stored || JSON.stringify(stored.snapshot) !== JSON.stringify(prepared.snapshot))
        throw Error('Provider receipt snapshot differs from prepared context');
      const key = identity(execution);
      const value = {
        claimToken: execution.claimToken,
        providerThreadId,
        providerTurnId,
        payloadHash: stored.snapshot.payloadHash,
      };
      const row = this.db
        .prepare('SELECT value FROM symposium_agent_context_accepted WHERE identity=? AND claim=?')
        .get(key, execution.claimToken) as { value: string } | undefined;
      if (row) {
        if (row.value !== JSON.stringify(value)) throw Error('Provider context receipt changed');
        return;
      }
      this.db
        .prepare('INSERT INTO symposium_agent_context_accepted(identity,claim,value) VALUES(?,?,?)')
        .run(key, execution.claimToken, JSON.stringify(value));
    })();
  }
  acceptances(execution: SymposiumSeatExecution) {
    return (
      this.db
        .prepare(
          'SELECT value FROM symposium_agent_context_accepted WHERE identity=? ORDER BY rowid',
        )
        .all(identity(execution)) as { value: string }[]
    ).map(
      (row) =>
        JSON.parse(row.value) as {
          claimToken: string;
          providerThreadId: string;
          providerTurnId: string;
          payloadHash: string;
        },
    );
  }
}
export function createSymposiumAgentContextBinding(deps: {
  store: SymposiumAgentContextStore;
  profiles: Pick<SymposiumProfileStore, 'get'>;
  assertCurrent(execution: SymposiumSeatExecution): void;
  compileOptions(execution: SymposiumSeatExecution): Promise<AgentContextCompileOptions>;
}) {
  const sourceFences = new WeakMap<PreparedSymposiumAgentContext, () => void>();
  function selected(execution: SymposiumSeatExecution) {
    deps.assertCurrent(execution);
    if (!execution.seat.contextRecipe) return undefined;
    const binding = execution.seat.profileBinding;
    if (!binding) {
      if (execution.seat.contextRecipe)
        throw Error('Context recipe requires immutable profile selection');
      return undefined;
    }
    const revision = Number(binding.profileRevision);
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw Error('Context profile revision is invalid');
    const profile = deps.profiles.get('user', binding.profileId, revision);
    if (!profile || profile.profileId !== binding.profileId || profile.revision !== revision)
      throw Error('Selected context profile revision unavailable');
    const definition = PortableProfileDefinitionSchema.parse(profile.definition);
    if (
      createHash('sha256').update(JSON.stringify(definition)).digest('hex') !== profile.contentHash
    )
      throw Error('Selected profile integrity check failed');
    if (
      JSON.stringify(profile.definition.contextRecipe) !==
      JSON.stringify(execution.seat.contextRecipe)
    )
      throw Error('Granted context recipe differs from immutable profile');
    return profile;
  }
  return {
    async prepare(
      execution: SymposiumSeatExecution,
    ): Promise<PreparedSymposiumAgentContext | undefined> {
      const profile = selected(execution);
      const recipe = profile?.definition.contextRecipe;
      if (!recipe) return undefined;
      if (recipe.source !== 'packs')
        throw Error('Symposium context source is unsupported; select published context packs');
      const options = await deps.compileOptions(execution);
      deps.assertCurrent(execution);
      execution.signal.throwIfAborted();
      const stored = deps.store.getPrepared(execution);
      if (stored) {
        const { profileId, revision, profileHash, ...compiled } = stored.snapshot;
        if (
          profileId !== profile.profileId ||
          revision !== profile.revision ||
          profileHash !== profile.contentHash
        )
          throw Error('Prepared context profile changed');
        await verifyCompiledAgentContext(compiled, recipe, {
          ...options,
          signal: execution.signal,
        });
        deps.assertCurrent(execution);
        sourceFences.set(stored, () => options.packs!.assertCurrent());
        return stored;
      }
      const compiled = await compileAgentContext(recipe, { ...options, signal: execution.signal });
      deps.assertCurrent(execution);
      execution.signal.throwIfAborted();
      const prepared = deps.store.prepare(
        execution,
        AgentContextSnapshotSchema.parse({
          ...compiled,
          profileId: profile.profileId,
          revision: profile.revision,
          profileHash: profile.contentHash,
        }),
      );
      sourceFences.set(prepared, () => options.packs!.assertCurrent());
      return prepared;
    },
    assertCurrent(execution: SymposiumSeatExecution, prepared: PreparedSymposiumAgentContext) {
      const profile = selected(execution);
      const sourceFence = sourceFences.get(prepared);
      if (!sourceFence) throw Error('Prepared context source adapter is unavailable');
      sourceFence();
      const stored = deps.store.getPrepared(execution);
      if (
        !profile ||
        !stored ||
        JSON.stringify(stored.snapshot) !== JSON.stringify(prepared.snapshot) ||
        stored.snapshot.profileHash !== profile.contentHash
      )
        throw Error('Prepared context snapshot is no longer current');
    },
    accepted(
      execution: SymposiumSeatExecution,
      prepared: PreparedSymposiumAgentContext,
      thread: string,
      turn: string,
    ) {
      // Delivery is historical fact: later authority revocation cannot erase its acknowledgement.
      deps.store.accept(execution, prepared, thread, turn);
    },
  };
}
export type SymposiumAgentContextBinding = ReturnType<typeof createSymposiumAgentContextBinding>;

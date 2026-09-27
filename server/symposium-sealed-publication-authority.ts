import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './connections/capabilities/input-validation.js';

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.strictObject({
  operatorId: id,
  sessionId: id,
  recordId: id,
  recordHash: hash,
  sealId: id,
  sealHash: hash,
  repository: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .transform((value) => value.toLowerCase()),
  connectionId: id,
  connectionRevision: z.number().int().positive(),
  credentialGeneration: id,
});
export type SealedPublicationScope = z.infer<typeof scopeSchema>;
const principalSchema = z.object({
  id: z.number().int().positive().safe(),
  login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
  type: z.literal('User'),
});
export interface PublicationPrincipal {
  host: 'github.com';
  numericId: number;
  login: string;
}
/** Sanitized result from the selected credential custodian. No response body,
 * subprocess stderr, credential or raw private exception belongs in this error. */
export class PublicationCredentialHttpError extends Error {
  constructor(readonly status: number) {
    super('Selected publication credential request failed');
    if (!Number.isInteger(status) || status < 400 || status > 599)
      throw new Error('Invalid HTTP failure status');
  }
}
/** A separately selected controller write connection, not a model-account attachment.
 * The custodian must hold one immutable credential generation inside this handle.
 * It must not resolve ambient GH_TOKEN or change credentials between invocations.
 * No production custodian is installed by this module. */
export interface PublicationCredentialHandle {
  connectionId: string;
  revision: number;
  generation: string;
  assertCurrent(): true;
  run(
    command: 'gh' | 'git',
    args: readonly string[],
    signal: AbortSignal,
  ): Promise<{ stdout: string }>;
}
export interface SealedPublicationAuthorityDependencies {
  /** Authenticated controller session; never an operator ID from request data alone. */
  assertOperator(operatorId: string, sessionId: string): true;
  /** Fresh actual seal and review-record validation; no pending intent accepted. */
  assertArtifact(scope: SealedPublicationScope, signal: AbortSignal): Promise<void>;
  resolveCredential(scope: SealedPublicationScope): PublicationCredentialHandle | null;
}
export interface SealedPublicationGrant {
  id: string;
  scope: SealedPublicationScope;
  principal: PublicationPrincipal;
  bindingHash: string;
}

/** A separate grant namespace. Rows never create runtime credential authority:
 * every use requires the selected live custodian and a fresh exact GH principal.
 * Grants authorize only requesting the normal CapabilityService approval, not a write. */
export class SealedPublicationAuthority {
  private readonly db: Database.Database;
  constructor(
    path: string,
    private readonly deps: SealedPublicationAuthorityDependencies,
  ) {
    if (path !== ':memory:') {
      const parent = dirname(path);
      const directory = lstatSync(parent);
      if (
        !isAbsolute(path) ||
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        realpathSync(parent) !== parent ||
        directory.mode & 0o077 ||
        directory.uid !== process.getuid?.()
      )
        throw new Error('Private publication grant directory required');
      const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const file = fstatSync(fd);
        if (!file.isFile() || file.mode & 0o077 || file.uid !== process.getuid?.())
          throw new Error('Private publication grant database required');
      } finally {
        closeSync(fd);
      }
    }
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS sealed_publication_grants (
      id TEXT PRIMARY KEY, binding_json TEXT NOT NULL, binding_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','revoked'))
    )`);
  }
  close() {
    this.db.close();
  }
  private async verify(
    scope: SealedPublicationScope,
    signal: AbortSignal,
    observerId = scope.operatorId,
  ) {
    signal.throwIfAborted();
    if (this.deps.assertOperator(observerId, scope.sessionId) !== true)
      throw new Error('Authenticated publication operator required');
    await this.deps.assertArtifact(scope, signal);
    const handle = this.deps.resolveCredential(scope);
    if (
      !handle ||
      handle.connectionId !== scope.connectionId ||
      handle.revision !== scope.connectionRevision ||
      handle.generation !== scope.credentialGeneration
    )
      throw new Error('Selected publication credential unavailable');
    if (handle.assertCurrent() !== true) throw new Error('Current publication credential required');
    // This command uses only the selected immutable credential handle. There is no
    // fallback to the process environment or managed read-only provider metadata.
    const output = await handle.run(
      'gh',
      ['api', '--hostname', 'github.com', '--method', 'GET', '/user'],
      signal,
    );
    if (Buffer.byteLength(output.stdout) > 65536)
      throw new Error('Publication identity response too large');
    const identity = principalSchema.parse(JSON.parse(output.stdout));
    if (handle.assertCurrent() !== true) throw new Error('Current publication credential required');
    if (this.deps.resolveCredential(scope) !== handle)
      throw new Error('Publication credential handle changed');
    if (this.deps.assertOperator(observerId, scope.sessionId) !== true)
      throw new Error('Authenticated publication operator required');
    await this.deps.assertArtifact(scope, signal);
    signal.throwIfAborted();
    return {
      handle,
      principal: { host: 'github.com' as const, numericId: identity.id, login: identity.login },
    };
  }
  /** Call only after the operator explicitly selects this exact scope and principal.
   * A preview cannot create a grant and a grant cannot approve publication. */
  async grant(
    selected: SealedPublicationScope,
    expected: PublicationPrincipal,
    signal: AbortSignal,
  ) {
    const scope = scopeSchema.parse(selected);
    const { principal } = await this.verify(scope, signal);
    if (canonicalJson(principal) !== canonicalJson(expected))
      throw new Error('Selected GitHub principal changed');
    const binding = { scope, principal };
    const grant = { id: randomUUID(), ...binding, bindingHash: digest(binding) };
    this.db
      .prepare('INSERT INTO sealed_publication_grants VALUES (?, ?, ?, ?)')
      .run(grant.id, canonicalJson(binding), grant.bindingHash, 'active');
    return structuredClone(grant);
  }
  async preview(selected: SealedPublicationScope, signal: AbortSignal) {
    const scope = scopeSchema.parse(selected);
    return (await this.verify(scope, signal)).principal;
  }
  revoke(grantId: string, operatorId: string, sessionId: string) {
    if (this.deps.assertOperator(operatorId, sessionId) !== true)
      throw new Error('Authenticated publication operator required');
    const grant = this.read(grantId);
    if (grant.scope.operatorId !== operatorId || grant.scope.sessionId !== sessionId)
      throw new Error('Publication grant owner mismatch');
    this.db.prepare("UPDATE sealed_publication_grants SET state='revoked' WHERE id=?").run(grantId);
  }
  private read(grantId: string): SealedPublicationGrant {
    const row = this.db
      .prepare("SELECT * FROM sealed_publication_grants WHERE id=? AND state='active'")
      .get(grantId) as { binding_json: string; binding_hash: string } | undefined;
    if (!row) throw new Error('Publication grant unavailable');
    const stored = JSON.parse(row.binding_json);
    const scope = scopeSchema.parse(stored.scope);
    const p = stored.principal;
    const identity = principalSchema.parse({ id: p?.numericId, login: p?.login, type: 'User' });
    if (p.host !== 'github.com') throw new Error('Publication principal host changed');
    const principal = {
      host: 'github.com' as const,
      numericId: identity.id,
      login: identity.login,
    };
    if (digest({ scope, principal }) !== row.binding_hash)
      throw new Error('Publication grant binding changed');
    return { id: grantId, scope, principal, bindingHash: row.binding_hash };
  }
  /** Synchronous lifecycle gate for CapabilityService. Network identity/artifact
   * revalidation still runs in require before any external operation. */
  isCurrent(
    grantId: string,
    bindingHash: string,
    expectedHandle: PublicationCredentialHandle,
  ): boolean {
    try {
      const grant = this.read(grantId);
      if (
        grant.bindingHash !== bindingHash ||
        this.deps.assertOperator(grant.scope.operatorId, grant.scope.sessionId) !== true
      )
        return false;
      const handle = this.deps.resolveCredential(grant.scope);
      return (
        handle === expectedHandle &&
        handle.connectionId === grant.scope.connectionId &&
        handle.revision === grant.scope.connectionRevision &&
        handle.generation === grant.scope.credentialGeneration &&
        handle.assertCurrent() === true
      );
    } catch {
      return false;
    }
  }
  /** Read-only observation authority. This never changes or reauthorizes the old grant. */
  isRecoveryCurrent(
    grantId: string,
    bindingHash: string,
    observerId: string,
    expectedHandle: PublicationCredentialHandle,
  ): boolean {
    try {
      const grant = this.read(grantId);
      const handle = this.deps.resolveCredential(grant.scope);
      return (
        grant.bindingHash === bindingHash &&
        this.deps.assertOperator(observerId, grant.scope.sessionId) === true &&
        handle === expectedHandle &&
        handle.connectionId === grant.scope.connectionId &&
        handle.revision === grant.scope.connectionRevision &&
        handle.generation === grant.scope.credentialGeneration &&
        handle.assertCurrent() === true
      );
    } catch {
      return false;
    }
  }
  async requireRecovery(
    grantId: string,
    bindingHash: string,
    observerId: string,
    expectedHandle: PublicationCredentialHandle,
    signal: AbortSignal,
  ) {
    const grant = this.read(grantId);
    if (!this.isRecoveryCurrent(grantId, bindingHash, observerId, expectedHandle))
      throw Error('Recovery observation authority unavailable');
    const proof = await this.verify(grant.scope, signal, observerId);
    if (
      proof.handle !== expectedHandle ||
      canonicalJson(proof.principal) !== canonicalJson(grant.principal) ||
      !this.isRecoveryCurrent(grantId, bindingHash, observerId, expectedHandle)
    )
      throw Error('Recovery observation binding changed');
    signal.throwIfAborted();
    return { grant, handle: proof.handle };
  }
  /** Must run at preflight AND after forced approval. Returned public fields belong
   * in CapabilityService's exact approval projection and durable recovery intent. */
  async require(grantId: string, expectedBindingHash: string, signal: AbortSignal) {
    const grant = this.read(grantId);
    if (grant.bindingHash !== expectedBindingHash) throw new Error('Publication selection changed');
    const { principal, handle } = await this.verify(grant.scope, signal);
    if (canonicalJson(principal) !== canonicalJson(grant.principal))
      throw new Error('Publication principal changed');
    if (this.read(grantId).bindingHash !== expectedBindingHash)
      throw new Error('Publication grant changed');
    return {
      grant,
      handle,
      approval: {
        publicationGrantId: grant.id,
        publicationBindingHash: grant.bindingHash,
        publicationOperator: grant.scope.operatorId,
        publicationGithubId: String(grant.principal.numericId),
        publicationGithubLogin: grant.principal.login,
        publicationCredentialGeneration: grant.scope.credentialGeneration,
      },
    };
  }
}

/** Wrap only a sealed-artifact executor in its own CapabilityService registration.
 * This does not replace the live-builder executor or install an HTTP route.
 * The service remains responsible for forced approval, input hash, dispatch journal,
 * and read-only recovery. Authority is checked around every executor boundary. */
export function guardSealedPublicationExecutor(
  authority: SealedPublicationAuthority,
  resolveSelection: (
    operation: import('./connections/capabilities/types.js').CapabilityOperation,
  ) => { grantId: string; bindingHash: string } | null,
  executor: import('./connections/capabilities/types.js').CapabilityExecutor,
): import('./connections/capabilities/types.js').CapabilityExecutor {
  const validate = async (
    context: import('./connections/capabilities/types.js').CapabilityExecutionContext,
    approved: boolean,
  ) => {
    const saved = context.operation.recoveryIntent as Record<string, unknown> | null;
    const selection = approved
      ? {
          grantId: String(saved?.publicationGrantId ?? ''),
          bindingHash: String(saved?.publicationBindingHash ?? ''),
        }
      : resolveSelection(context.operation);
    if (!selection) throw new Error('Explicit publication selection required');
    const proof = await authority.require(selection.grantId, selection.bindingHash, context.signal);
    if (proof.grant.scope.sessionId !== context.operation.conversationId)
      throw new Error('Publication session mismatch');
    if (approved) {
      if (
        !context.approvalInput ||
        !context.operation.approvalInput ||
        canonicalJson(context.approvalInput) !== canonicalJson(context.operation.approvalInput) ||
        digest(context.approvalInput) !== context.operation.approvalHash
      )
        throw new Error('Durable publication approval required');
      for (const [key, value] of Object.entries(proof.approval))
        if (context.approvalInput[key] !== value || saved?.[key] !== value)
          throw new Error('Approved publication authority changed');
    }
    return proof;
  };
  const delegated = (
    context: import('./connections/capabilities/types.js').CapabilityExecutionContext,
  ) => {
    const approvalInput = { ...context.approvalInput };
    for (const key of [
      'publicationGrantId',
      'publicationBindingHash',
      'publicationOperator',
      'publicationGithubId',
      'publicationGithubLogin',
      'publicationCredentialGeneration',
    ])
      delete approvalInput[key];
    return { ...context, approvalInput };
  };
  return {
    async preflight(context) {
      const before = await validate(context, false);
      if (!executor.preflight) throw new Error('Publication preflight required');
      const result = await executor.preflight(context);
      const after = await validate(context, false);
      if (
        before.grant.bindingHash !== after.grant.bindingHash ||
        before.grant.id !== after.grant.id
      )
        throw new Error('Publication selection changed');
      if (
        !result.recoveryIntent ||
        typeof result.recoveryIntent !== 'object' ||
        Array.isArray(result.recoveryIntent)
      )
        throw new Error('Publication recovery intent required');
      return {
        approvalInput: { ...result.approvalInput, ...before.approval },
        recoveryIntent: { ...result.recoveryIntent, ...before.approval },
      };
    },
    async execute(context) {
      await validate(context, true);
      const result = await executor.execute(delegated(context));
      await validate(context, true);
      return result;
    },
    async verify(context, result) {
      await validate(context, true);
      await executor.verify(delegated(context), result);
      await validate(context, true);
    },
    // The underlying reviewed recovery only reads an already-dispatched outcome.
    // Revocation never enables redispatch or changes the durable approved metadata.
    recover: (operation, signal) => executor.recover(operation, signal),
  };
}

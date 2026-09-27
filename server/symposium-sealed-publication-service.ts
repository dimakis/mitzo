import { createHash } from 'node:crypto';
import { CapabilityService } from './connections/capabilities/service.js';
import { CapabilityExecutorRegistry } from './connections/capabilities/registry.js';
import type { CapabilityOperationStore } from './connections/capabilities/operation-store.js';
import type {
  CapabilityApproval,
  CapabilityExecutor,
  CapabilityOperation,
} from './connections/capabilities/types.js';
import { connectionTemplateRegistry } from './connections/registry.js';
import { canonicalJson } from './connections/capabilities/input-validation.js';
import {
  createGithubArtifactPublishPrExecutor,
  type GithubSandboxInspection,
} from './connections/capabilities/github-publish-pr.js';
import {
  GitHubCliHostPublisher,
  GithubNotFoundError,
} from './connections/capabilities/github-publish-pr-transport.js';
import {
  SealedPublicationAuthority,
  PublicationCredentialHttpError,
  guardSealedPublicationExecutor,
  type SealedPublicationScope,
  type SealedPublicationGrant,
  type PublicationCredentialHandle,
} from './symposium-sealed-publication-authority.js';

/** Host-owned completed-seal transport. Implementations must freshly prove exact
 * reviewed commit/tree, retained volume and completed seal, not merely a row. */
export interface SealedPublicationArtifactTransport {
  require(
    scope: SealedPublicationScope,
    signal: AbortSignal,
  ): Promise<{ workspace: string; repositoryPath: string; sourceOid: string }>;
  inspectCompletedArtifact(
    input: { fenceId: string; operationId: string; baseBranch: string },
    signal: AbortSignal,
  ): Promise<GithubSandboxInspection>;
  exportCompletedArtifactBundle(
    input: {
      fenceId: string;
      operationId: string;
      sourceBranch: string;
      baseBranch: string;
      sourceOid: string;
      maxBytes: number;
    },
    signal: AbortSignal,
  ): Promise<Buffer>;
}

export interface PublicationRecoverySelection {
  recordId: string;
  recordHash: string;
  sealId: string;
  sealHash: string;
  repository: string;
  operationId: string;
  grantId: string;
  bindingHash: string;
  sessionId: string;
  connectionId: string;
  connectionRevision: number;
  credentialGeneration: string;
}
interface RecoveryContext {
  operationId: string;
  observerId: string;
  recentUntil: number;
  signal: AbortSignal;
  snapshot: string;
}
interface RetainedPublication {
  service: CapabilityService;
  grant: SealedPublicationGrant;
  handle: PublicationCredentialHandle;
  recovery?: RecoveryContext;
}
const recoverySnapshot = (operation: CapabilityOperation) =>
  canonicalJson(
    Object.fromEntries(
      Object.entries(operation).filter(
        ([key, value]) => !['status', 'updatedAt'].includes(key) && value !== undefined,
      ),
    ),
  );
/** Separate controller-only service. No route installs it. Missing registration is
 * actionable unavailability; no live sandbox grant or ambient credential fallback. */
export class SealedPublicationService {
  private readonly services = new Map<string, RetainedPublication>();
  constructor(
    private readonly deps: {
      authority: SealedPublicationAuthority;
      operations: CapabilityOperationStore;
      artifact: SealedPublicationArtifactTransport;
      credentialCustodianRegistered: boolean;
    },
  ) {}
  private assertRecovery(
    retained: RetainedPublication,
    operation: CapabilityOperation,
    context: RecoveryContext,
  ) {
    context.signal.throwIfAborted();
    const current = this.deps.operations.get(operation.id);
    if (
      context.recentUntil <= Date.now() ||
      retained.recovery !== context ||
      context.operationId !== operation.id ||
      !current ||
      recoverySnapshot(current) !== context.snapshot ||
      !this.deps.authority.isRecoveryCurrent(
        retained.grant.id,
        retained.grant.bindingHash,
        context.observerId,
        retained.handle,
      )
    )
      throw Error('Recovery observation changed');
  }
  private validateRecoveryOperation(retained: RetainedPublication, operation: CapabilityOperation) {
    const grant = retained.grant;
    const approved = operation.approvalInput as Record<string, unknown> | null;
    const saved = operation.recoveryIntent as Record<string, unknown> | null;
    if (
      operation.status !== 'verification_pending' ||
      operation.connectionId !== `sealed-publication-${grant.id}` ||
      operation.accountId !== `operator:${grant.scope.operatorId}` ||
      operation.conversationId !== grant.scope.sessionId ||
      operation.capabilityId !== 'github.publish-pr' ||
      operation.capabilityVersion !== 1 ||
      !approved ||
      !saved ||
      createHash('sha256').update(canonicalJson(approved)).digest('hex') !== operation.approvalHash
    )
      throw Error('Exact approved pending operation required');
    const capabilityGrant = this.deps.operations.getGrant(
      operation.connectionId,
      operation.connectionRevision,
      operation.capabilityId,
      operation.capabilityVersion,
    );
    if (
      !capabilityGrant ||
      capabilityGrant.id !== operation.grantId ||
      capabilityGrant.status !== 'active' ||
      !capabilityGrant.accountIds.includes(operation.accountId)
    )
      throw Error('Original capability grant unavailable');
    const proof = {
      publicationGrantId: grant.id,
      publicationBindingHash: grant.bindingHash,
      publicationOperator: grant.scope.operatorId,
      publicationGithubId: String(grant.principal.numericId),
      publicationGithubLogin: grant.principal.login,
      publicationCredentialGeneration: grant.scope.credentialGeneration,
    };
    for (const [key, value] of Object.entries(proof))
      if (approved[key] !== value || saved[key] !== value)
        throw Error('Original publication approval changed');
    const fields = [
      'repository',
      'sourceBranch',
      'sourceOid',
      'baseBranch',
      'title',
      'body',
      'draft',
      'existingPullRequestId',
      'existingPullRequestUrl',
    ];
    if (
      saved.operationId !== operation.id ||
      Object.keys(saved).some(
        (key) => !fields.includes(key) && !Object.hasOwn(proof, key) && key !== 'operationId',
      ) ||
      fields.some((key) => saved[key] !== approved[key]) ||
      approved.repository !== grant.scope.repository ||
      typeof approved.body !== 'string' ||
      !approved.body.endsWith(
        `Review record: ${grant.scope.recordId}\nSHA256: ${grant.scope.recordHash}`,
      )
    )
      throw Error('Original recovery intent changed');
    const input = Object.fromEntries(
      ['repositoryPath', 'baseBranch', 'title', 'body', 'draft', 'connectionId'].map((key) => [
        key,
        approved[key],
      ]),
    );
    if (createHash('sha256').update(canonicalJson(input)).digest('hex') !== operation.inputHash)
      throw Error('Original publication input changed');
  }
  private async verifyRecovery(
    retained: RetainedPublication,
    operation: CapabilityOperation,
    context: RecoveryContext,
  ) {
    this.assertRecovery(retained, operation, context);
    this.validateRecoveryOperation(retained, operation);
    await this.deps.authority.requireRecovery(
      retained.grant.id,
      retained.grant.bindingHash,
      context.observerId,
      retained.handle,
      context.signal,
    );
    const artifact = await this.deps.artifact.require(retained.grant.scope, context.signal);
    const approved = operation.approvalInput as Record<string, unknown>;
    if (
      artifact.sourceOid !== approved.sourceOid ||
      artifact.repositoryPath !== approved.repositoryPath
    )
      throw Error('Original sealed artifact changed');
    this.assertRecovery(retained, operation, context);
  }
  assertPublicationAvailable(
    sessionId: string,
    recordId: string,
    recordHash: string,
    existing?: { grantId: string; turnId: string; idempotencyKey: string },
  ) {
    for (const operation of this.deps.operations.pendingRecovery()) {
      if (
        operation.conversationId !== sessionId ||
        !operation.connectionId.startsWith('sealed-publication-')
      )
        continue;
      const retained = [...this.services.values()].find(
        (entry) =>
          operation.connectionId === `sealed-publication-${entry.grant.id}` &&
          entry.grant.scope.sessionId === sessionId,
      );
      // Unknown historical owners cannot prove that a pending write is unrelated.
      if (!retained) throw Error('Existing publication must be reconciled');
      if (
        retained.grant.scope.recordId !== recordId ||
        retained.grant.scope.recordHash !== recordHash
      )
        continue;
      if (
        existing &&
        retained.grant.id === existing.grantId &&
        operation.turnId === existing.turnId &&
        operation.idempotencyKey === existing.idempotencyKey
      )
        continue;
      throw Error('Existing publication must be reconciled');
    }
  }
  recoveryCandidates(sessionId: string, recordId: string, recordHash: string) {
    const pending = this.deps.operations
      .pendingRecovery()
      .filter(
        (operation) =>
          operation.conversationId === sessionId &&
          operation.connectionId.startsWith('sealed-publication-'),
      );
    if (pending.length > 100) throw Error('Pending publication recovery unavailable');
    return pending.flatMap((operation) => {
      const retained = [...this.services.values()].find(
        (entry) =>
          operation.connectionId === `sealed-publication-${entry.grant.id}` &&
          entry.grant.scope.sessionId === sessionId,
      );
      if (!retained) throw Error('Pending publication recovery unavailable');
      if (
        retained.grant.scope.recordId !== recordId ||
        retained.grant.scope.recordHash !== recordHash
      )
        return [];
      try {
        this.validateRecoveryOperation(retained, operation);
      } catch {
        throw Error('Pending publication recovery unavailable');
      }
      const grant = retained.grant;
      return [
        {
          operationId: operation.id,
          grantId: grant.id,
          bindingHash: grant.bindingHash,
          sessionId,
          connectionId: grant.scope.connectionId,
          connectionRevision: grant.scope.connectionRevision,
          credentialGeneration: grant.scope.credentialGeneration,
          repository: grant.scope.repository,
          recordId: grant.scope.recordId,
          recordHash: grant.scope.recordHash,
          sealHash: grant.scope.sealHash,
          sealId: grant.scope.sealId,
          principal: grant.principal,
        },
      ];
    });
  }
  async recoverExact(
    input: PublicationRecoverySelection,
    observerId: string,
    signal: AbortSignal,
    recentUntil: number,
  ) {
    if (!Number.isSafeInteger(recentUntil) || recentUntil <= Date.now())
      throw Error('Recent recovery authorization expired');
    const retained = this.services.get(input.grantId),
      operation = this.deps.operations.get(input.operationId);
    if (!retained || !operation || retained.recovery)
      throw Error('Retained exact recovery unavailable');
    const { grant } = retained;
    if (
      input.recordId !== grant.scope.recordId ||
      input.recordHash !== grant.scope.recordHash ||
      input.sealId !== grant.scope.sealId ||
      input.sealHash !== grant.scope.sealHash ||
      input.repository !== grant.scope.repository ||
      input.bindingHash !== grant.bindingHash ||
      input.sessionId !== grant.scope.sessionId ||
      input.connectionId !== grant.scope.connectionId ||
      input.connectionRevision !== grant.scope.connectionRevision ||
      input.credentialGeneration !== grant.scope.credentialGeneration
    )
      throw Error('Recovery selection changed');
    this.validateRecoveryOperation(retained, operation);
    const context = {
      operationId: operation.id,
      observerId,
      recentUntil,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.min(60_000, Math.max(1, recentUntil - Date.now()))),
      ]),
      snapshot: recoverySnapshot(operation),
    };
    try {
      return await retained.service.recoverExactOperation(operation.id, context.signal, () => {
        retained.recovery = context;
      });
    } finally {
      if (retained.recovery === context) retained.recovery = undefined;
    }
  }
  availability() {
    return this.deps.credentialCustodianRegistered
      ? { available: true as const }
      : {
          available: false as const,
          code: 'PUBLICATION_CREDENTIAL_REGISTRATION_REQUIRED' as const,
          message: 'Register and explicitly select a controller GitHub publication account.',
        };
  }
  async invoke(
    input: {
      grantId: string;
      bindingHash: string;
      turnId: string;
      idempotencyKey: string;
      publication: {
        repositoryPath: string;
        baseBranch: string;
        title: string;
        body: string;
        draft: boolean;
      };
    },
    signal: AbortSignal,
    approve: CapabilityApproval,
  ) {
    if (!this.availability().available)
      throw new Error('PUBLICATION_CREDENTIAL_REGISTRATION_REQUIRED');
    const initial = await this.deps.authority.require(input.grantId, input.bindingHash, signal);
    const grant = initial.grant;
    const connectionId = `sealed-publication-${grant.id}`;
    const accountId = `operator:${grant.scope.operatorId}`;
    let retained = this.services.get(grant.id);
    let service = retained?.service;
    if (!service) {
      const selection = { grantId: grant.id, bindingHash: grant.bindingHash };
      const requireWriteAuthority = async (requestSignal: AbortSignal) => {
        const current = await this.deps.authority.require(
          selection.grantId,
          selection.bindingHash,
          requestSignal,
        );
        if (current.handle !== initial.handle)
          throw new Error('Selected publication handle replaced');
        return current;
      };
      const create = async (
        operation: CapabilityOperation,
        requestSignal: AbortSignal,
        recovery = false,
        preflightBaseBranch?: unknown,
      ) => {
        const requireAuthority = async (checkSignal: AbortSignal) => {
          const context = recovery ? retained?.recovery : undefined;
          if (context) {
            await this.verifyRecovery(retained!, operation, context);
            checkSignal.throwIfAborted();
          } else await requireWriteAuthority(checkSignal);
        };
        await requireAuthority(requestSignal);
        const source = recovery
          ? undefined
          : await this.deps.artifact.require(grant.scope, requestSignal);
        // Exact selected handle is captured; every command is checked around its
        // external boundary. No publisher can resolve a process token instead.
        const publisher = new GitHubCliHostPublisher(async (command, args, commandSignal) => {
          if (command !== 'git' && command !== 'gh')
            throw new Error('Unsupported publication command');
          if (
            recovery &&
            !(
              (command === 'gh' &&
                args[0] === 'api' &&
                args[1] === '--method' &&
                args[2] === 'GET') ||
              (command === 'git' && args[0] === 'ls-remote' && args.length === 3)
            )
          )
            throw new Error('Recovery mutation forbidden');
          await requireAuthority(commandSignal);
          try {
            const output = await initial.handle.run(command, args, commandSignal);
            await requireAuthority(commandSignal);
            return { ...output, stderr: '' };
          } catch (error) {
            await requireAuthority(commandSignal);
            if (error instanceof PublicationCredentialHttpError && error.status === 404)
              throw new GithubNotFoundError(undefined);
            // Custodian failures may contain private subprocess output; retain only typed status.
            // eslint-disable-next-line preserve-caught-error
            throw new Error('Selected publication credential request failed');
          }
        });
        const forbidden = async (): Promise<never> => {
          throw new Error('Recovery artifact access forbidden');
        };
        if (recovery) {
          const read = publisher.read.bind(publisher);
          publisher.read = async (request) => {
            const pr = await read(request);
            const approved = operation.approvalInput as Record<string, unknown>;
            if (
              pr &&
              (pr.title !== approved.title ||
                pr.body !== approved.body ||
                pr.draft !== approved.draft)
            )
              throw new Error('Approved publication metadata remains unverified');
            return pr;
          };
          publisher.create = forbidden;
          publisher.update = forbidden;
          publisher.push = forbidden;
          publisher.reconstruct = forbidden;
        }

        const executor = createGithubArtifactPublishPrExecutor({
          host: publisher,
          resolveWorkspace: () => source?.workspace,
          resolvePublicConfig: () => ({
            allowedRepositories: [grant.scope.repository],
            allowedBaseBranches: [
              String(
                (operation.approvalInput as Record<string, unknown> | null)?.baseBranch ??
                  preflightBaseBranch,
              ),
            ],
          }),
          inspect: recovery
            ? forbidden
            : async (request) => {
                await requireAuthority(request.signal);
                const current = await this.deps.artifact.require(grant.scope, request.signal);
                if (
                  canonicalJson(current) !== canonicalJson(source) ||
                  request.repositoryPath !== current.repositoryPath
                )
                  throw new Error('Sealed artifact changed');
                const inspected = await this.deps.artifact.inspectCompletedArtifact(
                  {
                    fenceId: grant.scope.sealId,
                    operationId: operation.id,
                    baseBranch: request.baseBranch,
                  },
                  request.signal,
                );
                if (
                  inspected.sourceOid !== current.sourceOid ||
                  inspected.canonicalRepositoryPath !== current.repositoryPath
                )
                  throw new Error('Sealed committed artifact changed');
                await requireAuthority(request.signal);
                return inspected;
              },
          exportBundle: recovery
            ? forbidden
            : async (request) => {
                await requireAuthority(request.signal);
                if (
                  request.sourceOid !== source!.sourceOid ||
                  request.repositoryPath !== source!.repositoryPath
                )
                  throw new Error('Approved artifact export changed');
                const bundle = await this.deps.artifact.exportCompletedArtifactBundle(
                  {
                    fenceId: grant.scope.sealId,
                    operationId: operation.id,
                    sourceBranch: request.sourceBranch,
                    baseBranch: request.baseBranch,
                    sourceOid: request.sourceOid,
                    maxBytes: request.maxBytes,
                  },
                  request.signal,
                );
                await requireAuthority(request.signal);
                return bundle;
              },
        });
        return executor;
      };
      const base: CapabilityExecutor = {
        preflight: async (context) => {
          const suffix = `Review record: ${grant.scope.recordId}\nSHA256: ${grant.scope.recordHash}`;
          if (typeof context.input.body !== 'string' || !context.input.body.endsWith(suffix))
            throw new Error('Exact review record reference required');
          return (await create(context.operation, context.signal, false, context.input.baseBranch))
            .preflight!(context);
        },
        execute: async (context) =>
          (await create(context.operation, context.signal)).execute(context),
        verify: async (context, result) =>
          (await create(context.operation, context.signal)).verify(context, result),
        recover: async (operation, recoverySignal) => {
          const saved = operation.recoveryIntent as Record<string, unknown> | null;
          if (
            saved?.publicationGrantId !== grant.id ||
            saved?.publicationBindingHash !== grant.bindingHash ||
            !operation.approvalInput ||
            createHash('sha256').update(canonicalJson(operation.approvalInput)).digest('hex') !==
              operation.approvalHash
          )
            throw new Error('Approved publication recovery binding unavailable');
          return (await create(operation, recoverySignal, true)).recover(operation, recoverySignal);
        },
      };
      const executor = guardSealedPublicationExecutor(this.deps.authority, () => selection, base);
      const original = connectionTemplateRegistry.getCapabilityTemplate('github.publish-pr', 1)!;
      const template = {
        ...original,
        connectionTemplates: [{ id: 'sealed-publication', version: 1 }],
      };
      const connection = {
        id: connectionId,
        revision: 1,
        status: 'active',
        templateId: 'sealed-publication',
        templateVersion: 1,
        desiredAccountIds: [accountId],
      };
      service = new CapabilityService({
        ownsOperation: (operation) => operation.connectionId === connectionId,
        beforeRecoveryPersist: (operation) => {
          const context = retained?.recovery;
          if (context) {
            this.assertRecovery(retained!, operation, context);
            this.validateRecoveryOperation(retained!, this.deps.operations.get(operation.id)!);
          }
        },
        store: this.deps.operations,
        executorRegistry: new CapabilityExecutorRegistry({ [template.executor]: executor }),
        getTemplate: (id, version) => (id === template.id && version === 1 ? template : undefined),
        getConnection: (id) =>
          id === connectionId &&
          this.deps.authority.isCurrent(grant.id, grant.bindingHash, initial.handle)
            ? connection
            : undefined,
        listConnections: () => [connection],
        isConnectionActiveForConversation: (id, account, session) =>
          id === connectionId &&
          account === accountId &&
          session === grant.scope.sessionId &&
          this.deps.authority.isCurrent(grant.id, grant.bindingHash, initial.handle),
        approve: async () => false,
      });
      service.setGrant({
        connectionId,
        connectionRevision: 1,
        capabilityId: template.id,
        capabilityVersion: 1,
        accountIds: [accountId],
        status: 'active',
      });
      retained = { service, grant, handle: initial.handle };
      this.services.set(grant.id, retained);
    }
    this.assertPublicationAvailable(
      grant.scope.sessionId,
      grant.scope.recordId,
      grant.scope.recordHash,
      { grantId: grant.id, turnId: input.turnId, idempotencyKey: input.idempotencyKey },
    );
    return service.invoke(
      {
        capabilityId: 'github.publish-pr',
        capabilityVersion: 1,
        connectionId,
        connectionRevision: 1,
        accountId,
        conversationId: grant.scope.sessionId,
        turnId: input.turnId,
        idempotencyKey: input.idempotencyKey,
        input: { ...input.publication, connectionId },
      },
      signal,
      approve,
    );
  }
}

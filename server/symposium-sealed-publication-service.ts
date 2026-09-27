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
import { GitHubCliHostPublisher } from './connections/capabilities/github-publish-pr-transport.js';
import {
  SealedPublicationAuthority,
  guardSealedPublicationExecutor,
  type SealedPublicationScope,
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

/** Separate controller-only service. No route installs it. Missing registration is
 * actionable unavailability; no live sandbox grant or ambient credential fallback. */
export class SealedPublicationService {
  private readonly services = new Map<string, CapabilityService>();
  constructor(
    private readonly deps: {
      authority: SealedPublicationAuthority;
      operations: CapabilityOperationStore;
      artifact: SealedPublicationArtifactTransport;
      credentialCustodianRegistered: boolean;
    },
  ) {}
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
    let service = this.services.get(grant.id);
    if (!service) {
      const selection = { grantId: grant.id, bindingHash: grant.bindingHash };
      const requireAuthority = async (requestSignal: AbortSignal) => {
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
      ) => {
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
          const output = await initial.handle.run(command, args, commandSignal);
          await requireAuthority(commandSignal);
          return { ...output, stderr: '' };
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
                  input.publication.baseBranch,
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
          return (await create(context.operation, context.signal)).preflight!(context);
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
      this.services.set(grant.id, service);
    }
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

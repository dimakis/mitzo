import { createHash } from 'node:crypto';
import type { ReviewContext } from './symposium-review-coordinator.js';
import {
  prepareSymposiumReviewPublication,
  type ReviewPublicationDependencies,
} from './symposium-review-publication.js';
import {
  createGithubPublishPrExecutor,
  type GithubHostPublisher,
  type GithubSandboxTransport,
} from './connections/capabilities/github-publish-pr.js';
import { canonicalJson } from './connections/capabilities/input-validation.js';
import type {
  CapabilityExecutor,
  CapabilityExecutionContext,
  CapabilityOperation,
} from './connections/capabilities/types.js';

/** A completed, durable host seal, NOT the pending seal intent or an unfenced scan.
 * withHold must prevent writer admission/dispatch/unsealing throughout work, and
 * check must verify exact custody, physical quiescence, artifact and seal generation.
 * No production implementation is installed by this prerequisite. */
export interface ReviewPublicationSeal {
  id: string;
  revision: string;
  artifactRevision: string;
  artifactHash: string;
  withHold<T>(operationId: string, work: (check: () => Promise<void>) => Promise<T>): Promise<T>;
}
export interface ReviewPublicationExecutorDependencies extends Omit<
  ReviewPublicationDependencies,
  'publisher'
> {
  publisher: GithubHostPublisher;
  exportBundle: GithubSandboxTransport['exportBundle'];
  /** Trusted interactive selection; never a model's review payload. Used only before approval. */
  resolveReview(
    operation: CapabilityOperation,
  ): { context: ReviewContext; recordId: string } | null;
  getPublicationSeal(context: ReviewContext, recordId: string): ReviewPublicationSeal | null;
}
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function intent(operation: CapabilityOperation) {
  const value = operation.recoveryIntent;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Review publication intent unavailable');
  for (const key of [
    'symposiumOwner',
    'symposiumRecordId',
    'symposiumRecordHash',
    'symposiumBinding',
    'symposiumSealId',
    'symposiumSealRevision',
  ])
    if (typeof value[key] !== 'string' || !value[key])
      throw new Error('Review publication intent invalid');
  return value as Record<string, string>;
}

/** Register only through CapabilityService: it owns forced approval, durable dispatch
 * and outcome recovery. This adapter does not install a review host or produce seals. */
export function createSymposiumReviewPublicationExecutor(
  deps: ReviewPublicationExecutorDependencies,
): CapabilityExecutor {
  const prepare = async (
    execution: CapabilityExecutionContext,
    phase: 'pending_approval' | 'verification_pending',
  ) => {
    const saved = phase === 'verification_pending' ? intent(execution.operation) : null;
    const selected = saved
      ? {
          context: { owner: saved.symposiumOwner, sessionId: execution.operation.conversationId },
          recordId: saved.symposiumRecordId,
        }
      : deps.resolveReview(execution.operation);
    if (!selected || selected.context.sessionId !== execution.operation.conversationId)
      throw new Error('Review publication selection unavailable');
    const prepared = await prepareSymposiumReviewPublication(
      deps,
      selected.context,
      selected.recordId,
      execution.input,
      execution.signal,
      phase,
    );
    if (canonicalJson(prepared.binding.operation) !== canonicalJson(execution.operation))
      throw new Error('Publication operation changed');
    const seal = deps.getPublicationSeal(selected.context, selected.recordId);
    if (
      !seal?.id ||
      !seal.revision ||
      seal.artifactRevision !== prepared.record.snapshot.artifactRevision ||
      seal.artifactHash !== prepared.record.snapshot.artifactHash
    )
      throw new Error('Completed publication seal unavailable');
    if (
      saved &&
      (saved.symposiumRecordHash !== prepared.record.contentHash ||
        saved.symposiumBinding !== prepared.bindingFingerprint ||
        saved.symposiumSealId !== seal.id ||
        saved.symposiumSealRevision !== seal.revision)
    )
      throw new Error('Approved review publication binding changed');
    if (
      saved &&
      (!execution.approvalInput ||
        canonicalJson(execution.approvalInput) !==
          canonicalJson(execution.operation.approvalInput) ||
        !execution.operation.approvalHash ||
        digest(execution.approvalInput) !== execution.operation.approvalHash)
    )
      throw new Error('Durable publication approval required');
    return { ...prepared, seal, selected };
  };
  const run = async <T>(
    execution: CapabilityExecutionContext,
    phase: 'pending_approval' | 'verification_pending',
    work: (
      executor: CapabilityExecutor,
      prepared: Awaited<ReturnType<typeof prepare>>,
    ) => Promise<T>,
  ) => {
    const prepared = await prepare(execution, phase);
    return prepared.seal.withHold(execution.operation.id, async (verifySeal) => {
      const check = async () => {
        await verifySeal();
        await prepared.check();
        await verifySeal();
      };
      const guarded =
        <A, R>(operation: (argument: A) => Promise<R>) =>
        async (argument: A): Promise<R> => {
          await check();
          const value = await operation(argument);
          await check();
          return value;
        };
      const executor = createGithubPublishPrExecutor({
        sandbox: { inspect: guarded(prepared.inspect), exportBundle: guarded(deps.exportBundle) },
        host: {
          policy: guarded((input) => deps.publisher.policy(input)),
          findOpen: guarded((input) => deps.publisher.findOpen(input)),
          reconstruct: async (input) => {
            await check();
            const reconstructed = await deps.publisher.reconstruct(input);
            try {
              await check();
              return reconstructed;
            } catch (error) {
              // The base executor has not received this directory yet.
              await deps.publisher.cleanup(
                reconstructed.cleanupDirectory ?? reconstructed.directory,
              );
              throw error;
            }
          },
          push: guarded((input) => deps.publisher.push(input)),
          create: guarded((input) => deps.publisher.create(input)),
          update: guarded((input) => deps.publisher.update(input)),
          read: guarded((input) => deps.publisher.read(input)),
          readBranch: guarded((input) => deps.publisher.readBranch(input)),
          // Host-only temporary-directory cleanup remains possible after revocation.
          cleanup: (directory) => deps.publisher.cleanup(directory),
        },
        resolveConversation: () => ({
          workspace: '/sandbox/symposium-artifacts',
          sandboxName: prepared.binding.sandboxName,
        }),
        resolvePublicConfig: () => prepared.binding.publicConfig,
      });
      await check();
      const result = await work(executor, prepared);
      await check();
      return result;
    });
  };
  return {
    preflight: (execution) =>
      run(execution, 'pending_approval', async (executor, prepared) => {
        const result = await executor.preflight!(execution);
        if (
          !result.recoveryIntent ||
          typeof result.recoveryIntent !== 'object' ||
          Array.isArray(result.recoveryIntent)
        )
          throw new Error('Publication recovery intent missing');
        return {
          ...result,
          recoveryIntent: {
            ...result.recoveryIntent,
            symposiumOwner: prepared.selected.context.owner,
            symposiumRecordId: prepared.record.recordId,
            symposiumRecordHash: prepared.record.contentHash,
            symposiumBinding: prepared.bindingFingerprint,
            symposiumSealId: prepared.seal.id,
            symposiumSealRevision: prepared.seal.revision,
          },
        };
      }),
    execute: (execution) =>
      run(execution, 'verification_pending', (executor) => executor.execute(execution)),
    verify: (execution, result) =>
      run(execution, 'verification_pending', (executor) => executor.verify(execution, result)),
    async recover(operation, signal) {
      // Recovery only reads the already-dispatched outcome. Changed live authority
      // cannot turn it into a new write or a new approval.
      intent(operation);
      const durable = deps.operations.get(operation.id);
      if (
        !durable ||
        canonicalJson(durable) !== canonicalJson(operation) ||
        operation.status !== 'verification_pending' ||
        !operation.approvalInput ||
        !operation.approvalHash ||
        digest(operation.approvalInput) !== operation.approvalHash
      )
        throw new Error('Durable approved publication recovery required');
      const forbidden = async (): Promise<never> => {
        throw new Error('Recovery mutation forbidden');
      };
      const executor = createGithubPublishPrExecutor({
        sandbox: { inspect: forbidden, exportBundle: forbidden },
        host: {
          ...deps.publisher,
          policy: forbidden,
          findOpen: (input) => deps.publisher.findOpen(input),
          read: (input) => deps.publisher.read(input),
          readBranch: (input) => deps.publisher.readBranch(input),
          reconstruct: forbidden,
          push: forbidden,
          create: forbidden,
          update: forbidden,
          cleanup: forbidden,
        },
        resolveConversation: () => {
          throw new Error('Recovery has no live execution');
        },
        resolvePublicConfig: () => ({}),
      });
      return executor.recover(operation, signal);
    },
  };
}

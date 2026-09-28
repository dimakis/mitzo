import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { SYMPOSIUM_ARTIFACT_TARGET } from './symposium-artifact-lease.js';
import { canonicalReviewJson } from './symposium-review-records.js';
import { WorkResultSchema } from '@mitzo/protocol';
import type { ImmutableReviewRecord, SymposiumReviewStore } from './symposium-review-workflows.js';
import type { CompletedArtifactSeal } from './symposium-physical-artifact-seal.js';
import type { SealedPublicationArtifactTransport } from './symposium-sealed-publication-service.js';
export interface CompletedPublicationHost {
  requireCompletedArtifactSeal(
    fenceId: string,
    signal: AbortSignal,
  ): Promise<CompletedArtifactSeal>;
  inspectCompletedArtifact: SealedPublicationArtifactTransport['inspectCompletedArtifact'];
  exportCompletedArtifactBundle: SealedPublicationArtifactTransport['exportCompletedArtifactBundle'];
}
export const completedSealHash = (seal: CompletedArtifactSeal) =>
  createHash('sha256').update(canonicalReviewJson(seal)).digest('hex');
/** The immutable verified record names the final host result. Its history binds
 * that result to one physical seal, including after a fix has sealed a successor. */
export function publicationSealFenceForRecord(record: ImmutableReviewRecord): string {
  const { snapshot } = record;
  const resultId = snapshot.workflow.currentResultId;
  const matches = snapshot.history
    .filter(
      (entry) => entry.action === 'initial_result_recorded' || entry.action === 'fix_recorded',
    )
    .map((entry) => WorkResultSchema.safeParse((entry.detail as { result?: unknown })?.result))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data)
    .filter(
      (result) =>
        result.resultId === resultId &&
        result.artifactRevision === snapshot.artifactRevision &&
        result.artifactHash === snapshot.artifactHash,
    );
  if (matches.length !== 1 || matches[0].evidenceRefs.length !== 1)
    throw new Error('Exact verified result seal unavailable');
  const reference = matches[0].evidenceRefs[0];
  if (!reference.startsWith('artifact-seal:') || reference.length <= 'artifact-seal:'.length)
    throw new Error('Exact verified result seal unavailable');
  return reference.slice('artifact-seal:'.length);
}
/** Only host-produced completed seals and existing trusted review records enter
 * this adapter. It never creates a review receipt or resurrects a writer lease. */
export function completedPublicationArtifact(deps: {
  store: SymposiumReviewStore;
  host: CompletedPublicationHost;
}): SealedPublicationArtifactTransport {
  return {
    async require(scope, signal) {
      const check = () => {
        signal.throwIfAborted();
        const record = deps.store.getReviewRecord('user', scope.sessionId, scope.recordId);
        if (!record || record.contentHash !== scope.recordHash)
          throw new Error('Publication review record changed');
        const workflow = deps.store.get(record.snapshot.workflowId);
        if (
          !workflow ||
          workflow.status !== 'verified' ||
          workflow.decisionCode ||
          workflow.artifactRevision !== record.snapshot.artifactRevision ||
          workflow.artifactHash !== record.snapshot.artifactHash ||
          deps.store.history(workflow.workflowId).at(-1)?.sequence !==
            record.snapshot.historySequence
        )
          throw new Error('Publication review record is no longer current');
        return record;
      };
      check();
      const seal = await deps.host.requireCompletedArtifactSeal(scope.sealId, signal);
      const record = check();
      const safePath =
        seal.repositoryPath === '.' ||
        seal.repositoryPath
          .split('/')
          .every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..');
      if (
        !safePath ||
        seal.fenceId !== scope.sealId ||
        seal.sessionId !== scope.sessionId ||
        completedSealHash(seal) !== scope.sealHash ||
        seal.git.commit !== record.snapshot.artifactRevision ||
        seal.git.committedTreeDigest !== record.snapshot.artifactHash
      )
        throw new Error('Publication completed artifact binding changed');
      return {
        workspace: SYMPOSIUM_ARTIFACT_TARGET,
        repositoryPath: posix.join(SYMPOSIUM_ARTIFACT_TARGET, seal.repositoryPath),
        sourceOid: seal.git.commit,
      };
    },
    inspectCompletedArtifact: (input, signal) => deps.host.inspectCompletedArtifact(input, signal),
    exportCompletedArtifactBundle: (input, signal) =>
      deps.host.exportCompletedArtifactBundle(input, signal),
  };
}

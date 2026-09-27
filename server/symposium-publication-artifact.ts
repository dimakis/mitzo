import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import { canonicalReviewJson } from './symposium-review-records.js';
import type { SymposiumReviewStore } from './symposium-review-workflows.js';
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
/** Only host-produced completed seals and existing trusted review records enter
 * this adapter. It never creates a review receipt or resurrects a writer lease. */
export function completedPublicationArtifact(deps: {
  store: SymposiumReviewStore;
  workspace: string;
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
      const path = relative(deps.workspace, seal.repositoryPath);
      if (
        !isAbsolute(deps.workspace) ||
        !isAbsolute(seal.repositoryPath) ||
        path === '..' ||
        path.startsWith(`..${sep}`) ||
        isAbsolute(path) ||
        seal.fenceId !== scope.sealId ||
        seal.sessionId !== scope.sessionId ||
        completedSealHash(seal) !== scope.sealHash ||
        seal.git.commit !== record.snapshot.artifactRevision ||
        seal.git.committedTreeDigest !== record.snapshot.artifactHash
      )
        throw new Error('Publication completed artifact binding changed');
      return {
        workspace: deps.workspace,
        repositoryPath: seal.repositoryPath,
        sourceOid: seal.git.commit,
      };
    },
    inspectCompletedArtifact: (input, signal) => deps.host.inspectCompletedArtifact(input, signal),
    exportCompletedArtifactBundle: (input, signal) =>
      deps.host.exportCompletedArtifactBundle(input, signal),
  };
}

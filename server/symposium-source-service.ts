import { assertSourceVolume } from './symposium-source-physical-evidence.js';
import { SymposiumConfigSchema } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { SymposiumSessionArtifacts } from './symposium-session-artifacts.js';
import type { SourceManifest } from './symposium-source-git.js';
import {
  importSourceArtifact,
  SOURCE_IMPORT_CONTRACT,
  SourceImportAttemptError,
} from './symposium-source-import.js';
import type { SymposiumArtifactOwner } from './symposium-artifact-owner.js';
export type SourceImportRequest = {
  sessionId: string;
  expectedRevision: number;
  expectedGeneration: string;
  operationId: string;
  actor: string;
  manifest: SourceManifest;
  bundle: Buffer;
};
export type SymposiumSourceHost = ReturnType<typeof createSymposiumSourceHost>;
export function createSymposiumSourceHost(deps: {
  artifacts: SymposiumSessionArtifacts;
  facts: Pick<EventStore, 'getSession'>;
  owner: SymposiumArtifactOwner;
  workspace: string;
  custody(): void;
  command(args: readonly string[], input?: Buffer): Promise<string>;
}) {
  const scope = (request: SourceImportRequest) => {
    deps.custody();
    const session = deps.facts.getSession(request.sessionId);
    const parsed = SymposiumConfigSchema.safeParse(
      session?.symposiumConfig ? JSON.parse(session.symposiumConfig) : null,
    );
    if (
      session?.sessionType !== 'symposium' ||
      !parsed.success ||
      parsed.data.version !== 2 ||
      parsed.data.revision !== request.expectedRevision
    )
      throw Error('Source import session revision changed');
  };
  return {
    status: (sessionId: string) => {
      deps.custody();
      return deps.artifacts.sourceImportStatus(sessionId);
    },
    async import(request: SourceImportRequest, authorize: () => void) {
      scope(request);
      authorize();
      const claim = deps.artifacts.beginSourceImport(request.sessionId, {
        operationId: request.operationId,
        expectedGeneration: request.expectedGeneration,
        source: {
          actor: request.actor,
          configRevision: request.expectedRevision,
          manifest: request.manifest,
          importer: SOURCE_IMPORT_CONTRACT,
        },
      });
      try {
        const proof = await importSourceArtifact({
          name: claim.volumeName,
          owner: deps.owner,
          bundle: request.bundle,
          manifest: request.manifest,
          command: deps.command,
          custody: deps.custody,
          verifyVolume: (helperId) =>
            assertSourceVolume({
              mapping: claim,
              workspace: deps.workspace,
              owner: deps.owner,
              command: deps.command,
              helperId,
            }),
          authorize: () => {
            scope(request);
            authorize();
          },
          receipt: deps.artifacts.sourceImportHelperReceipt(claim),
          observed: (value) => deps.artifacts.observeSourceImport(claim, value),
        });
        const receipt = {
          ...proof,
          manifest: request.manifest,
          importer: SOURCE_IMPORT_CONTRACT,
          operationId: request.operationId,
        };
        deps.artifacts.completeSourceImport(claim, receipt);
        return receipt;
      } catch (error) {
        deps.artifacts.failSourceImport(
          claim,
          error instanceof SourceImportAttemptError
            ? {
                outcome: error.outcome,
                ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
              }
            : { outcome: 'uncertain' },
        );
        throw error;
      }
    },
  };
}

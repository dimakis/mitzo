import { createHash } from 'node:crypto';
import { canonicalJson } from './connections/capabilities/input-validation.js';
import type { JsonValue } from './connections/types.js';
import type { GithubSandboxInspection } from './connections/capabilities/github-publish-pr.js';
import type { GithubPublishingSource } from './github-publishing-tool.js';
import type { GithubSeedBaseline } from './github-seed-baselines.js';
import { GithubSeedPublicationError, type SeededChangeInput } from './github-seeded-source.js';
export interface SeededGitState {
  status: string;
  seedOid: string;
  seedTreeOid: string;
  originalSourceOid: string;
  sourceBranch: string;
  commitsAhead: number;
  changedFiles: string[];
}
export interface SeedPublicationSource {
  source: GithubPublishingSource;
  repositoryPath: string;
  baseBranch: string;
  signal: AbortSignal;
}
type Projection = {
  sourceOid: string;
  sourceBranch: string;
  baseOid: string;
  patchSha256: string;
  bundle: Buffer;
};
export class GithubSeededPublication {
  private readonly cache = new Map<string, { key: string; projection: Projection }>();
  constructor(
    private readonly deps: {
      read(input: SeedPublicationSource): Promise<SeededGitState>;
      baseline(tree: string, signal: AbortSignal): Promise<GithubSeedBaseline>;
      export(input: SeedPublicationSource, state: SeededGitState): Promise<Buffer>;
      project(input: SeededChangeInput): Promise<Projection>;
    },
  ) {}
  private async selection(input: SeedPublicationSource) {
    const state = await this.deps.read(input);
    if (state.status !== '')
      throw new GithubSeedPublicationError(
        'SEEDED_WORKSPACE_DIRTY',
        'Commit or preserve outstanding workspace changes before publishing',
      );
    if (
      state.changedFiles.length > 64 ||
      state.changedFiles.some(
        (p) =>
          p.length > 120 || [...p].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
      )
    )
      throw new GithubSeedPublicationError(
        'SEEDED_SCOPE_TOO_LARGE',
        'Seeded publication scope exceeds the approval limit',
      );
    return { state, binding: await this.deps.baseline(state.seedTreeOid, input.signal) };
  }
  async resolveRepository(input: SeedPublicationSource) {
    return (await this.selection(input)).binding.repository;
  }
  async inspect(
    input: SeedPublicationSource & {
      operationId: string;
      approvalInput?: JsonValue | null;
      authorize(repository: string): void;
    },
  ): Promise<GithubSandboxInspection> {
    const { state, binding } = await this.selection(input);
    input.authorize(binding.repository);
    const patch = await this.deps.export(input, state),
      patchSha256 = createHash('sha256').update(patch).digest('hex');
    const approved =
      input.approvalInput &&
      !Array.isArray(input.approvalInput) &&
      typeof input.approvalInput === 'object'
        ? input.approvalInput
        : undefined;
    const identity = createHash('sha256')
      .update(
        canonicalJson({
          source: input.source,
          path: input.repositoryPath,
          baseline: binding.fingerprint,
          originalSourceOid: state.originalSourceOid,
          sourceBranch: state.sourceBranch,
          baseBranch: input.baseBranch,
          patchSha256,
        }),
      )
      .digest('hex');
    if (
      approved &&
      (approved.seedSourceIdentity !== identity ||
        approved.originalSourceOid !== state.originalSourceOid ||
        typeof approved.projectedBaseOid !== 'string')
    )
      throw new GithubSeedPublicationError(
        'SEEDED_APPROVAL_CHANGED',
        'Seeded publication changed after approval; request a new review',
      );
    const cached = this.cache.get(input.operationId);
    const projection =
      cached?.key === identity
        ? cached.projection
        : await this.deps.project({
            repository: binding.repository,
            sourceBranch: state.sourceBranch,
            baseBranch: input.baseBranch,
            originalSourceOid: state.originalSourceOid,
            seedTreeOid: state.seedTreeOid,
            seedUpstreamOid: binding.upstreamOid,
            patch,
            signal: input.signal,
            ...(approved ? { baseOid: String(approved.projectedBaseOid) } : {}),
          });
    if (
      approved &&
      (projection.baseOid !== approved.projectedBaseOid ||
        projection.sourceOid !== approved.sourceOid)
    )
      throw new GithubSeedPublicationError(
        'SEEDED_APPROVAL_CHANGED',
        'Seeded publication changed after approval; request a new review',
      );
    this.cache.delete(input.operationId);
    this.cache.set(input.operationId, { key: identity, projection });
    while (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!);
    return {
      canonicalRepositoryPath: input.repositoryPath,
      status: state.status,
      sourceBranch: projection.sourceBranch,
      sourceOid: projection.sourceOid,
      originUrl: `https://github.com/${binding.repository}.git`,
      commitsAhead: 1,
      changedFiles: state.changedFiles,
      defaultBranch: '',
      sourceBranchProtected: false,
      symlinkFree: true,
      seededPublication: {
        originalSourceOid: state.originalSourceOid,
        seedTreeOid: state.seedTreeOid,
        projectedBaseOid: projection.baseOid,
        patchSha256,
        seedSourceIdentity: identity,
        originalCommitCount: String(state.commitsAhead),
        originalSourceBranch: state.sourceBranch,
      },
    };
  }
  bundle(operationId: string, sourceOid: string, maxBytes: number): Buffer {
    const projection = this.cache.get(operationId)?.projection;
    if (!projection || projection.sourceOid !== sourceOid || projection.bundle.length > maxBytes)
      throw new GithubSeedPublicationError(
        'SEEDED_EXPORT_CHANGED',
        'Seeded publication export no longer matches the approved commit',
      );
    return Buffer.from(projection.bundle);
  }
}

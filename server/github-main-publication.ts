import type { GithubMainMergeDispatch } from './github-main-publication-dispatch.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  GitHubCliHostPublisher,
  type GithubHostCommandRunner,
} from './connections/capabilities/github-publish-pr-transport.js';
import { finalKnowledgeApproval } from './knowledge-github-publisher.js';
import {
  githubCommit,
  MainPublicationResourceSchema,
  RequestGithubMainPublicationSchema,
  normalPrPublicationContract,
  type MainPublicationInput,
  type MainPublicationResource,
  type GithubMainMergeCapability,
  type MainPublicationInspection,
  type MainPublicationPins,
} from './telos-main-publication-contract.js';

const configuration = z.strictObject({
  connectionId: z.string().min(1),
  capabilityId: z.string().min(1),
  repository: z.string().regex(/^[a-z0-9-]+\/[a-z0-9_.-]+$/),
  publisherLogin: z.string().regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i),
  trustedReviewer: z.string().regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i),
  centaurAppId: z.number().int().positive(),
  requiredChecks: z.array(z.string().min(1)).min(1),
});
export type GithubMainPublicationConfiguration = z.infer<typeof configuration>;
const prSchema = z.object({
  id: z.number().int().positive().safe(),
  node_id: z.string().trim().min(1).max(200),
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  merged: z.boolean(),
  merge_commit_sha: githubCommit.nullable(),
  head: z.object({
    sha: githubCommit,
    repo: z.object({
      id: z.number().int().positive().safe(),
      node_id: z.string().min(1).max(200),
      full_name: z.string(),
    }),
  }),
  base: z.object({
    ref: z.string(),
    sha: githubCommit,
    repo: z.object({
      id: z.number().int().positive().safe(),
      node_id: z.string().min(1).max(200),
      full_name: z.string(),
    }),
  }),
});
const repositorySchema = z.object({
  id: z.number().int().positive().safe(),
  node_id: z.string().trim().min(1).max(200),
  full_name: z.string().regex(/^[a-z0-9-]+\/[a-z0-9_.-]+$/i),
});
const databaseId = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .transform(Number),
  ])
  .pipe(z.number().int().positive().safe());
const resourceQuery =
  'query($repository:ID!,$pullRequest:ID!){repository:node(id:$repository){__typename ... on Repository{fullDatabaseId nameWithOwner ref(qualifiedName:"refs/heads/main"){target{oid}}}} pullRequest:node(id:$pullRequest){__typename ... on PullRequest{fullDatabaseId number repository{fullDatabaseId nameWithOwner}}}}';
const mergeQuery =
  'mutation($pullRequest:ID!,$head:GitObjectID!){mergePullRequest(input:{pullRequestId:$pullRequest,expectedHeadOid:$head,mergeMethod:SQUASH}){pullRequest{id fullDatabaseId number headRefOid baseRefName merged mergeCommit{oid} repository{id fullDatabaseId}}}}';
const protectionSchema = z.object({
  enforce_admins: z.object({ enabled: z.literal(true) }),
  required_status_checks: z.object({
    strict: z.literal(true),
    contexts: z.array(z.string()),
    checks: z.array(z.object({ context: z.string(), app_id: z.number().int().positive() })),
  }),
});

/** Explicit configured capability and explicitly supplied isolated command runner.
 * No ambient credential/default runner, knowledge approval, branch/PR export,
 * admin flag, checkout, push, ready/auto-merge or new GitHub grant is installed.
 * The reused Centaur parser is syntax/chronology inspection only.
 */
export class GithubMainPublication implements GithubMainMergeCapability {
  readonly kind = 'github-main-merge' as const;
  readonly connectionId: string;
  readonly capabilityId: string;
  readonly repository: string;
  private readonly config: Readonly<Omit<GithubMainPublicationConfiguration, 'requiredChecks'>> & {
    readonly requiredChecks: readonly string[];
  };
  private readonly identity: GitHubCliHostPublisher;
  private readonly command: GithubHostCommandRunner;
  constructor(
    config: GithubMainPublicationConfiguration,
    run: GithubHostCommandRunner,
    private readonly dispatchMerge: GithubMainMergeDispatch,
  ) {
    if (typeof run !== 'function' || typeof dispatchMerge !== 'function')
      throw new Error('Explicit read runner and admission-bound merge dispatcher required');
    const parsed = configuration.parse(config);
    this.config = Object.freeze({
      ...parsed,
      requiredChecks: Object.freeze([...parsed.requiredChecks]),
    });
    this.connectionId = parsed.connectionId;
    this.capabilityId = parsed.capabilityId;
    this.repository = parsed.repository;
    this.command = (program, args, signal) =>
      run(program, args, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
    this.identity = new GitHubCliHostPublisher(this.command);
  }
  private checked(pins: MainPublicationPins) {
    if (pins.contract !== undefined && pins.contract !== normalPrPublicationContract)
      throw new Error('Unsupported publication contract');
    MainPublicationResourceSchema.parse(pins.resource);
    if (pins.contract === normalPrPublicationContract)
      RequestGithubMainPublicationSchema.parse(pins.input);
    if (
      pins.authority.connectionId !== this.connectionId ||
      pins.authority.capabilityId !== this.capabilityId ||
      pins.authority.repository !== this.repository ||
      pins.baseBranch !== 'main' ||
      pins.method !== 'squash' ||
      !Number.isSafeInteger(pins.input.pullRequest) ||
      pins.input.pullRequest <= 0
    )
      throw new Error('Configured main publication scope changed');
    githubCommit.parse(pins.input.sourceHead);
    if (pins.contract !== normalPrPublicationContract) githubCommit.parse(pins.input.mainHead);
  }
  async resolveResource(
    input: MainPublicationInput,
    signal: AbortSignal,
  ): Promise<MainPublicationResource> {
    RequestGithubMainPublicationSchema.parse(input);
    if (
      (await this.identity.identity(signal)).toLowerCase() !==
      this.config.publisherLogin.toLowerCase()
    )
      throw new Error('Configured GitHub merge account changed');
    const repository = repositorySchema.parse(await this.get(`repos/${this.repository}`, signal));
    if (repository.full_name.toLowerCase() !== this.repository)
      throw new Error('Configured repository name changed; new intent needs current configuration');
    const pr = prSchema.parse(
      await this.get(`repos/${this.repository}/pulls/${input.pullRequest}`, signal),
    );
    if (
      pr.number !== input.pullRequest ||
      pr.base.ref !== 'main' ||
      pr.head.sha !== input.sourceHead ||
      pr.base.repo.id !== repository.id ||
      pr.head.repo.id !== repository.id ||
      pr.base.repo.node_id !== repository.node_id ||
      pr.head.repo.node_id !== repository.node_id ||
      pr.base.repo.full_name.toLowerCase() !== this.repository ||
      pr.head.repo.full_name.toLowerCase() !== this.repository
    )
      throw new Error('GitHub publication resource identity is not exact');
    return Object.freeze(
      MainPublicationResourceSchema.parse({
        repositoryId: repository.id,
        repositoryNodeId: repository.node_id,
        pullRequestId: pr.id,
        pullRequestNodeId: pr.node_id,
      }),
    );
  }
  private async resourceSnapshot(pins: MainPublicationPins, signal: AbortSignal) {
    signal.throwIfAborted();
    const response = await this.command(
      'gh',
      [
        'api',
        'graphql',
        '-f',
        `query=${resourceQuery}`,
        '-f',
        `repository=${pins.resource.repositoryNodeId}`,
        '-f',
        `pullRequest=${pins.resource.pullRequestNodeId}`,
      ],
      signal,
    );
    signal.throwIfAborted();
    const data = z
      .object({
        errors: z.array(z.unknown()).max(0).optional(),
        data: z.object({
          repository: z.object({
            __typename: z.literal('Repository'),
            fullDatabaseId: databaseId,
            nameWithOwner: repositorySchema.shape.full_name,
            ref: z.object({ target: z.object({ oid: githubCommit }) }),
          }),
          pullRequest: z.object({
            __typename: z.literal('PullRequest'),
            fullDatabaseId: databaseId,
            number: z.number().int().positive().safe(),
            repository: z.object({
              fullDatabaseId: databaseId,
              nameWithOwner: repositorySchema.shape.full_name,
            }),
          }),
        }),
      })
      .parse(JSON.parse(response.stdout)).data;
    if (
      data.repository.fullDatabaseId !== pins.resource.repositoryId ||
      data.pullRequest.fullDatabaseId !== pins.resource.pullRequestId ||
      data.pullRequest.number !== pins.input.pullRequest ||
      data.pullRequest.repository.fullDatabaseId !== pins.resource.repositoryId ||
      data.repository.nameWithOwner.toLowerCase() !==
        data.pullRequest.repository.nameWithOwner.toLowerCase()
    )
      throw new Error('Retained GitHub resource identity changed');
    return {
      repository: data.repository.nameWithOwner.toLowerCase(),
      mainHead: data.repository.ref.target.oid,
    };
  }
  private async get(path: string, signal: AbortSignal, paginate = false): Promise<unknown> {
    signal.throwIfAborted();
    const result = await this.command(
      'gh',
      ['api', '--method', 'GET', path, ...(paginate ? ['--paginate', '--slurp'] : [])],
      signal,
    );
    signal.throwIfAborted();
    return JSON.parse(result.stdout);
  }
  private async pr(pins: MainPublicationPins, signal: AbortSignal) {
    const { repository } = await this.resourceSnapshot(pins, signal);
    const pr = prSchema.parse(
      await this.get(`repos/${repository}/pulls/${pins.input.pullRequest}`, signal),
    );
    if (
      pr.number !== pins.input.pullRequest ||
      pr.id !== pins.resource.pullRequestId ||
      pr.base.repo.id !== pins.resource.repositoryId ||
      pr.head.repo.id !== pins.resource.repositoryId ||
      pr.head.sha !== pins.input.sourceHead ||
      pr.head.repo.full_name.toLowerCase() !== repository ||
      pr.base.repo.full_name.toLowerCase() !== repository ||
      pr.base.ref !== 'main'
    )
      throw new Error('GitHub main publication PR scope changed');
    return pr;
  }
  private async main(signal: AbortSignal, repository: string) {
    return z
      .object({ object: z.object({ sha: githubCommit }) })
      .parse(await this.get(`repos/${repository}/git/ref/heads/main`, signal)).object.sha;
  }
  private async accepted(
    pr: z.infer<typeof prSchema>,
    pins: MainPublicationPins,
    signal: AbortSignal,
  ): Promise<MainPublicationInspection> {
    if (!pr.merged || pr.state !== 'closed' || !pr.merge_commit_sha) return { state: 'blocked' };
    const repository = pr.base.repo.full_name.toLowerCase();
    const merge = z
      .object({
        sha: githubCommit,
        parents: z.array(z.object({ sha: githubCommit })),
        tree: z.object({ sha: githubCommit }),
      })
      .parse(await this.get(`repos/${repository}/git/commits/${pr.merge_commit_sha}`, signal));
    if (
      merge.sha !== pr.merge_commit_sha ||
      merge.parents.length !== 1 ||
      (pins.contract !== normalPrPublicationContract &&
        merge.parents[0]?.sha !== pins.input.mainHead)
    )
      return { state: 'blocked' };
    const source = z
      .object({ sha: githubCommit, tree: z.object({ sha: githubCommit }) })
      .parse(await this.get(`repos/${repository}/git/commits/${pins.input.sourceHead}`, signal));
    if (source.sha !== pins.input.sourceHead || source.tree.sha !== merge.tree.sha)
      return { state: 'blocked' };
    const main = await this.main(signal, repository);
    const ancestry = z
      .object({
        status: z.enum(['ahead', 'behind', 'identical', 'diverged']),
        merge_base_commit: z.object({ sha: githubCommit }),
      })
      .parse(await this.get(`repos/${repository}/compare/${merge.sha}...${main}`, signal));
    if (
      !['ahead', 'identical'].includes(ancestry.status) ||
      ancestry.merge_base_commit.sha !== merge.sha
    )
      return { state: 'blocked' };
    // Recheck the observed main on the immutable repository object, so a name
    // move/reuse during REST routing cannot supply another repository's fact.
    if ((await this.resourceSnapshot(pins, signal)).mainHead !== main) return { state: 'blocked' };
    return {
      state: 'accepted',
      mergeCommit: merge.sha,
      baseHead: merge.parents[0]!.sha,
      mainHead: main,
    };
  }
  async inspect(
    pins: MainPublicationPins,
    signal: AbortSignal,
  ): Promise<MainPublicationInspection> {
    this.checked(pins);
    if (
      (await this.identity.identity(signal)).toLowerCase() !==
      this.config.publisherLogin.toLowerCase()
    )
      throw new Error('Configured GitHub merge account changed');
    const initial = await this.pr(pins, signal);
    if (initial.merged) return this.accepted(initial, pins, signal);
    if (pins.contract !== normalPrPublicationContract) return { state: 'blocked' };
    // Name changes can recover original factual results by ID. They cannot
    // become new open-PR publication authority under the old configured name.
    if (initial.base.repo.full_name.toLowerCase() !== this.repository) return { state: 'blocked' };
    if (initial.state !== 'open' || initial.draft) return { state: 'blocked' };
    const inspectedMain = await this.main(signal, this.repository);
    if (initial.base.sha !== inspectedMain) return { state: 'blocked' };
    const protection = protectionSchema.parse(
      await this.get(`repos/${this.repository}/branches/main/protection`, signal),
    );
    const requirements = protection.required_status_checks;
    if (
      !this.config.requiredChecks.every(
        (name) =>
          requirements.contexts.includes(name) &&
          requirements.checks.some((c) => c.context === name),
      ) ||
      !this.config.requiredChecks.includes('Centaur final LGTM') ||
      !requirements.checks.some(
        (c) => c.context === 'Centaur final LGTM' && c.app_id === this.config.centaurAppId,
      )
    )
      return { state: 'blocked' };
    // Normal PR rules: the observed main must be included in H. It is not a
    // frozen approved-base CAS; later main advancement is enforced by GitHub.
    const ancestry = z
      .object({
        status: z.enum(['ahead', 'behind', 'identical', 'diverged']),
        merge_base_commit: z.object({ sha: githubCommit }),
      })
      .parse(
        await this.get(
          `repos/${this.repository}/compare/${inspectedMain}...${pins.input.sourceHead}`,
          signal,
        ),
      );
    if (
      !['ahead', 'identical'].includes(ancestry.status) ||
      ancestry.merge_base_commit.sha !== inspectedMain
    )
      return { state: 'blocked' };
    const reports: unknown[] = [];
    for (const path of [
      `pulls/${pins.input.pullRequest}/reviews`,
      `issues/${pins.input.pullRequest}/comments`,
    ])
      reports.push(
        ...z
          .array(z.array(z.unknown()))
          .parse(await this.get(`repos/${this.repository}/${path}`, signal, true))
          .flat(),
      );
    if (!finalKnowledgeApproval(reports, pins.input.sourceHead, this.config.trustedReviewer))
      return { state: 'blocked' };
    const checksResponse = await this.command(
      'gh',
      [
        'pr',
        'checks',
        String(pins.input.pullRequest),
        '--repo',
        this.repository,
        '--required',
        '--json',
        'name,bucket,state',
      ],
      signal,
    );
    const checks = z
      .array(z.object({ name: z.string(), bucket: z.string(), state: z.string() }))
      .parse(JSON.parse(checksResponse.stdout));
    if (
      !checks.length ||
      checks.some((c) => c.bucket !== 'pass' || c.state !== 'SUCCESS') ||
      !requirements.contexts.every((name) =>
        checks.some((c) => c.name === name && c.bucket === 'pass'),
      )
    )
      return { state: 'blocked' };
    const current = await this.pr(pins, signal);
    if (
      current.merged ||
      current.state !== 'open' ||
      current.draft ||
      current.base.sha !== inspectedMain ||
      (await this.main(signal, this.repository)) !== inspectedMain
    )
      return { state: 'blocked' };
    return {
      state: 'ready',
      mainHead: inspectedMain,
      evidenceRef: createHash('sha256')
        .update(JSON.stringify({ current, protection, reports, checks, ancestry, inspectedMain }))
        .digest('hex'),
    };
  }
  async merge(
    pins: MainPublicationPins,
    signal: AbortSignal,
    admit: (inspection: Extract<MainPublicationInspection, { state: 'ready' }>) => void,
    acknowledge: (mergeCommit: string) => void,
  ): Promise<MainPublicationInspection> {
    if (pins.contract !== normalPrPublicationContract) return { state: 'blocked' };
    const inspection = await this.inspect(pins, signal);
    if (inspection.state !== 'ready') return { state: 'blocked' };
    signal.throwIfAborted();
    let admissionAttempted = false;
    let admitted = false;
    const dispatchSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    // One head-CAS squash under normal remote protections. Main is allowed to
    // advance; do not describe this observed admission base as a remote CAS.
    const response = await this.dispatchMerge(
      'gh',
      [
        'api',
        'graphql',
        '-f',
        `query=${mergeQuery}`,
        '-f',
        `pullRequest=${pins.resource.pullRequestNodeId}`,
        '-f',
        `head=${pins.input.sourceHead}`,
      ],
      dispatchSignal,
      () => {
        if (admissionAttempted) throw new Error('Merge dispatch admission is one-use');
        admissionAttempted = true;
        dispatchSignal.throwIfAborted();
        admit(inspection);
        admitted = true;
      },
    );
    if (!admitted) throw new Error('Merge dispatcher did not admit this operation');
    const result = z
      .object({
        errors: z.array(z.unknown()).max(0).optional(),
        data: z.object({
          mergePullRequest: z.object({
            pullRequest: z.object({
              id: z.literal(pins.resource.pullRequestNodeId),
              fullDatabaseId: databaseId.refine((id) => id === pins.resource.pullRequestId),
              number: z.literal(pins.input.pullRequest),
              headRefOid: z.literal(pins.input.sourceHead),
              baseRefName: z.literal('main'),
              merged: z.literal(true),
              mergeCommit: z.object({ oid: githubCommit }),
              repository: z.object({
                id: z.literal(pins.resource.repositoryNodeId),
                fullDatabaseId: databaseId.refine((id) => id === pins.resource.repositoryId),
              }),
            }),
          }),
        }),
      })
      .parse(JSON.parse(response.stdout)).data.mergePullRequest.pullRequest;
    acknowledge(result.mergeCommit.oid);
    const observed = await this.inspect(pins, signal);
    if (observed.state !== 'accepted') return { state: 'blocked' };
    if (observed.mergeCommit !== result.mergeCommit.oid) return { state: 'conflicted', observed };
    return observed;
  }
}

import {
  GithubMainPublication,
  type GithubMainPublicationConfiguration,
} from '../../github-main-publication.js';
import { type MainPublicationPins } from '../../telos-main-publication-contract.js';

export const head = 'a'.repeat(40),
  main = 'b'.repeat(40),
  merge = 'c'.repeat(40);
export const pins: MainPublicationPins = {
  contract: 'normal-pr-rules-v1',
  input: {
    requestId: 'publish-1',
    itemId: 'feature',
    pullRequest: 7,
    sourceHead: head,
    workRevision: 'revision-1',
  },
  authority: {
    operatorId: 'operator',
    conversationId: 'lead',
    accountBinding: {
      accountId: 'account',
      provider: 'openai-codex',
      model: 'offline-fixture',
      profileRevision: 'profile-1',
    },
    runtimeId: 'runtime',
    connectionId: 'github-connection',
    capabilityId: 'separate-main-capability',
    repository: 'owner/project',
    assignmentRevision: 1,
    attemptId: null,
  },
  resource: {
    repositoryId: 101,
    repositoryNodeId: 'R_original',
    pullRequestId: 701,
    pullRequestNodeId: 'PR_original',
  },
  baseBranch: 'main',
  method: 'squash',
};
export const config: GithubMainPublicationConfiguration = {
  repository: 'owner/project',
  connectionId: 'github-connection',
  capabilityId: 'separate-main-capability',
  publisherLogin: 'publisher',
  trustedReviewer: 'centaur',
  centaurAppId: 731,
  requiredChecks: ['CI', 'Centaur final LGTM'],
};
export const approved = `<!-- centaur:sha:${head} -->\n## Centaur Review\nLGTM — no issues found.\n\n### Convergence\n**Recommendation:** \`merge\`\n- New blocking findings: 0\n- Unresolved blocking findings: 0\n`;
/** Only the external GitHub command boundary is fake. No owned approval,
 * publication receipt, router, native registration or runtime is fabricated. */
export function fixture(selected: MainPublicationPins = pins) {
  const state = {
    identity: 'publisher',
    pullRequestNumber: selected.input.pullRequest,
    beforePut: () => {},
    afterMutation: async () => {},
    prepareDispatch: async () => {},
    mutationReply: (value: unknown): unknown => value,
    nameReused: false,
    wrongResourceMutations: 0,
    acknowledgementSha: merge,
    sourceTree: 'e'.repeat(40),
    mergeTree: 'e'.repeat(40),
    nodeMainHead: null as string | null,
    repositoryId: selected.resource.repositoryId,
    repositoryNodeId: selected.resource.repositoryNodeId,
    pullRequestId: selected.resource.pullRequestId,
    pullRequestNodeId: selected.resource.pullRequestNodeId,
    repositoryName: selected.authority.repository,
    omitIdentity: false,
    sourceHead: selected.input.sourceHead,
    currentMain: main,
    base: main,
    draft: false,
    strict: true,
    enforceAdmins: true,
    centaurAppId: 731,
    protectedChecks: ['CI', 'Centaur final LGTM'],
    checkNames: ['CI', 'Centaur final LGTM'],
    checkBucket: 'pass',
    checkState: 'SUCCESS',
    reportBody: approved,
    reviewer: 'centaur',
    reviewState: 'COMMENTED',
    extraReports: [] as unknown[],
    merged: false,
    parent: main,
    contained: true,
    headContainsBase: true,
    loseReply: false,
    refuse: false,
    mutations: 0,
    afterRead: (_path: string) => {},
  };
  const calls: Array<{ program: string; args: readonly string[] }> = [];
  const run = async (
    program: string,
    args: readonly string[],
    signal?: AbortSignal,
    admit?: () => void,
  ) => {
    calls.push({ program, args });
    let result: unknown;
    const path = args[0] === 'pr' ? 'checks' : (args[3] ?? args[1]!);
    if (args[0] === 'api' && args[1] === 'user') result = { login: state.identity };
    else if (
      args[0] === 'api' &&
      args[1] === 'graphql' &&
      args.some((arg) => arg.includes('mergePullRequest('))
    ) {
      await state.prepareDispatch();
      signal?.throwIfAborted();
      admit?.();
      state.beforePut();
      // GitHub resolves the retained node ID, independent of reusable names.
      const exact =
        args.includes(`pullRequest=${state.pullRequestNodeId}`) &&
        args.includes(`head=${state.sourceHead}`) &&
        args.some((arg) => arg.includes('mergeMethod:SQUASH'));
      if (exact) {
        state.mutations++;
        if (
          !state.refuse &&
          state.headContainsBase &&
          state.checkBucket === 'pass' &&
          state.checkState === 'SUCCESS'
        ) {
          state.parent = state.currentMain;
          state.merged = true;
        }
      }
      await state.afterMutation();
      if (state.loseReply)
        throw new Error('External reply lost; private diagnostic must not be exposed');
      result = {
        data: {
          mergePullRequest: {
            pullRequest: {
              id: state.pullRequestNodeId,
              fullDatabaseId: String(state.pullRequestId),
              number: state.pullRequestNumber,
              headRefOid: state.sourceHead,
              baseRefName: 'main',
              merged: state.merged,
              mergeCommit: state.merged ? { oid: state.acknowledgementSha } : null,
              repository: {
                id: state.repositoryNodeId,
                fullDatabaseId: String(state.repositoryId),
              },
            },
          },
        },
      };
      result = state.mutationReply(result);
    } else if (args[0] === 'api' && args[1] === 'graphql')
      result = {
        data: {
          repository: {
            __typename: 'Repository',
            fullDatabaseId: String(state.repositoryId),
            nameWithOwner: state.repositoryName,
            ref: {
              target: { oid: state.nodeMainHead ?? (state.merged ? merge : state.currentMain) },
            },
          },
          pullRequest: {
            __typename: 'PullRequest',
            fullDatabaseId: String(state.pullRequestId),
            number: state.pullRequestNumber,
            repository: {
              fullDatabaseId: String(state.repositoryId),
              nameWithOwner: state.repositoryName,
            },
          },
        },
      };
    else if (
      path === `repos/${state.repositoryName}` ||
      path === `repos/${selected.authority.repository}`
    )
      result = {
        id: state.omitIdentity ? undefined : state.repositoryId,
        node_id: state.omitIdentity ? undefined : state.repositoryNodeId,
        full_name: state.repositoryName,
      };
    else if (args.includes('PUT')) {
      state.beforePut();
      state.mutations++;
      if (state.nameReused) {
        state.wrongResourceMutations++;
        result = { merged: true, sha: merge };
      } else {
        if (
          !state.refuse &&
          state.headContainsBase &&
          state.checkBucket === 'pass' &&
          state.checkState === 'SUCCESS' &&
          args.includes(`sha=${state.sourceHead}`)
        ) {
          state.parent = state.currentMain;
          state.merged = true;
        }
        await state.afterMutation();
      }
      if (state.loseReply)
        throw new Error('External reply lost; private diagnostic must not be exposed');
      if (!state.nameReused)
        result = {
          merged: state.merged,
          ...(state.merged ? { sha: state.acknowledgementSha } : {}),
        };
    } else if (path === 'checks')
      result = state.checkNames.map((name) => ({
        name,
        bucket: state.checkBucket,
        state: state.checkState,
      }));
    else if (path.endsWith(`/pulls/${state.pullRequestNumber}`))
      result = {
        id: state.omitIdentity ? undefined : state.pullRequestId,
        node_id: state.omitIdentity ? undefined : state.pullRequestNodeId,
        number: state.pullRequestNumber,
        state: state.merged ? 'closed' : 'open',
        draft: state.draft,
        merged: state.merged,
        merge_commit_sha: state.merged ? merge : null,
        head: {
          sha: state.sourceHead,
          repo: {
            id: state.omitIdentity ? undefined : state.repositoryId,
            node_id: state.omitIdentity ? undefined : state.repositoryNodeId,
            full_name: state.repositoryName,
          },
        },
        base: {
          ref: 'main',
          sha: state.base,
          repo: {
            id: state.omitIdentity ? undefined : state.repositoryId,
            node_id: state.omitIdentity ? undefined : state.repositoryNodeId,
            full_name: state.repositoryName,
          },
        },
      };
    else if (path.endsWith('/protection'))
      result = {
        enforce_admins: { enabled: state.enforceAdmins },
        required_status_checks: {
          strict: state.strict,
          contexts: state.protectedChecks,
          checks: state.protectedChecks.map((context) => ({
            context,
            app_id: context === 'Centaur final LGTM' ? state.centaurAppId : 153,
          })),
        },
      };
    else if (path.endsWith('/reviews'))
      result = [
        [
          {
            user: { login: state.reviewer },
            body: state.reportBody,
            commit_id: state.sourceHead,
            state: state.reviewState,
            submitted_at: '2026-10-20T09:00:00Z',
          },
          ...state.extraReports,
        ],
      ];
    else if (path.endsWith('/comments')) result = [[]];
    else if (path.endsWith('/git/ref/heads/main'))
      result = { object: { sha: state.merged ? merge : state.currentMain } };
    else if (path.endsWith(`/git/commits/${merge}`))
      result = { sha: merge, parents: [{ sha: state.parent }], tree: { sha: state.mergeTree } };
    else if (path.endsWith(`/git/commits/${state.sourceHead}`))
      result = { sha: state.sourceHead, tree: { sha: state.sourceTree } };
    else if (path.endsWith(`/compare/${state.currentMain}...${state.sourceHead}`))
      result = {
        status: state.headContainsBase ? 'ahead' : 'diverged',
        merge_base_commit: { sha: state.headContainsBase ? state.currentMain : 'd'.repeat(40) },
      };
    else if (path.includes(`/compare/${merge}...`))
      result = {
        status: state.contained ? 'identical' : 'diverged',
        merge_base_commit: { sha: state.contained ? merge : main },
      };
    else throw new Error(`Unexpected external command shape: ${JSON.stringify(args)}`);
    state.afterRead(path);
    return { stdout: JSON.stringify(result), stderr: '' };
  };
  const selectedConfig = {
    ...config,
    repository: selected.authority.repository,
    connectionId: selected.authority.connectionId,
    capabilityId: selected.authority.capabilityId,
  };
  const dispatchMerge = (
    command: 'gh',
    args: readonly string[],
    signal: AbortSignal,
    admit: () => void,
  ) => run(command, args, signal, admit);
  const adapter = new GithubMainPublication(selectedConfig, run, dispatchMerge);
  return { state, calls, adapter, run, dispatchMerge };
}

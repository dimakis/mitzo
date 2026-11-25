import { z } from 'zod';
import type { PrMonitorReadPort, PrMonitorReadRequest } from './pr-monitor-observer.js';
import type { GitHubReadResponse } from './github-read-response.js';
const number = z.number().int().positive(),
  sha = z.string().regex(/^[a-f0-9]{40}$/),
  reference = z.string().min(1).max(200);
const pull = z.object({
  node_id: reference,
  number,
  title: z.string().max(1024),
  state: z.enum(['open', 'closed']),
  merged: z.boolean().nullable(),
  head: z.object({ sha }),
  base: z.object({
    sha,
    repo: z.object({ node_id: reference, name: reference, owner: z.object({ login: reference }) }),
  }),
});
const run = z.object({
  id: number,
  workflow_id: number,
  run_number: number,
  run_attempt: number,
  head_sha: sha,
  status: z
    .enum(['queued', 'waiting', 'pending', 'requested', 'in_progress', 'completed'])
    .optional(),
  conclusion: z.string().nullable().optional(),
});
const job = z.object({
  id: number,
  name: z.string().min(1).max(150),
  status: z.enum(['queued', 'waiting', 'pending', 'in_progress', 'completed']),
  conclusion: z.string().nullable(),
  head_sha: sha,
  run_id: number,
  run_attempt: number,
  completed_at: z.string().nullable(),
});
const review = z.object({
  id: number,
  commit_id: sha,
  state: z.enum(['CHANGES_REQUESTED', 'APPROVED', 'DISMISSED', 'COMMENTED', 'PENDING']),
  submitted_at: z.string().nullable(),
  user: z.object({ login: reference }),
  body: z.string().max(16384).nullable(),
});
const report = z.strictObject({
  version: z.literal(1),
  headSha: sha,
  findings: z
    .array(
      z.strictObject({
        id: reference,
        revision: reference,
        blocking: z.boolean(),
        resolved: z.boolean(),
      }),
    )
    .max(100),
});
export function createPrMonitorGitHubReader(options: {
  transport(
    endpoint: string,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<GitHubReadResponse>;
  assertConnection(request: PrMonitorReadRequest): void;
  observeQuota(request: PrMonitorReadRequest, response: GitHubReadResponse): void;
  eligibleAuthors?: readonly string[];
}): PrMonitorReadPort {
  return async (request) => {
    const check = () => {
      request.assertCurrent();
      options.assertConnection(request);
    };
    // The observer reserved one request for this read; every further GET is
    // reserved separately so the collection budget counts actual requests.
    let baseUsed = false;
    const get = async (endpoint: string) => {
      check();
      const release = baseUsed ? request.reserveAdditional() : undefined;
      baseUsed = true;
      try {
        const result = await options.transport(endpoint, request.signal, check);
        check();
        options.observeQuota(request, result);
        return result;
      } finally {
        release?.();
      }
    };
    if (request.verifyPrincipal) {
      const identity = await get('/user');
      if (identity.status !== 200) return identity;
      const principal = z.object({ id: number }).parse(identity.data);
      if (`github:${principal.id}` !== request.principalId) throw Error('connection_unavailable');
    }
    const g = request.subscription.github,
      root = `/repos/${g.owner}/${g.name}`;
    if (request.resource === 'pr') {
      const response = await get(`${root}/pulls/${g.pr}`);
      if (response.status !== 200) return response;
      const p = pull.parse(response.data);
      return {
        ...response,
        data: {
          repositoryId: p.base.repo.node_id,
          prNodeId: p.node_id,
          owner: p.base.repo.owner.login,
          name: p.base.repo.name,
          number: p.number,
          headSha: p.head.sha,
          baseSha: p.base.sha,
          title: p.title,
          state: p.merged ? 'merged' : p.state,
        },
      };
    }
    if (!request.headSha) throw Error('incomplete');
    if (request.resource === 'ci') {
      const response = await get(
        `${root}/actions/runs?head_sha=${request.headSha}&per_page=100&page=${request.page}`,
      );
      if (response.status !== 200) return response;
      const runs = z
        .object({
          total_count: z.number().int().nonnegative(),
          workflow_runs: z.array(run).max(100),
        })
        .parse(response.data);
      const items = [];
      for (const r of runs.workflow_runs) {
        if (r.head_sha !== request.headSha) throw Error('incomplete');
        const result = await get(
          `${root}/actions/runs/${r.id}/attempts/${r.run_attempt}/jobs?per_page=100&page=1`,
        );
        if (result.status !== 200) return result;
        const jobs = z
          .object({ total_count: z.number().int().nonnegative(), jobs: z.array(job).max(100) })
          .parse(result.data);
        if (jobs.total_count !== jobs.jobs.length) throw Error('incomplete');
        if (jobs.jobs.length === 0) {
          // A newer queued run must suppress old failures even before jobs exist.
          // Completed empty runs cannot provide exact failure job references.
          if (!r.status || r.status === 'completed') throw Error('incomplete');
          items.push({
            id: `run:${r.id}`,
            headSha: r.head_sha,
            workflowId: `workflow:${r.workflow_id}`,
            slot: `workflow:${r.workflow_id}`,
            runId: String(r.id),
            runNumber: r.run_number,
            attempt: r.run_attempt,
            status: 'pending',
            completedAt: null,
          });
        }
        for (const j of jobs.jobs) {
          if (
            j.head_sha !== request.headSha ||
            j.run_id !== r.id ||
            j.run_attempt !== r.run_attempt
          )
            throw Error('incomplete');
          const conclusion = j.conclusion;
          const status =
            j.status !== 'completed'
              ? 'pending'
              : conclusion === 'success'
                ? 'passed'
                : ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(
                      conclusion ?? '',
                    )
                  ? 'failed'
                  : conclusion === 'cancelled'
                    ? 'cancelled'
                    : conclusion === 'skipped'
                      ? 'skipped'
                      : conclusion === 'neutral'
                        ? 'neutral'
                        : null;
          if (!status) throw Error('incomplete');
          items.push({
            id: String(j.id),
            headSha: j.head_sha,
            workflowId: `workflow:${r.workflow_id}`,
            slot: `workflow:${r.workflow_id}/job:${j.name}`,
            runId: String(r.id),
            runNumber: r.run_number,
            attempt: r.run_attempt,
            status,
            completedAt: j.completed_at,
          });
          if (items.length > 100) throw Error('incomplete');
        }
      }
      return { ...response, data: { items, hasNext: runs.total_count > request.page * 100 } };
    }
    const response = await get(`${root}/pulls/${g.pr}/reviews?per_page=100&page=${request.page}`);
    if (response.status !== 200) return response;
    const reviews = z.array(review).max(100).parse(response.data),
      items = [];
    for (const r of reviews) {
      if (r.state === 'PENDING') continue;
      let findings: z.infer<typeof report>['findings'] = [];
      if (
        r.state === 'CHANGES_REQUESTED' &&
        r.commit_id === request.headSha &&
        (options.eligibleAuthors ?? []).includes(r.user.login)
      ) {
        try {
          const parsed = report.parse(JSON.parse(r.body ?? ''));
          if (parsed.headSha !== r.commit_id) throw Error('mismatch');
          findings = parsed.findings;
        } catch {
          throw Error('incomplete');
        }
      }
      if (!r.submitted_at) throw Error('incomplete');
      items.push({
        id: String(r.id),
        headSha: r.commit_id,
        author: r.user.login,
        revision: r.submitted_at,
        state: r.state.toLowerCase(),
        findings,
      });
    }
    return { ...response, data: { items, hasNext: reviews.length === 100 } };
  };
}

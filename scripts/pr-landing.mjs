// Trusted default-branch controller. All PR data is data; no artifact contents or PR code run here.
const REQUEST_PATH = '.github/workflows/pr-landing-request.yml';
const SHA = /^[a-f0-9]{40}$/;
const TTL = 7 * 24 * 60 * 60 * 1000;
const fail = (reason) => {
  throw new Error(reason);
};
const scope = (c) => ({ owner: c.owner, repo: c.repo });
const get = async (g, c, route, args = {}) =>
  (await g.request(route, { ...scope(c), ...args })).data;
const all = (g, c, route, args = {}) => g.paginate(route, { ...scope(c), per_page: 100, ...args });
const instant = (c) => c.now ?? Date.now();
// Legacy/failed dispatch titles retain raw input. Normalize their intent so an
// alias revoke cannot disappear behind an older canonical authorization.
function intentNumber(title) {
  const raw = /^land-pr:([^:]*):(authorize|revoke)$/.exec(title)?.[1];
  const number = Number(raw);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
async function repository(g, c) {
  return get(g, c, 'GET /repos/{owner}/{repo}');
}
async function permitted(g, c, actor) {
  if (!actor) return false;
  const p = await get(g, c, 'GET /repos/{owner}/{repo}/collaborators/{username}/permission', {
    username: actor,
  });
  return ['write', 'maintain', 'admin'].includes(p.permission);
}
async function live(g, c, number) {
  const r = await repository(g, c);
  const pr = await get(g, c, 'GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    pull_number: number,
  });
  const ref = await get(g, c, 'GET /repos/{owner}/{repo}/git/ref/{ref}', {
    ref: `heads/${r.default_branch}`,
  });
  if (
    pr.state !== 'open' ||
    pr.draft ||
    pr.base?.ref !== r.default_branch ||
    pr.head?.repo?.full_name !== r.full_name ||
    pr.base?.repo?.full_name !== r.full_name ||
    !SHA.test(pr.head?.sha) ||
    !SHA.test(pr.base?.sha) ||
    ref.object?.sha !== pr.base.sha
  )
    fail('PR must be open, same-repository and integrated with current default branch');
  return { pr, r };
}
export async function buildRequest(g, c, input, actor) {
  const number = Number(input.pr_number);
  if (
    typeof input.pr_number !== 'string' ||
    !/^[1-9]\d*$/.test(input.pr_number) ||
    !Number.isSafeInteger(number) ||
    !['authorize', 'revoke'].includes(input.mode)
  )
    fail('Invalid request');
  if (!(await permitted(g, c, actor))) fail('Actor lacks repository write permission');
  if (input.mode === 'revoke') return { name: `revoke-pr-${number}`, number, mode: input.mode };
  if (
    input.confirmation !== 'MERGE' ||
    !SHA.test(input.expected_head) ||
    !SHA.test(input.expected_base)
  )
    fail('Explicit MERGE and full head/base SHAs required');
  const { pr } = await live(g, c, number);
  if (pr.head.sha !== input.expected_head || pr.base.sha !== input.expected_base)
    fail('Request head/base changed');
  return { name: `land-pr-${number}-${pr.head.sha}-${pr.base.sha}`, number, mode: input.mode };
}
async function requestRuns(g, c) {
  const r = await repository(g, c);
  const w = await get(g, c, 'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}', {
    workflow_id: 'pr-landing-request.yml',
  });
  if (w.path !== REQUEST_PATH || w.state !== 'active') fail('Untrusted request workflow');
  const runs = await all(g, c, 'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
    workflow_id: w.id,
    event: 'workflow_dispatch',
  });
  // Do not filter incomplete/failed runs: a new intent supersedes the old grant immediately.
  return { r, w, runs: runs.sort((a, b) => b.id - a.id) };
}
export async function latestRequest(g, c, number) {
  const { r, w, runs } = await requestRuns(g, c);
  const match = runs.find((run) => intentNumber(run.display_title) === number);
  if (!match) return { authorized: false, reason: 'No request' };
  const run = await get(g, c, 'GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
    run_id: match.id,
  });
  const title = `land-pr:${number}:authorize`;
  if (
    run.id !== match.id ||
    run.workflow_id !== w.id ||
    run.path !== REQUEST_PATH ||
    run.event !== 'workflow_dispatch' ||
    run.head_branch !== r.default_branch ||
    run.head_repository?.full_name !== r.full_name ||
    run.display_title !== title ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  )
    return { authorized: false, reason: 'Revoked, incomplete or untrusted request' };
  const created = Date.parse(run.created_at);
  if (
    !Number.isFinite(created) ||
    instant(c) < created ||
    instant(c) - created >= TTL ||
    !(await permitted(g, c, run.actor?.login))
  )
    return { authorized: false, reason: 'Expired request or permission lost' };
  const artifacts = await all(g, c, 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts', {
    run_id: run.id,
  });
  // Immutable runtime artifact metadata is the receipt. Never download its contents.
  const receipts = artifacts.filter((a) =>
    new RegExp(`^land-pr-${number}-[a-f0-9]{40}-[a-f0-9]{40}$`).test(a.name),
  );
  if (receipts.length !== 1) return { authorized: false, reason: 'Missing or ambiguous receipt' };
  const a = receipts[0];
  const [, head, base] = a.name.match(/^land-pr-\d+-([a-f0-9]{40})-([a-f0-9]{40})$/);
  if (
    a.expired ||
    !Number.isFinite(Date.parse(a.expires_at)) ||
    Date.parse(a.expires_at) <= instant(c) ||
    run.head_sha !== base
  )
    return { authorized: false, reason: 'Expired or stale receipt' };
  return {
    authorized: true,
    number,
    head,
    base,
    runId: run.id,
    artifactId: a.id,
    actor: run.actor.login,
  };
}
function finalReport(records, head, reviewer) {
  const timestamp = (r) => {
    const values = [r.submitted_at, r.created_at, r.updated_at]
      .filter((v) => v != null)
      .map(Date.parse);
    return values.length && values.every(Number.isFinite) ? Math.max(...values) : NaN;
  };
  const reports = records.filter(
    (r) =>
      r.user?.login?.toLowerCase() === reviewer.toLowerCase() &&
      r.body?.includes('## Centaur Review'),
  );
  if (!reports.length || reports.some((r) => !Number.isFinite(timestamp(r)))) return false;
  reports.sort((a, b) => timestamp(a) - timestamp(b));
  const last = reports.at(-1),
    body = last.body;
  return (
    !(reports.length > 1 && timestamp(last) === timestamp(reports.at(-2))) &&
    last.state !== 'DISMISSED' &&
    (last.commit_id === undefined || last.commit_id === head) &&
    new RegExp(
      `^<!-- centaur:sha:${head} -->\\s*## Centaur Review\\s*LGTM — no issues found\\.\\s*### Convergence\\s*\\*\\*Recommendation:\\*\\* \x60merge\x60[^\\n]*\\n`,
    ).test(body) &&
    [
      '**Recommendation:**',
      '## Centaur Review',
      '<!-- centaur:sha:',
      'New blocking findings:',
      'Unresolved blocking findings:',
    ].every((marker) => body.split(marker).length === 2) &&
    /^- New blocking findings: 0[ \t]*$/m.test(body) &&
    /^- Unresolved blocking findings: 0[ \t]*$/m.test(body)
  );
}
async function noThreads(g, c, number) {
  let cursor = null;
  do {
    const result = await g.graphql(
      `query($owner:String!,$repo:String!,$number:Int!,$cursor:String) { repository(owner:$owner,name:$repo) { pullRequest(number:$number) { reviewThreads(first:100,after:$cursor) { nodes { isResolved } pageInfo { hasNextPage endCursor } } } } }`,
      { ...scope(c), number, cursor },
    );
    const threads = result.repository?.pullRequest?.reviewThreads;
    if (!threads || threads.nodes.some((t) => !t.isResolved)) fail('Unresolved review threads');
    if (!threads.pageInfo.hasNextPage) return;
    if (!threads.pageInfo.endCursor || threads.pageInfo.endCursor === cursor)
      fail('Invalid review pagination');
    cursor = threads.pageInfo.endCursor;
  } while (cursor);
}
async function gates(g, c, authorization) {
  const { pr, r } = await live(g, c, authorization.number);
  if (
    pr.head.sha !== authorization.head ||
    pr.base.sha !== authorization.base ||
    !pr.mergeable ||
    pr.mergeable_state !== 'clean'
  )
    fail('Candidate changed or is not mergeable');
  const reviews = await all(g, c, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
    pull_number: pr.number,
  });
  const comments = await all(g, c, 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    issue_number: pr.number,
  });
  if (!finalReport([...reviews, ...comments], pr.head.sha, c.reviewer || c.owner))
    fail('Missing exact-head final Centaur approval');
  // COMMENTED does not clear GitHub's outstanding CHANGES_REQUESTED state.
  // Only a later decisive approval (or dismissal of the original review) does.
  const latestDecisionByUser = new Map();
  for (const review of reviews) {
    if (review.state === 'PENDING') fail('Blocking pending review');
    if (['APPROVED', 'CHANGES_REQUESTED'].includes(review.state))
      latestDecisionByUser.set(review.user?.login?.toLowerCase(), review.state);
  }
  if ([...latestDecisionByUser.values()].includes('CHANGES_REQUESTED'))
    fail('Blocking review state');
  const protection = await get(g, c, 'GET /repos/{owner}/{repo}/branches/{branch}/protection', {
    branch: r.default_branch,
  });
  const required = protection.required_status_checks;
  if (
    !Number.isSafeInteger(c.appId) ||
    c.appId <= 0 ||
    !c.appLogin ||
    required?.strict !== true ||
    !required.checks?.some((x) => x.context === 'ci') ||
    !required.checks.some((x) => x.context === 'Centaur final LGTM' && x.app_id === c.appId)
  )
    fail('Missing strict App-bound required protection');
  const statuses = await all(g, c, 'GET /repos/{owner}/{repo}/commits/{ref}/statuses', {
    ref: pr.head.sha,
  });
  const checks = await all(g, c, 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
    ref: pr.head.sha,
  });
  if (
    statuses.find(
      (s) =>
        s.context === 'Centaur final LGTM' &&
        s.creator?.login?.toLowerCase() === c.appLogin.toLowerCase(),
    )?.state !== 'success'
  )
    fail('Missing current App status');
  // Check-run IDs increase across reruns. Select the latest matching identity,
  // never an earlier green attempt after a newer pending or failed attempt.
  checks.sort((a, b) =>
    Number.isSafeInteger(a.id) && Number.isSafeInteger(b.id) ? b.id - a.id : 0,
  );
  const ci = checks.find((x) => x.name === 'ci' && x.app?.id === 15368);
  if (ci?.status !== 'completed' || ci.conclusion !== 'success')
    fail('Missing current GitHub Actions ci aggregate');
  for (const rule of required.checks) {
    if (rule.context === 'Centaur final LGTM') continue;
    const check = checks.find(
      (x) =>
        x.name === rule.context &&
        (rule.app_id == null || rule.app_id === -1 || x.app?.id === rule.app_id),
    );
    const status = statuses.find((x) => x.context === rule.context);
    const passed =
      check?.status === 'completed' &&
      (check.conclusion === 'success' ||
        (rule.context === 'Native Swift tests and builds' &&
          check.app?.id === 15368 &&
          check.conclusion === 'skipped'));
    if (rule.app_id != null && rule.app_id !== -1) {
      if (!passed) fail(`Required check missing or unsuccessful: ${rule.context}`);
    } else if (!passed && status?.state !== 'success')
      fail(`Required check missing or unsuccessful: ${rule.context}`);
  }
  await noThreads(g, c, pr.number);
}
export async function reconcile(g, c) {
  const { runs } = await requestRuns(g, c);
  const numbers = [
    ...new Set(
      runs.map((r) => intentNumber(r.display_title)).filter((number) => number !== undefined),
    ),
  ];
  const results = [];
  for (const number of numbers) {
    try {
      const authorization = await latestRequest(g, c, number);
      if (!authorization.authorized) {
        results.push({ number, decision: 'blocked', reason: authorization.reason });
        continue;
      }
      await gates(g, c, authorization);
      // All checks and the authorization are fetched again immediately before merge.
      await gates(g, c, authorization);
      const latest = await latestRequest(g, c, number);
      if (
        !latest.authorized ||
        latest.runId !== authorization.runId ||
        latest.artifactId !== authorization.artifactId
      )
        fail('Authorization revoked or changed');
      // Do not retry an uncertain mutation. A later run consults canonical PR state.
      const result = await get(g, c, 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
        pull_number: number,
        sha: authorization.head,
        merge_method: 'squash',
      });
      if (result.merged !== true) fail('GitHub did not confirm merge');
      results.push({
        number,
        decision: 'merged',
        head: authorization.head,
        base: authorization.base,
        requestRun: authorization.runId,
      });
    } catch (error) {
      results.push({
        number,
        decision: 'blocked',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

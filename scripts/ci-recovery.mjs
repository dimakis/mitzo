import { Buffer } from 'node:buffer';

// Failure remains authoritative. This controller can request one real rerun;
// it cannot issue statuses, skip checks, execute logs or accept test failures.
function eligibleRun(run, repositoryId) {
  return (
    run.name === 'CI' &&
    run.path === '.github/workflows/ci.yml' &&
    run.event === 'pull_request' &&
    run.status === 'completed' &&
    run.conclusion === 'failure' &&
    run.run_attempt === 1 &&
    /^[a-f0-9]{40}$/.test(run.head_sha) &&
    run.head_repository?.id === repositoryId &&
    run.pull_requests?.length === 1 &&
    Number.isSafeInteger(run.pull_requests[0].number) &&
    run.pull_requests[0].number > 0
  );
}
function currentPull(pr, run, repositoryId) {
  return pr.state === 'open' && pr.head?.sha === run.head_sha && pr.head?.repo?.id === repositoryId;
}
function infrastructureLog(data) {
  const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
  return (
    text.length <= 16 * 1024 * 1024 &&
    /^.*##\[error\]The runner has received a shutdown signal\./m.test(text) &&
    !/(?:\b[1-9][0-9]* failed\b|Error: expect\(|TimeoutError:|CI_BROWSER_EXIT.*"code":[1-9])/.test(
      text,
    )
  );
}
export async function recoverCiRun({ github, context, core }) {
  const repositoryId = context.payload.repository.id;
  const runId = context.payload.workflow_run.id;
  if (!Number.isSafeInteger(runId) || runId <= 0) return false;
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const params = { ...repo, run_id: runId };
  const { data: run } = await github.rest.actions.getWorkflowRun(params);
  if (!eligibleRun(run, repositoryId)) return false;
  const pullParams = { ...repo, pull_number: run.pull_requests[0].number };
  const { data: pr } = await github.rest.pulls.get(pullParams);
  if (!currentPull(pr, run, repositoryId)) return false;
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...params,
    filter: 'latest',
    per_page: 100,
  });
  let interrupted = 0;
  for (const job of jobs) {
    if (['success', 'skipped'].includes(job.conclusion)) continue;
    if (job.conclusion !== 'failure' && job.conclusion !== 'cancelled') return false;
    // These dependency gates fail because a required browser owner is missing.
    if (['ci', 'Connections browser regression'].includes(job.name)) continue;
    if (
      !(job.name === 'Browser interaction tests' || /^Offline layouts \(/.test(job.name)) ||
      !job.steps?.some((step) => step.conclusion === 'cancelled') ||
      job.steps.some((step) => step.conclusion === 'failure')
    )
      return false;
    try {
      const { data } = await github.rest.actions.downloadJobLogsForWorkflowRun({
        ...repo,
        job_id: job.id,
      });
      if (!infrastructureLog(data)) return false;
    } catch {
      core.info('Missing or unreadable interruption evidence for job ' + job.id);
      return false;
    }
    interrupted++;
  }
  if (!interrupted) return false;
  // Do not resurrect an old head or collide with a manual retry while logs load.
  const { data: refreshed } = await github.rest.actions.getWorkflowRun(params);
  const { data: current } = await github.rest.pulls.get(pullParams);
  if (
    !eligibleRun(refreshed, repositoryId) ||
    refreshed.head_sha !== run.head_sha ||
    !currentPull(current, refreshed, repositoryId)
  )
    return false;
  await github.rest.actions.reRunWorkflowFailedJobs({ ...params, enable_debug_logging: true });
  core.notice(
    `Requested one infrastructure retry for CI run ${runId}; ${interrupted} interrupted browser jobs. Successful jobs and all required gates remain authoritative.`,
  );
  return true;
}

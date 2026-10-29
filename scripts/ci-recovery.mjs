import { Buffer } from 'node:buffer';
import { stripVTControlCharacters } from 'node:util';

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
  const text = stripVTControlCharacters(
    typeof data === 'string' ? data : Buffer.from(data).toString('utf8'),
  );
  for (const line of text.split('\n')) {
    const marker = line.indexOf('CI_BROWSER_EXIT ');
    if (marker === -1) continue;
    const result = JSON.parse(line.slice(marker + 'CI_BROWSER_EXIT '.length));
    if (
      result.signal &&
      (!['SIGINT', 'SIGTERM'].includes(result.interruptedBy) ||
        !['SIGINT', 'SIGTERM', 'SIGKILL'].includes(result.signal))
    )
      return false;
    if (
      result.error ||
      (result.code !== null &&
        result.code !== 0 &&
        !(result.code === 130 && result.interruptedBy === 'SIGINT') &&
        !(result.code === 143 && result.interruptedBy === 'SIGTERM'))
    )
      return false;
  }
  return (
    text.length <= 16 * 1024 * 1024 &&
    /^.*##\[error\]The runner has received a shutdown signal\./m.test(text) &&
    !/(?:\b[1-9][0-9]* failed\b|Error: expect\(|TimeoutError:|CI_BROWSER_TEST_FAILURE|CI_BROWSER_MEMORY_PRESSURE|[✘×x]\s+\d+\s+\[)/.test(
      text,
    )
  );
}
export async function recoverCiRun({ github, context, core }) {
  const repositoryId = context.payload.repository.id;
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) return false;
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

const activeCiStatuses = new Set(['requested', 'waiting', 'pending', 'queued', 'in_progress']);
function sameRepositoryPrRun(run, repositoryId) {
  return (
    Number.isSafeInteger(run?.id) &&
    run.id > 0 &&
    Number.isSafeInteger(run.workflow_id) &&
    run.workflow_id > 0 &&
    run.name === 'CI' &&
    run.path === '.github/workflows/ci.yml' &&
    run.event === 'pull_request' &&
    run.repository?.id === repositoryId &&
    run.head_repository?.id === repositoryId &&
    /^[a-f0-9]{40}$/.test(run.head_sha) &&
    typeof run.head_branch === 'string' &&
    run.head_branch.length > 0 &&
    run.pull_requests?.length === 1 &&
    Number.isSafeInteger(run.pull_requests[0].number) &&
    run.pull_requests[0].number > 0
  );
}
function currentCleanupPull(pr, run, repositoryId) {
  return (
    currentPull(pr, run, repositoryId) &&
    pr.head.ref === run.head_branch &&
    pr.base?.repo?.id === repositoryId
  );
}
function supersededRun(old, current, repositoryId) {
  return (
    sameRepositoryPrRun(old, repositoryId) &&
    old.id < current.id &&
    old.workflow_id === current.workflow_id &&
    old.head_sha !== current.head_sha &&
    old.head_branch === current.head_branch &&
    old.pull_requests[0].number === current.pull_requests[0].number &&
    activeCiStatuses.has(old.status)
  );
}
/** A requested current-head CI run may retire older PR runs, never produce a verdict.
 * Only canonical API facts select a target; event payloads provide lookup IDs only. */
export async function cleanupSupersededCiRuns({ github, context, core }) {
  const repositoryId = context.payload.repository?.id;
  const runId = context.payload.workflow_run?.id;
  const defaultBranch = context.payload.repository?.default_branch;
  if (
    !Number.isSafeInteger(repositoryId) ||
    repositoryId <= 0 ||
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    typeof defaultBranch !== 'string' ||
    !defaultBranch
  )
    return [];
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const { data: current } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: runId });
  if (
    current?.id !== runId ||
    !sameRepositoryPrRun(current, repositoryId) ||
    current.head_branch === defaultBranch
  )
    return [];
  const pullParams = { ...repo, pull_number: current.pull_requests[0].number };
  const { data: pr } = await github.rest.pulls.get(pullParams);
  if (!currentCleanupPull(pr, current, repositoryId)) return [];
  const candidates = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...repo,
    workflow_id: current.workflow_id,
    branch: current.head_branch,
    event: 'pull_request',
    per_page: 100,
  });
  const cancelled = [];
  const attempted = new Set();
  for (const candidate of candidates) {
    if (!supersededRun(candidate, current, repositoryId) || attempted.has(candidate.id)) continue;
    const { data: livePr } = await github.rest.pulls.get(pullParams);
    // A new push may have arrived while listing. Let its own requested event own cleanup.
    if (!currentCleanupPull(livePr, current, repositoryId)) break;
    const params = { ...repo, run_id: candidate.id };
    const { data: old } = await github.rest.actions.getWorkflowRun(params);
    if (
      old.id !== candidate.id ||
      old.head_sha !== candidate.head_sha ||
      !supersededRun(old, current, repositoryId)
    )
      continue;
    attempted.add(old.id);
    try {
      await github.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/force-cancel', params);
      cancelled.push(old.id);
      core.notice(
        `Requested force-cancellation of superseded CI run ${old.id}; current run ${current.id} retains all required checks.`,
      );
    } catch (error) {
      // A race with ordinary completion is harmless only after a canonical reread.
      // Unknown/uncertain failures are surfaced, never blindly retried.
      if (error?.status === 409) {
        const { data: finished } = await github.rest.actions.getWorkflowRun(params);
        if (
          finished.id === old.id &&
          finished.status === 'completed' &&
          sameRepositoryPrRun(finished, repositoryId) &&
          finished.workflow_id === old.workflow_id &&
          finished.head_sha === old.head_sha &&
          finished.head_branch === old.head_branch &&
          finished.pull_requests[0].number === old.pull_requests[0].number
        )
          continue;
      }
      throw error;
    }
  }
  return cancelled;
}

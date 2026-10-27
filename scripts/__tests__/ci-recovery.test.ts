import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { expect, it, vi } from 'vitest';
import { recoverCiRun } from '../ci-recovery.mjs';

function fixture() {
  const run = {
    id: 7,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    run_attempt: 1,
    head_sha: 'a'.repeat(40),
    head_repository: { id: 1 },
    pull_requests: [{ number: 42 }],
  };
  const pr = { state: 'open', head: { sha: run.head_sha, repo: { id: 1 } } };
  const jobs = [
    {
      id: 11,
      name: 'Offline layouts (mobile-webkit 1/4)',
      conclusion: 'cancelled',
      steps: [{ name: 'Browser tests', conclusion: 'cancelled' }],
    },
    { id: 12, name: 'Core checks', conclusion: 'success', steps: [] },
    { id: 13, name: 'Connections browser regression', conclusion: 'failure', steps: [] },
    { id: 14, name: 'ci', conclusion: 'failure', steps: [] },
  ];
  const logs =
    '2026-10-27T12:00:00Z ##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.\n';
  const actions = {
    getWorkflowRun: vi.fn(async () => ({ data: structuredClone(run) })),
    listJobsForWorkflowRun: vi.fn(),
    downloadJobLogsForWorkflowRun: vi.fn(async () => ({ data: logs })),
    reRunWorkflowFailedJobs: vi.fn(async () => ({})),
  };
  const pulls = { get: vi.fn(async () => ({ data: structuredClone(pr) })) };
  const github = { rest: { actions, pulls }, paginate: vi.fn(async () => jobs) };
  const context = {
    repo: { owner: 'owner', repo: 'repo' },
    payload: { repository: { id: 1 }, workflow_run: structuredClone(run) },
  };
  const core = { info: vi.fn(), notice: vi.fn() };
  return {
    run,
    pr,
    jobs,
    actions,
    pulls,
    github,
    context,
    core,
    execute: () => recoverCiRun({ github, context, core }),
  };
}
it('retries only failed jobs once for a current-head infrastructure interruption', async () => {
  const f = fixture();
  expect(await f.execute()).toBe(true);
  expect(f.actions.reRunWorkflowFailedJobs).toHaveBeenCalledExactlyOnceWith({
    owner: 'owner',
    repo: 'repo',
    run_id: 7,
    enable_debug_logging: true,
  });
  expect(f.github.paginate).toHaveBeenCalledWith(
    f.actions.listJobsForWorkflowRun,
    expect.objectContaining({ filter: 'latest', per_page: 100 }),
  );
});
it.each(['event', 'workflow', 'attempt', 'cancelled', 'fork', 'stale', 'closed', 'ambiguous'])(
  'does not resurrect %s work',
  async (condition) => {
    const f = fixture();
    if (condition === 'event') f.run.event = 'push';
    if (condition === 'workflow') f.run.path = '.github/workflows/other.yml';
    if (condition === 'attempt') f.run.run_attempt = 2;
    if (condition === 'cancelled') f.run.conclusion = 'cancelled';
    if (condition === 'fork') f.pr.head.repo.id = 2;
    if (condition === 'stale') f.pr.head.sha = 'b'.repeat(40);
    if (condition === 'closed') f.pr.state = 'closed';
    if (condition === 'ambiguous') f.run.pull_requests.push({ number: 43 });
    expect(await f.execute()).toBe(false);
    expect(f.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
  },
);
it.each(['assertion', 'timeout', 'unknown', 'missing-log', 'completed-failure', 'no-interruption'])(
  'leaves %s failures visible without an automatic retry',
  async (condition) => {
    const f = fixture();
    if (condition === 'assertion')
      f.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({
        data: '1 failed\n##[error]The runner has received a shutdown signal.',
      });
    if (condition === 'timeout') f.jobs[0].conclusion = 'timed_out';
    if (condition === 'unknown')
      f.jobs.push({ id: 15, name: 'Unit tests (2/4)', conclusion: 'failure', steps: [] });
    if (condition === 'missing-log')
      f.actions.downloadJobLogsForWorkflowRun.mockRejectedValue(Error('404'));
    if (condition === 'completed-failure')
      f.jobs[0].steps.push({ name: 'Browser tests', conclusion: 'failure' });
    if (condition === 'no-interruption')
      f.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({
        data: 'Process exited with code 1',
      });
    expect(await f.execute()).toBe(false);
    expect(f.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
  },
);
it('rechecks run attempt and PR head immediately before issuing a retry', async () => {
  for (const change of ['run', 'head']) {
    const f = fixture();
    if (change === 'run')
      f.actions.getWorkflowRun
        .mockResolvedValueOnce({ data: structuredClone(f.run) })
        .mockResolvedValueOnce({ data: { ...f.run, run_attempt: 2 } });
    else
      f.pulls.get
        .mockResolvedValueOnce({ data: structuredClone(f.pr) })
        .mockResolvedValueOnce({ data: { ...f.pr, head: { ...f.pr.head, sha: 'b'.repeat(40) } } });
    expect(await f.execute()).toBe(false);
    expect(f.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
  }
});
it('privileged recovery loads only accepted default-branch code without persisting credentials', () => {
  const workflow = load(readFileSync('.github/workflows/ci-recovery.yml', 'utf8')) as {
    on: { workflow_run: { workflows: string[]; types: string[] } };
    permissions: Record<string, string>;
    jobs: { recover: { steps: Array<{ uses?: string; with?: Record<string, unknown> }> } };
  };
  expect(workflow.on.workflow_run).toEqual({ workflows: ['CI'], types: ['completed'] });
  expect(workflow.permissions).toEqual({
    contents: 'read',
    actions: 'write',
    'pull-requests': 'read',
  });
  const checkout = workflow.jobs.recover.steps.find((s) =>
    s.uses?.startsWith('actions/checkout@'),
  )!;
  expect(checkout.with).toEqual({
    ref: '${{ github.event.repository.default_branch }}',
    'persist-credentials': false,
  });
  expect(JSON.stringify(workflow)).not.toContain('head_sha');
});

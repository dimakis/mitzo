import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { expect, it, vi } from 'vitest';
import { recoverCiRun, cleanupSupersededCiRuns } from '../ci-recovery.mjs';

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

it('accepts an interrupted wrapper exit but refuses its real command failure', async () => {
  for (const [code, interruptedBy, expected] of [
    [130, 'SIGINT', true],
    [143, 'SIGTERM', true],
    [7, null, false],
    [1, 'SIGTERM', false],
  ] as const) {
    const f = fixture();
    f.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({
      data:
        '##[error]The runner has received a shutdown signal.\nCI_BROWSER_EXIT ' +
        JSON.stringify({ code, signal: null, interruptedBy }),
    });
    expect(await f.execute()).toBe(expected);
  }
});

it('does not classify a crashed test process as a host interruption', async () => {
  const f = fixture();
  f.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({
    data:
      '##[error]The runner has received a shutdown signal.\nCI_BROWSER_EXIT ' +
      JSON.stringify({ code: null, signal: 'SIGABRT', interruptedBy: null }),
  });
  expect(await f.execute()).toBe(false);
  expect(f.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
});

it.each([
  '2026-10-27T12:00:00.123Z   ✘  1 [mobile-webkit] › app.spec.ts:10:1 › failed before shutdown (30s)',
  '2026-10-27T12:00:00.123Z   \u001b[31m✘\u001b[39m  1 [desktop-chromium] › failed before shutdown (30s)',
  '  x  1 [mobile-chromium] › failed before shutdown (30s)',
  'CI_BROWSER_TEST_FAILURE {"status":"failed","testId":"earlier-case"}',
  'CI_BROWSER_TEST_FAILURE {"status":"error"}',
  'CI_BROWSER_MEMORY_PRESSURE {"availableKiB":48884,"swapFreeKiB":212}',
])(
  'refuses an observed failure before shutdown without requiring a final summary: %s',
  async (failure) => {
    const f = fixture();
    f.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({
      data:
        failure +
        '\n##[error]The runner has received a shutdown signal.\nCI_BROWSER_EXIT {"code":null,"signal":"SIGTERM","interruptedBy":"SIGTERM"}',
    });
    expect(await f.execute()).toBe(false);
    expect(f.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
  },
);
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
it.each([
  'assertion',
  'colored-assertion',
  'timeout',
  'unknown',
  'missing-log',
  'completed-failure',
  'no-interruption',
])('leaves %s failures visible without an automatic retry', async (condition) => {
  const f = fixture();
  if (condition === 'assertion')
    f.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({
      data: '1 failed\n##[error]The runner has received a shutdown signal.',
    });
  if (condition === 'colored-assertion')
    f.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({
      data: '\u001b[31m1\u001b[39m failed\n##[error]The runner has received a shutdown signal.',
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
});
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
  expect(workflow.on.workflow_run).toEqual({
    workflows: ['CI'],
    types: ['requested', 'completed'],
  });
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

function cleanupFixture() {
  const current = {
    id: 20,
    workflow_id: 3,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    event: 'pull_request',
    status: 'queued',
    head_sha: 'b'.repeat(40),
    head_branch: 'topic',
    repository: { id: 1 },
    head_repository: { id: 1 },
    pull_requests: [{ number: 42 }],
  };
  const old = {
    ...structuredClone(current),
    id: 19,
    head_sha: 'a'.repeat(40),
    status: 'in_progress',
  };
  const pr = {
    state: 'open',
    head: { sha: current.head_sha, ref: 'topic', repo: { id: 1 } },
    base: { repo: { id: 1 } },
  };
  const getWorkflowRun = vi.fn(async ({ run_id }: { run_id: number }) => ({
    data: structuredClone(run_id === current.id ? current : old),
  }));
  const actions = { getWorkflowRun, listWorkflowRuns: vi.fn() };
  const pulls = { get: vi.fn(async () => ({ data: structuredClone(pr) })) };
  const request = vi.fn(async () => ({ status: 202 }));
  const candidates = [old];
  const github = {
    rest: { actions, pulls },
    paginate: vi.fn(async () => structuredClone(candidates)),
    request,
  };
  const context = {
    repo: { owner: 'owner', repo: 'repo' },
    payload: { repository: { id: 1, default_branch: 'main' }, workflow_run: { id: current.id } },
  };
  const core = { info: vi.fn(), notice: vi.fn() };
  return {
    current,
    old,
    pr,
    candidates,
    actions,
    pulls,
    github,
    request,
    execute: () => cleanupSupersededCiRuns({ github, context, core }),
  };
}
it('force-cancels only a canonical older run for the current same-repo PR', async () => {
  const f = cleanupFixture();
  expect(await f.execute()).toEqual([19]);
  expect(f.request).toHaveBeenCalledExactlyOnceWith(
    'POST /repos/{owner}/{repo}/actions/runs/{run_id}/force-cancel',
    { owner: 'owner', repo: 'repo', run_id: 19 },
  );
  expect(f.github.paginate).toHaveBeenCalledWith(f.actions.listWorkflowRuns, {
    owner: 'owner',
    repo: 'repo',
    workflow_id: 3,
    branch: 'topic',
    event: 'pull_request',
    per_page: 100,
  });
});
it.each([
  'main',
  'current',
  'newer',
  'fork',
  'missing-repo',
  'other-pr',
  'missing-pr',
  'workflow',
  'event',
  'same-head',
  'completed',
  'different-branch',
])('never cancels %s candidates', async (reason) => {
  const f = cleanupFixture();
  if (reason === 'main') f.old.event = 'push';
  if (reason === 'current') f.old.id = 20;
  if (reason === 'newer') f.old.id = 21;
  if (reason === 'fork') f.old.head_repository.id = 2;
  if (reason === 'missing-repo') f.old.repository.id = 0;
  if (reason === 'other-pr') f.old.pull_requests = [{ number: 43 }];
  if (reason === 'missing-pr') f.old.pull_requests = [];
  if (reason === 'workflow') f.old.workflow_id = 4;
  if (reason === 'event') f.old.event = 'workflow_dispatch';
  if (reason === 'same-head') f.old.head_sha = f.current.head_sha;
  if (reason === 'completed') f.old.status = 'completed';
  if (reason === 'different-branch') f.old.head_branch = 'other';
  await f.execute();
  expect(f.request).not.toHaveBeenCalled();
});
it.each(['fork', 'missing-branch', 'missing-workflow', 'closed', 'head', 'branch'])(
  'rejects unqualified current trigger %s',
  async (reason) => {
    const f = cleanupFixture();
    if (reason === 'fork') f.current.head_repository.id = 2;
    if (reason === 'missing-branch') f.current.head_branch = '';
    if (reason === 'missing-workflow') f.current.workflow_id = 0;
    if (reason === 'closed') f.pr.state = 'closed';
    if (reason === 'head') f.pr.head.sha = 'c'.repeat(40);
    if (reason === 'branch') f.pr.head.ref = 'other';
    await f.execute();
    expect(f.request).not.toHaveBeenCalled();
  },
);
it.each(['pr', 'old-head', 'old-complete', 'old-pr'])(
  'revalidates %s immediately before cancellation',
  async (change) => {
    const f = cleanupFixture();
    f.actions.getWorkflowRun.mockImplementation(async ({ run_id }) => ({
      data: structuredClone(
        run_id === 20
          ? f.current
          : {
              ...f.old,
              ...(change === 'old-head'
                ? { head_sha: f.current.head_sha }
                : change === 'old-complete'
                  ? { status: 'completed' }
                  : change === 'old-pr'
                    ? { pull_requests: [{ number: 43 }] }
                    : {}),
            },
      ),
    }));
    if (change === 'pr')
      f.pulls.get
        .mockResolvedValueOnce({ data: structuredClone(f.pr) })
        .mockResolvedValueOnce({ data: { ...f.pr, head: { ...f.pr.head, sha: 'c'.repeat(40) } } });
    await f.execute();
    expect(f.request).not.toHaveBeenCalled();
  },
);
it('tolerates a 409 only when canonical reread proves completion', async () => {
  const f = cleanupFixture();
  f.request.mockRejectedValue({ status: 409 });
  f.actions.getWorkflowRun
    .mockResolvedValueOnce({ data: f.current })
    .mockResolvedValueOnce({ data: f.old })
    .mockResolvedValueOnce({ data: { ...f.old, status: 'completed' } });
  expect(await f.execute()).toEqual([]);
  expect(f.request).toHaveBeenCalledTimes(1);
});
it.each([409, 403, 500])(
  'does not retry an uncertain or rejected cancellation %s',
  async (status) => {
    const f = cleanupFixture();
    f.request.mockRejectedValue({ status });
    await expect(f.execute()).rejects.toMatchObject({ status });
    expect(f.request).toHaveBeenCalledTimes(1);
  },
);

it('never cancels a default-branch run even if PR metadata names it', async () => {
  const f = cleanupFixture();
  f.current.head_branch = 'main';
  f.old.head_branch = 'main';
  f.pr.head.ref = 'main';
  await f.execute();
  expect(f.request).not.toHaveBeenCalled();
});
it('issues at most one cancellation request for each older run despite duplicate listing entries', async () => {
  const f = cleanupFixture();
  f.candidates.push(structuredClone(f.old));
  expect(await f.execute()).toEqual([19]);
  expect(f.request).toHaveBeenCalledTimes(1);
});
it.each(['requested', 'waiting', 'pending', 'queued', 'in_progress'])(
  'cleans superseded active status %s',
  async (status) => {
    const f = cleanupFixture();
    f.old.status = status;
    expect(await f.execute()).toEqual([19]);
  },
);

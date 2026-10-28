import { expect, it } from 'vitest';
import { buildRequest, latestRequest, reconcile } from '../pr-landing.mjs';

const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
const now = Date.parse('2026-10-28T19:00:00Z');
const pr = {
  number: 7,
  state: 'open',
  draft: false,
  mergeable: true,
  mergeable_state: 'clean',
  head: { sha: head, repo: { full_name: 'owner/repo' } },
  base: { sha: base, ref: 'main', repo: { full_name: 'owner/repo' } },
};
const report = {
  user: { login: 'reviewer' },
  body: `<!-- centaur:sha:${head} -->\n## Centaur Review\nLGTM — no issues found.\n\n### Convergence\n**Recommendation:** \`merge\`\n- New blocking findings: 0\n- Unresolved blocking findings: 0\n`,
  state: 'COMMENTED',
  commit_id: head,
  submitted_at: '2026-10-28T18:00:00Z',
};
function fixture() {
  const calls: string[] = [];
  const run = {
    id: 10,
    workflow_id: 4,
    path: '.github/workflows/pr-landing-request.yml',
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_repository: { full_name: 'owner/repo' },
    actor: { login: 'owner' },
    display_title: 'land-pr:7:authorize',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-10-28T18:00:00Z',
    head_sha: base,
  };
  const artifact = {
    id: 99,
    name: `land-pr-7-${head}-${base}`,
    expired: false,
    created_at: run.created_at,
    expires_at: '2026-11-04T18:00:00Z',
  };
  const data: Record<string, ReturnType<typeof JSON.parse>> = {
    'GET /repos/{owner}/{repo}': { default_branch: 'main', full_name: 'owner/repo' },
    'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}': {
      id: 4,
      path: '.github/workflows/pr-landing-request.yml',
      state: 'active',
    },
    'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs': [run],
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}': run,
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts': [artifact],
    'GET /repos/{owner}/{repo}/collaborators/{username}/permission': { permission: 'admin' },
    'GET /repos/{owner}/{repo}/pulls/{pull_number}': pr,
    'GET /repos/{owner}/{repo}/git/ref/{ref}': { object: { sha: base } },
    'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [report],
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments': [],
    'GET /repos/{owner}/{repo}/commits/{ref}/status': {
      statuses: [
        { context: 'Centaur final LGTM', state: 'success', creator: { login: 'gate[bot]' } },
      ],
    },
    'GET /repos/{owner}/{repo}/commits/{ref}/statuses': [
      { context: 'Centaur final LGTM', state: 'success', creator: { login: 'gate[bot]' } },
    ],
    'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': [
      { name: 'ci', status: 'completed', conclusion: 'success', app: { id: 15368 } },
    ],
    'GET /repos/{owner}/{repo}/branches/{branch}/protection': {
      required_status_checks: {
        strict: true,
        checks: [
          { context: 'ci', app_id: 15368 },
          { context: 'Centaur final LGTM', app_id: 42 },
        ],
      },
    },
    'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge': { merged: true },
  };
  const github = {
    request: async (route: string, args: ReturnType<typeof JSON.parse>) => {
      calls.push(route);
      return {
        data: typeof data[route] === 'function' ? data[route](args) : structuredClone(data[route]),
      };
    },
    paginate: async (route: string, args: ReturnType<typeof JSON.parse>) => {
      calls.push(route);
      return typeof data[route] === 'function' ? data[route](args) : structuredClone(data[route]);
    },
    graphql: async () => ({
      repository: {
        pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } },
      },
    }),
  };
  const config = {
    owner: 'owner',
    repo: 'repo',
    appId: 42,
    appLogin: 'gate[bot]',
    reviewer: 'reviewer',
    now,
  };
  return { github, config, data, calls, run, artifact };
}
it('builds only an explicitly confirmed exact-head/base same-repo request', async () => {
  const f = fixture();
  expect(
    (
      await buildRequest(
        f.github,
        f.config,
        {
          pr_number: '7',
          mode: 'authorize',
          expected_head: head,
          expected_base: base,
          confirmation: 'MERGE',
        },
        'owner',
      )
    ).name,
  ).toBe(f.artifact.name);
  await expect(
    buildRequest(
      f.github,
      f.config,
      {
        pr_number: '7',
        mode: 'authorize',
        expected_head: head,
        expected_base: base,
        confirmation: '',
      },
      'owner',
    ),
  ).rejects.toThrow();
});
it('uses immutable metadata and never downloads artifacts before guarded merge', async () => {
  const f = fixture();
  expect(
    (await reconcile(f.github, f.config)).map((r: ReturnType<typeof JSON.parse>) => r.decision),
  ).toEqual(['merged']);
  expect(f.calls.filter((r) => r.startsWith('PUT'))).toHaveLength(1);
  expect(f.calls.some((r) => r.includes('/zip'))).toBe(false);
});
it.each([
  'head',
  'base',
  'permission',
  'dismissed',
  'blocking',
  'status',
  'protection',
  'checks',
  'expired',
  'revoked',
  'incomplete',
  'provenance',
])('fails closed on %s', async (reason) => {
  const f = fixture();
  if (reason === 'head' || reason === 'base')
    f.data['GET /repos/{owner}/{repo}/pulls/{pull_number}'] = {
      ...pr,
      [reason]: { ...pr[reason], sha: 'c'.repeat(40) },
    };
  if (reason === 'permission')
    f.data['GET /repos/{owner}/{repo}/collaborators/{username}/permission'] = {
      permission: 'read',
    };
  if (reason === 'dismissed' || reason === 'blocking')
    f.data['GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews'] = [
      {
        ...report,
        state: reason === 'dismissed' ? 'DISMISSED' : 'COMMENTED',
        body: reason === 'blocking' ? report.body.replace('`merge`', '`fix`') : report.body,
      },
    ];
  if (reason === 'status') f.data['GET /repos/{owner}/{repo}/commits/{ref}/statuses'] = [];
  if (reason === 'protection')
    f.data['GET /repos/{owner}/{repo}/branches/{branch}/protection'].required_status_checks.strict =
      false;
  if (reason === 'checks')
    f.data['GET /repos/{owner}/{repo}/commits/{ref}/check-runs'][0].conclusion = 'failure';
  if (reason === 'expired') f.artifact.expired = true;
  if (reason === 'revoked') {
    f.run.display_title = 'land-pr:7:revoke';
    f.artifact.name = 'revoke-pr-7';
  }
  if (reason === 'incomplete') f.run.status = 'in_progress';
  if (reason === 'provenance') f.run.head_branch = 'topic';
  const result = await reconcile(f.github, f.config);
  expect(result.every((r: ReturnType<typeof JSON.parse>) => r.decision !== 'merged')).toBe(true);
  expect(f.calls.filter((r) => r.startsWith('PUT'))).toHaveLength(0);
});
it('never falls back to an older authorization when a newer request is unfinished', async () => {
  const f = fixture();
  f.data['GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs'] = [
    { ...f.run, id: 11, status: 'in_progress', created_at: '2026-10-28T18:30:00Z' },
    f.run,
  ];
  expect((await latestRequest(f.github, f.config, 7)).authorized).toBe(false);
});
it('revalidates revocation immediately before mutation', async () => {
  const f = fixture();
  let reads = 0;
  f.data['GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs'] = () =>
    ++reads > 1
      ? [
          {
            ...f.run,
            id: 11,
            display_title: 'land-pr:7:revoke',
            created_at: '2026-10-28T18:30:00Z',
          },
        ]
      : [f.run];
  await reconcile(f.github, f.config);
  expect(f.calls.filter((r) => r.startsWith('PUT'))).toHaveLength(0);
});

it.each(['confirmation', 'head', 'base', 'actor', 'fork', 'draft'])(
  'rejects invalid authorization %s',
  async (reason) => {
    const f = fixture();
    const input = {
      pr_number: '7',
      mode: 'authorize',
      expected_head: head,
      expected_base: base,
      confirmation: 'MERGE',
    };
    if (reason === 'confirmation') input.confirmation = 'merge';
    if (reason === 'head') input.expected_head = 'c'.repeat(40);
    if (reason === 'base') input.expected_base = 'c'.repeat(40);
    if (reason === 'actor')
      f.data['GET /repos/{owner}/{repo}/collaborators/{username}/permission'] = {
        permission: 'read',
      };
    if (reason === 'fork')
      f.data['GET /repos/{owner}/{repo}/pulls/{pull_number}'] = {
        ...pr,
        head: { ...pr.head, repo: { full_name: 'fork/repo' } },
      };
    if (reason === 'draft')
      f.data['GET /repos/{owner}/{repo}/pulls/{pull_number}'] = { ...pr, draft: true };
    await expect(buildRequest(f.github, f.config, input, 'owner')).rejects.toThrow();
  },
);
it('records revocation without requiring an unchanged open candidate', async () => {
  const f = fixture();
  expect(
    (await buildRequest(f.github, f.config, { pr_number: '7', mode: 'revoke' }, 'owner')).name,
  ).toBe('revoke-pr-7');
});
it.each([
  'app',
  'foreign-status',
  'base-ref',
  'review-state',
  'ambiguous-receipts',
  'ambiguous-report',
  'new-base',
  'receipt-base',
])('blocks invalid %s evidence', async (reason) => {
  const f = fixture();
  if (reason === 'app')
    f.data[
      'GET /repos/{owner}/{repo}/branches/{branch}/protection'
    ].required_status_checks.checks[1].app_id = 43;
  if (reason === 'foreign-status')
    f.data['GET /repos/{owner}/{repo}/commits/{ref}/statuses'][0].creator.login = 'imposter[bot]';
  if (reason === 'base-ref')
    f.data['GET /repos/{owner}/{repo}/git/ref/{ref}'].object.sha = 'c'.repeat(40);
  if (reason === 'review-state')
    f.data['GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews'].push({
      user: { login: 'human' },
      state: 'CHANGES_REQUESTED',
    });
  if (reason === 'ambiguous-receipts')
    f.data['GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts'].push({
      ...f.artifact,
      id: 100,
    });
  if (reason === 'ambiguous-report')
    f.data['GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews'].push({ ...report });
  if (reason === 'receipt-base') f.run.head_sha = 'c'.repeat(40);
  if (reason === 'new-base') {
    let reads = 0;
    f.data['GET /repos/{owner}/{repo}/git/ref/{ref}'] = () => ({
      object: { sha: ++reads > 1 ? 'c'.repeat(40) : base },
    });
  }
  await reconcile(f.github, f.config);
  expect(f.calls.filter((r) => r.startsWith('PUT'))).toHaveLength(0);
});
it('paginates unresolved review threads and blocks later-page findings', async () => {
  const f = fixture();
  let reads = 0;
  f.github.graphql = async () =>
    ({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: ++reads > 1 ? [{ isResolved: false }] : [],
            pageInfo: { hasNextPage: reads === 1, endCursor: 'cursor' },
          },
        },
      },
    }) as ReturnType<typeof JSON.parse>;
  await reconcile(f.github, f.config);
  expect(reads).toBe(2);
  expect(f.calls.filter((r) => r.startsWith('PUT'))).toHaveLength(0);
});
it('never retries an uncertain merge mutation', async () => {
  const f = fixture();
  f.data['PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge'] = () => {
    throw new Error('connection lost');
  };
  expect((await reconcile(f.github, f.config))[0].reason).toBe('connection lost');
  expect(f.calls.filter((r) => r.startsWith('PUT'))).toHaveLength(1);
});
it.each([
  [{}, 'refs/heads/main', false],
  [{ PR_LANDING_APP_ID: '' }, 'refs/heads/main', false],
  [{ PR_LANDING_APP_ID: '123' }, 'refs/heads/feature', false],
  [{ PR_LANDING_APP_ID: '123' }, 'refs/heads/main', true],
])(
  'enables the writer only after default-branch provisioning (%j, %s)',
  async (variables, ref, expected) => {
    const { readFileSync } = await import('node:fs');
    const { load } = await import('js-yaml');
    const { Script } = await import('node:vm');
    const writer = load(
      readFileSync('.github/workflows/pr-landing-reconcile.yml', 'utf8'),
    ) as ReturnType<typeof JSON.parse>;
    const result = new Script(writer.jobs.reconcile.if).runInNewContext({
      github: { ref, event: { repository: { default_branch: 'main' } } },
      vars: new Proxy(variables, { get: (target, key) => Reflect.get(target, key) ?? '' }),
      format: (template: string, value: string) => template.replace('{0}', value),
    });
    expect(result).toBe(expected);
  },
);

it('keeps credentials in a dedicated default-branch environment and executes only trusted checkout', async () => {
  const { readFileSync } = await import('node:fs');
  const { load } = await import('js-yaml');
  const request = load(
    readFileSync('.github/workflows/pr-landing-request.yml', 'utf8'),
  ) as ReturnType<typeof JSON.parse>;
  const writer = load(
    readFileSync('.github/workflows/pr-landing-reconcile.yml', 'utf8'),
  ) as ReturnType<typeof JSON.parse>;
  expect(request['run-name']).toBe('land-pr:${{ inputs.pr_number }}:${{ inputs.mode }}');
  expect(request.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
  expect(writer.permissions).toEqual({ contents: 'read' });
  expect(writer.jobs.reconcile.environment).toBe('pr-landing-writer');
  expect(writer.concurrency['cancel-in-progress']).toBe(false);
  for (const workflow of [request, writer]) {
    const job = Object.values(workflow.jobs)[0] as ReturnType<typeof JSON.parse>;
    expect(job.if).toContain('github.event.repository.default_branch');
    expect(job.steps[0].with).toEqual({ ref: '${{ github.sha }}', 'persist-credentials': false });
    expect(JSON.stringify(workflow)).not.toContain('download-artifact');
  }
  const mint = writer.jobs.reconcile.steps.find(
    (step: ReturnType<typeof JSON.parse>) => step.id === 'landing-token',
  );
  expect(mint.with['permission-administration']).toBe('read');
  expect(mint.with['private-key']).toBe('${{ secrets.PR_LANDING_APP_PRIVATE_KEY }}');
  expect(writer.jobs.reconcile.steps.at(-1).with['github-token']).toBe(
    '${{ steps.landing-token.outputs.token }}',
  );
});

it.each(['success', 'skipped'])(
  'accepts selected native %s only alongside successful Actions ci',
  async (conclusion) => {
    const f = fixture();
    f.data[
      'GET /repos/{owner}/{repo}/branches/{branch}/protection'
    ].required_status_checks.checks.push({
      context: 'Native Swift tests and builds',
      app_id: 15368,
    });
    f.data['GET /repos/{owner}/{repo}/commits/{ref}/check-runs'].push({
      name: 'Native Swift tests and builds',
      status: 'completed',
      conclusion,
      app: { id: 15368 },
    });
    expect((await reconcile(f.github, f.config))[0].decision).toBe('merged');
  },
);
it('rejects unknown skipped checks even with successful ci', async () => {
  const f = fixture();
  f.data[
    'GET /repos/{owner}/{repo}/branches/{branch}/protection'
  ].required_status_checks.checks.push({ context: 'Unknown check', app_id: 15368 });
  f.data['GET /repos/{owner}/{repo}/commits/{ref}/check-runs'].push({
    name: 'Unknown check',
    status: 'completed',
    conclusion: 'skipped',
    app: { id: 15368 },
  });
  expect((await reconcile(f.github, f.config))[0].decision).toBe('blocked');
});

it('passes the immutable authorized head to GitHub merge', async () => {
  const f = fixture();
  let argument;
  f.data['PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge'] = (
    args: ReturnType<typeof JSON.parse>,
  ) => {
    argument = args;
    return { merged: true };
  };
  await reconcile(f.github, f.config);
  expect(argument).toMatchObject({ pull_number: 7, sha: head, merge_method: 'squash' });
});
it('selects newer failing check reruns over older green attempts', async () => {
  const f = fixture();
  f.data['GET /repos/{owner}/{repo}/commits/{ref}/check-runs'] = [
    { id: 1, name: 'ci', status: 'completed', conclusion: 'success', app: { id: 15368 } },
    { id: 2, name: 'ci', status: 'completed', conclusion: 'failure', app: { id: 15368 } },
  ];
  expect((await reconcile(f.github, f.config))[0].decision).toBe('blocked');
});
it('never reuses an older green status after a newer App failure', async () => {
  const f = fixture();
  f.data['GET /repos/{owner}/{repo}/commits/{ref}/statuses'].unshift({
    context: 'Centaur final LGTM',
    state: 'failure',
    creator: { login: 'gate[bot]' },
  });
  expect((await reconcile(f.github, f.config))[0].decision).toBe('blocked');
});
it('blocks a head change during final validation', async () => {
  const f = fixture();
  let reads = 0;
  f.data['GET /repos/{owner}/{repo}/pulls/{pull_number}'] = () =>
    ++reads > 1 ? { ...pr, head: { ...pr.head, sha: 'c'.repeat(40) } } : pr;
  await reconcile(f.github, f.config);
  expect(f.calls.filter((r) => r.startsWith('PUT'))).toHaveLength(0);
});
it('fails closed on a review-thread cursor cycle', async () => {
  const f = fixture();
  let reads = 0;
  f.github.graphql = (async () => {
    reads++;
    return {
      repository: {
        pullRequest: {
          reviewThreads: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' } },
        },
      },
    };
  }) as ReturnType<typeof JSON.parse>;
  await reconcile(f.github, f.config);
  expect(reads).toBe(2);
  expect(f.calls.filter((r) => r.startsWith('PUT'))).toHaveLength(0);
});

it('a later comment cannot clear an outstanding human change request', async () => {
  const f = fixture();
  f.data['GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews'].push(
    { user: { login: 'human' }, state: 'CHANGES_REQUESTED' },
    { user: { login: 'human' }, state: 'COMMENTED' },
  );
  expect((await reconcile(f.github, f.config))[0].decision).toBe('blocked');
});

it.each(['07', ' 7', '7 ', '7e0', '+7', '0x7'])(
  'rejects noncanonical new PR input %j',
  async (pr_number) => {
    const f = fixture();
    await expect(
      buildRequest(f.github, f.config, { pr_number, mode: 'revoke' }, 'owner'),
    ).rejects.toThrow('Invalid request');
  },
);
it.each(['07', ' 7', '7 ', '7e0', '+7', '0x7'])(
  'newer legacy alias %j intent blocks an older canonical grant',
  async (raw) => {
    const f = fixture();
    const newer = {
      ...f.run,
      id: 11,
      display_title: `land-pr:${raw}:revoke`,
      status: 'in_progress',
      conclusion: null,
    };
    f.data['GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs'] = [newer, f.run];
    f.data['GET /repos/{owner}/{repo}/actions/runs/{run_id}'] = (
      args: ReturnType<typeof JSON.parse>,
    ) => (args.run_id === 11 ? newer : f.run);
    expect((await latestRequest(f.github, f.config, 7)).authorized).toBe(false);
    await reconcile(f.github, f.config);
    expect(f.calls.filter((r) => r.startsWith('PUT'))).toHaveLength(0);
  },
);
it('discovers alias-only incomplete intents but never authorizes an alias title', async () => {
  const f = fixture();
  const alias = { ...f.run, display_title: 'land-pr:07:authorize' };
  f.data['GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs'] = [alias];
  f.data['GET /repos/{owner}/{repo}/actions/runs/{run_id}'] = alias;
  expect(
    (await reconcile(f.github, f.config)).map((r: ReturnType<typeof JSON.parse>) => r.number),
  ).toEqual([7]);
  expect(f.calls.filter((r) => r.startsWith('PUT'))).toHaveLength(0);
});

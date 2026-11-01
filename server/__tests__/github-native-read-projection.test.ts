import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { githubReadProjection, githubReadSummary } from '../github-read-summary.js';
import { trustedGitHubReadRequest } from '../trusted-native-operation.js';

const records = [
  {
    number: 7,
    title: 'Evidence',
    state: 'closed',
    html_url: 'https://github.com/example/project/pull/7',
    body: 'Verbose PR body '.repeat(4000),
    user: { login: 'author', avatar_url: 'noise' },
    labels: [{ name: 'bug', color: 'noise' }],
    pull_request: {
      url: 'https://api.github.com/repos/example/project/pulls/7',
      merged_at: '2026-09-01',
    },
    commit: {
      message: 'First line\r\nLong body',
      author: { name: 'A', date: '2026-09-01', email: 'noise' },
      verification: { verified: true, reason: 'valid', signature: 'noise' },
    },
  },
  { number: 8, title: 'Issue', body: 'Another body '.repeat(1000) },
];
const project = (body: unknown, url: string) => {
  const expression = githubReadProjection(url);
  expect(expression).toBeDefined();
  return execFileSync('jq', ['-c', expression!], {
    input: JSON.stringify(body),
    encoding: 'utf8',
    maxBuffer: 65536,
  }).trim();
};

it('retains the exact commit identity of a tag in native and URL summaries', () => {
  const url = 'https://api.github.com/repos/example/project/tags';
  const tags = [
    {
      name: 'v1.0',
      commit: {
        sha: 'a'.repeat(40),
        url: 'https://api.github.com/repos/example/project/commits/' + 'a'.repeat(40),
      },
      zipball_url: 'verbose',
    },
  ];
  const native = JSON.parse(githubReadSummary(project(tags, url), url));
  const web = JSON.parse(githubReadSummary(JSON.stringify(tags), url));
  expect(native.items[0]).toMatchObject({ name: 'v1.0', commit: tags[0].commit });
  expect(native).toEqual(web);
});

describe('plain-list route projection', () => {
  const referenceUrl = 'https://api.github.com/repos/example/project/pulls?per_page=2&page=3';
  let projectedRecords: string;
  beforeAll(() => {
    projectedRecords = project(records, referenceUrl);
  });
  it.each(['issues', 'pulls', 'commits', 'contributors', 'releases', 'tags', 'contents/src'])(
    'projects %s before the native stdout cap using the same fields as approved URL reads',
    (endpoint) => {
      const url = `https://api.github.com/repos/example/project/${endpoint}?per_page=2&page=3`;
      expect(Buffer.byteLength(JSON.stringify(records))).toBeGreaterThan(65536);
      // Share only pure output of the byte-identical fixed expression and fixture.
      expect(githubReadProjection(url)).toBe(githubReadProjection(referenceUrl));
      const bounded = projectedRecords;
      expect(Buffer.byteLength(bounded)).toBeLessThan(4096);
      expect(JSON.parse(githubReadSummary(bounded, url))).toEqual(
        JSON.parse(githubReadSummary(JSON.stringify(records), url)),
      );
      expect(bounded).not.toMatch(/Verbose PR body|avatar_url|signature|Long body/);
      expect(JSON.parse(githubReadSummary(bounded, url))).toMatchObject({
        returned: 2,
        omitted: 0,
      });
    },
  );
});

it.each([
  ['git/trees/main', 'tree'],
  ['commits/main/check-runs', 'check_runs'],
  ['actions/workflows', 'workflows'],
])('preserves the %s wrapper and completeness evidence', (endpoint, key) => {
  const url = `https://api.github.com/repos/example/project/${endpoint}`;
  const body = {
    total_count: 200,
    sha: 'original',
    truncated: true,
    [key]: records,
    irrelevant: 'unselected wrapper metadata',
  };
  const bounded = project(body, url);
  expect(JSON.parse(githubReadSummary(bounded, url))).toEqual(
    JSON.parse(githubReadSummary(JSON.stringify(body), url)),
  );
});

it('uses a fixed projection on the approved endpoint, while full and individual record reads stay explicit', () => {
  const endpoint = '/repos/example/project/pulls?per_page=2';
  const summary = trustedGitHubReadRequest(endpoint);
  expect(summary.args).toContain('--jq');
  expect(summary.args).toContain(endpoint);
  expect(summary.args.slice(0, 6)).toEqual([
    'api',
    '--hostname',
    'github.com',
    '--method',
    'GET',
    endpoint,
  ]);
  expect(trustedGitHubReadRequest(endpoint, 'full').args).not.toContain('--jq');
  expect(trustedGitHubReadRequest('/repos/example/project/pulls/7').args).not.toContain('--jq');
  expect(githubReadProjection('https://other.example/repos/example/project/pulls')).toBeUndefined();
});

it.each(['contents/file.txt', 'git/trees/main', 'commits/main/check-runs', 'actions/workflows'])(
  'does not turn %s error objects or malformed arrays into invented lists',
  (path) => {
    const url = `https://api.github.com/repos/example/project/${path}`;
    for (const body of [
      { content: 'exact body', encoding: 'base64' },
      { message: 'source error' },
      [null],
      ['unexpected'],
    ]) {
      expect(JSON.parse(project(body, url))).toEqual(body);
    }
  },
);

it('projects changed-file patches and Actions runs before the native stdout cap', () => {
  const filesUrl = 'https://api.github.com/repos/example/project/pulls/7/files?per_page=2';
  const files = [
    {
      filename: 'src/fix.ts',
      previous_filename: 'src/old.ts',
      sha: 'a'.repeat(40),
      status: 'renamed',
      additions: 2,
      deletions: 1,
      changes: 3,
      patch: 'large diff'.repeat(10000),
    },
  ];
  const runsUrl =
    'https://api.github.com/repos/example/project/actions/runs?head_sha=abc&per_page=2';
  const runs = {
    total_count: 8,
    workflow_runs: [
      {
        id: 42,
        name: 'CI',
        head_sha: 'abc',
        run_attempt: 2,
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://github.com/example/project/actions/runs/42',
        repository: { noise: 'large metadata'.repeat(10000) },
      },
    ],
  };
  const artifactsUrl = 'https://api.github.com/repos/example/project/actions/artifacts';
  const workflowRun = {
    id: 42,
    repository_id: 1,
    head_repository_id: 2,
    head_branch: 'fix',
    head_sha: 'abc',
  };
  const artifacts = {
    total_count: 8,
    artifacts: [
      {
        id: 5,
        name: 'build',
        workflow_run: { ...workflowRun, noise: 'large metadata'.repeat(10000) },
      },
    ],
  };
  const summaries = [];
  for (const [body, url] of [
    [files, filesUrl],
    [runs, runsUrl],
    [artifacts, artifactsUrl],
  ] as const) {
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(65536);
    const bounded = project(body, url);
    expect(Buffer.byteLength(bounded)).toBeLessThan(2048);
    const native = JSON.parse(githubReadSummary(bounded, url));
    summaries.push(native);
    expect(native).toEqual(JSON.parse(githubReadSummary(JSON.stringify(body), url)));
  }
  expect(summaries[0].items[0]).toMatchObject({
    filename: 'src/fix.ts',
    previous_filename: 'src/old.ts',
    additions: 2,
    deletions: 1,
  });
  expect(summaries[1]).toMatchObject({
    total_count: 8,
    returned: 1,
    items: [{ id: 42, head_sha: 'abc', run_attempt: 2, conclusion: 'failure' }],
  });
  expect(summaries[2]).toMatchObject({
    total_count: 8,
    items: [{ id: 5, name: 'build', workflow_run: workflowRun }],
  });
  expect(summaries[2].items[0].workflow_run).not.toHaveProperty('noise');
  expect(
    trustedGitHubReadRequest('/repos/example/project/pulls/7/files', 'full').args,
  ).not.toContain('--jq');
});

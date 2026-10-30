import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { githubReadProjection, githubReadSummary } from '../github-read-summary.js';
import { trustedGitHubReadRequest } from '../trusted-native-operation.js';

const records = [
  {
    number: 7,
    title: 'Evidence',
    state: 'closed',
    html_url: 'https://github.com/example/project/pull/7',
    body: 'Verbose PR body '.repeat(20000),
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
  { number: 8, title: 'Issue', body: 'Another body '.repeat(10000) },
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

it.each(['issues', 'pulls', 'commits', 'contributors', 'releases', 'tags', 'contents/src'])(
  'projects %s before the native stdout cap using the same fields as approved URL reads',
  (endpoint) => {
    const url = `https://api.github.com/repos/example/project/${endpoint}?per_page=2&page=3`;
    expect(Buffer.byteLength(JSON.stringify(records))).toBeGreaterThan(65536);
    const bounded = project(records, url);
    expect(Buffer.byteLength(bounded)).toBeLessThan(4096);
    expect(JSON.parse(githubReadSummary(bounded, url))).toEqual(
      JSON.parse(githubReadSummary(JSON.stringify(records), url)),
    );
    expect(bounded).not.toMatch(/Verbose PR body|avatar_url|signature|Long body/);
    expect(JSON.parse(githubReadSummary(bounded, url))).toMatchObject({ returned: 2, omitted: 0 });
  },
);

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
    irrelevant: 'x'.repeat(100000),
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

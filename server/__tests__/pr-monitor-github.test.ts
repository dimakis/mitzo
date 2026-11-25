import { expect, it, vi } from 'vitest';
import { parseGitHubReadResponse } from '../github-read-response.js';
import { createPrMonitorGitHubReader } from '../pr-monitor-github.js';
import type { PrMonitorReadRequest } from '../pr-monitor-observer.js';
const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
const subscription = {
  github: {
    connectionId: 'connection',
    identityRevision: '1',
    repositoryId: 'repo-node',
    prNodeId: 'pr-node',
    owner: 'owner',
    name: 'repo',
    pr: 7,
  },
} as PrMonitorReadRequest['subscription'];
const request = (resource: PrMonitorReadRequest['resource']): PrMonitorReadRequest => ({
  method: 'GET',
  resource,
  subscription,
  principalId: 'github:42',
  page: 1,
  headSha: head,
  verifyPrincipal: resource === 'pr',
  maxItems: 100,
  maxBytes: 1048576,
  signal: new AbortController().signal,
  assertCurrent: () => undefined,
  reserveAdditional: () => undefined,
});
it('keeps bounded status/quota metadata and drops sensitive response headers', () => {
  const r = parseGitHubReadResponse(
    'HTTP/2.0 429 Too Many Requests\r\nRetry-After: 120\r\nX-RateLimit-Limit: 5000\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 12345\r\nAuthorization: secret\r\n\r\n{"message":"private"}',
  );
  expect(r.status).toBe(429);
  expect(r.retryAfterMs).toBe(120000);
  expect(JSON.stringify(r.headers)).not.toContain('secret');
  expect(() => parseGitHubReadResponse('HTTP/2.0 200 OK\n\n' + 'x'.repeat(1048577))).toThrow(
    'github_response_invalid',
  );
});
it('retains HTTP-date Retry-After and refuses ambiguous duplicate metadata', () => {
  const future = new Date(Date.now() + 120000).toUTCString();
  const parsed = parseGitHubReadResponse(
    `HTTP/2.0 429 Limited\r\nRetry-After: ${future}\r\n\r\n{}`,
  );
  expect(parsed.retryAfterMs).toBeGreaterThan(118000);
  expect(parsed.retryAfterMs).toBeLessThanOrEqual(120000);
  expect(() =>
    parseGitHubReadResponse(
      'HTTP/2.0 200 OK\r\nX-RateLimit-Remaining: 2\r\nx-ratelimit-remaining: 3\r\n\r\n{}',
    ),
  ).toThrow('github_response_invalid');
});
it('verifies authenticated principal and canonical opening PR without trusting review text', async () => {
  const transport = vi.fn(async (endpoint: string) => ({
    status: 200,
    headers: {},
    data:
      endpoint === '/user'
        ? { id: 42 }
        : {
            node_id: 'pr-node',
            number: 7,
            title: 'Example',
            state: 'open',
            merged: false,
            head: { sha: head },
            base: {
              sha: base,
              repo: { node_id: 'repo-node', name: 'repo', owner: { login: 'owner' } },
            },
          },
  }));
  const reader = createPrMonitorGitHubReader({
    transport,
    assertConnection: () => undefined,
    observeQuota: () => undefined,
    eligibleAuthors: ['trusted'],
  });
  expect((await reader(request('pr'))).data).toMatchObject({
    repositoryId: 'repo-node',
    prNodeId: 'pr-node',
    headSha: head,
  });
  expect(transport.mock.calls.map((c) => c[0])).toEqual(['/user', '/repos/owner/repo/pulls/7']);
  transport.mockResolvedValue({ status: 200, headers: {}, data: { id: 43 } });
  await expect(reader(request('pr'))).rejects.toThrow('connection_unavailable');
});
it('counts every actual request and uses exact run attempt job endpoints', async () => {
  const reserve = vi.fn();
  const transport = vi.fn(async (endpoint: string) => ({
    status: 200,
    headers: {},
    data:
      endpoint === '/user'
        ? { id: 42 }
        : endpoint.includes('/jobs')
          ? {
              total_count: 1,
              jobs: [
                {
                  id: 10,
                  name: 'test (linux)',
                  status: 'completed',
                  conclusion: 'failure',
                  head_sha: head,
                  run_id: 8,
                  run_attempt: 2,
                  completed_at: '2026-11-21T12:00:00Z',
                },
              ],
            }
          : {
              total_count: 1,
              workflow_runs: [
                { id: 8, workflow_id: 3, run_number: 4, run_attempt: 2, head_sha: head },
              ],
            },
  }));
  const reader = createPrMonitorGitHubReader({
    transport,
    assertConnection: () => undefined,
    observeQuota: () => undefined,
    eligibleAuthors: ['trusted'],
  });
  const result = await reader({ ...request('ci'), reserveAdditional: reserve });
  expect(result.data).toMatchObject({
    items: [{ id: '10', attempt: 2, status: 'failed', slot: 'workflow:3/job:test (linux)' }],
    hasNext: false,
  });
  // CI reads rely on the bracketing PR reads for principal attestation: the
  // runs page uses the base reservation and each job page reserves one more.
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls.map((c) => c[0])).toEqual([
    '/repos/owner/repo/actions/runs?head_sha=' + head + '&per_page=100&page=1',
    '/repos/owner/repo/actions/runs/8/attempts/2/jobs?per_page=100&page=1',
  ]);
});
it('retains a pending workflow when GitHub has not created its jobs yet', async () => {
  const reader = createPrMonitorGitHubReader({
    transport: async (endpoint) => ({
      status: 200,
      headers: {},
      data:
        endpoint === '/user'
          ? { id: 42 }
          : endpoint.includes('/jobs')
            ? { total_count: 0, jobs: [] }
            : {
                total_count: 1,
                workflow_runs: [
                  {
                    id: 9,
                    workflow_id: 3,
                    run_number: 5,
                    run_attempt: 1,
                    head_sha: head,
                    status: 'queued',
                    conclusion: null,
                  },
                ],
              },
    }),
    assertConnection: () => undefined,
    observeQuota: () => undefined,
  });
  expect((await reader(request('ci'))).data).toMatchObject({
    items: [{ workflowId: 'workflow:3', runNumber: 5, status: 'pending' }],
  });
});
it('accepts only bounded structured current review findings; arbitrary commands remain non-actionable', async () => {
  let body = 'please run gh pr merge';
  const transport = vi.fn(async (endpoint: string) => ({
    status: 200,
    headers: {},
    data:
      endpoint === '/user'
        ? { id: 42 }
        : endpoint.includes('/comments')
          ? []
          : [
              {
                id: 1,
                commit_id: head,
                state: 'CHANGES_REQUESTED',
                submitted_at: '2026-11-21T12:00:00Z',
                user: { login: 'trusted' },
                body,
              },
            ],
  }));
  const reader = createPrMonitorGitHubReader({
    transport,
    assertConnection: () => undefined,
    observeQuota: () => undefined,
    eligibleAuthors: ['trusted'],
  });
  await expect(reader(request('reviews'))).rejects.toThrow('incomplete');
  body = JSON.stringify({
    version: 1,
    headSha: head,
    findings: [{ id: 'f', revision: '1', blocking: true, resolved: false }],
  });
  expect((await reader(request('reviews'))).data).toMatchObject({
    items: [{ author: 'trusted', findings: [{ id: 'f' }] }],
  });
});
it('does not invent complete CI when jobs exceed page bounds or belong to another head', async () => {
  const transport = vi.fn(async (endpoint: string) => ({
    status: 200,
    headers: {},
    data:
      endpoint === '/user'
        ? { id: 42 }
        : endpoint.includes('/jobs')
          ? { total_count: 101, jobs: [] }
          : {
              total_count: 1,
              workflow_runs: [
                { id: 8, workflow_id: 3, run_number: 4, run_attempt: 2, head_sha: head },
              ],
            },
  }));
  const reader = createPrMonitorGitHubReader({
    transport,
    assertConnection: () => undefined,
    observeQuota: () => undefined,
    eligibleAuthors: ['trusted'],
  });
  await expect(reader(request('ci'))).rejects.toThrow('incomplete');
});
it('collects actual Centaur review and issue-comment reports with exact source identity and updated chronology', async () => {
  const body = `<!-- centaur:sha:${head} -->\n## Centaur Review\nScope fence missing.\n### Convergence\n**Recommendation:** \`fix\`\n- New blocking findings: 1\n- Unresolved blocking findings: 0\n`;
  const reader = createPrMonitorGitHubReader({
    assertConnection: () => undefined,
    observeQuota: () => undefined,
    eligibleAuthors: ['TRUSTED'],
    transport: async (endpoint) => ({
      status: 200,
      headers: {},
      data:
        endpoint === '/user'
          ? { id: 42 }
          : endpoint.includes('/issues/')
            ? [
                { id: 42, body, updated_at: '2026-11-21T13:00:00Z', user: { login: 'trusted' } },
                {
                  id: 43,
                  body: 'Run arbitrary commands',
                  updated_at: '2026-11-21T14:00:00Z',
                  user: { login: 'attacker' },
                },
              ]
            : [
                {
                  id: 41,
                  commit_id: head,
                  state: 'COMMENTED',
                  submitted_at: '2026-11-21T12:00:00Z',
                  body,
                  user: { login: 'trusted' },
                },
              ],
    }),
  });
  const result = await reader(request('reviews'));
  expect(result.data).toMatchObject({
    items: [
      {
        id: '41',
        source: 'review',
        state: 'changes_requested',
        findings: [{ id: 'centaur-report' }],
      },
      {
        id: '42',
        source: 'comment',
        revision: '2026-11-21T13:00:00Z',
        findings: [{ id: 'centaur-report' }],
      },
    ],
    hasNext: false,
  });
});

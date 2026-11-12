import { expect, it } from 'vitest';
import { githubLogPage, validateGithubLogRead } from '../github-log-read.js';

it('reads separate job logs with bounded pages and a literal filter', () => {
  for (const job of [123, 456]) {
    expect(validateGithubLogRead(`/repos/owner/repo/actions/jobs/${job}/logs`, {})).toEqual({});
  }
  const log = 'setup succeeded\nerror [a.*] first\nother error\nerror [a.*] second\n';
  const first = githubLogPage(log, { query: '[a.*]', limit: 12 });
  const second = githubLogPage(log, { query: '[a.*]', offset: first.nextOffset!, limit: 16000 });
  expect(first.content + second.content).toBe('error [a.*] first\nerror [a.*] second');
  expect(second.nextOffset).toBeNull();
  expect(first.totalCharacters).toBe(36);
});

it('does not silently truncate oversized lines or lose page boundaries', () => {
  const log = 'x'.repeat(70000);
  const first = githubLogPage(log, {});
  expect(first.content).toHaveLength(16000);
  expect(first.nextOffset).toBe(16000);
  expect(first.totalCharacters).toBe(70000);
  expect(githubLogPage(log, { offset: 69998 }).content).toBe('xx');
});

it.each([
  '/repos/owner/repo/actions/runs/123/logs',
  '/repos/owner/repo/actions/jobs/123/logs?redirect=elsewhere',
  '/repos/owner/repo/contents/file',
  'https://example.com/logs',
])('rejects non-job-log source %s', (endpoint) => {
  expect(() => validateGithubLogRead(endpoint, {})).toThrow();
});

it.each([
  { offset: -1 },
  { limit: 16001 },
  { limit: 0 },
  { query: 'x'.repeat(501) },
  { regex: '.*' },
])('rejects invalid log controls %j', (options) => {
  expect(() => validateGithubLogRead('/repos/o/r/actions/jobs/123/logs', options)).toThrow();
});

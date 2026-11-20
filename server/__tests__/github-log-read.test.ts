import { expect, it } from 'vitest';
import {
  classifyGithubLogTransportFailure,
  describeGithubLogTransportFailure,
  githubLogPage,
  validateGithubLogRead,
} from '../github-log-read.js';

it.each([
  ['gh: HTTP 403\n', 403, 'access denied or rate limited'],
  ['HTTP 404', 404, 'not found or not visible to this credential'],
  ['warning: retrying\ngh: HTTP 502\n', 502, 'server error'],
  ['gh: Not Found (HTTP 404)\n', 404, 'not found or not visible to this credential'],
  ['gh: Gone (HTTP 410)\n', 410, 'log no longer available'],
  ['gh: Teapot (HTTP 418)\n', 418, undefined],
])('classifies the HTTP status of %j with a fixed meaning', (stderr, status, meaning) => {
  const failure = classifyGithubLogTransportFailure(stderr);
  expect(failure).toEqual({ reason: 'http_status', status, ...(meaning ? { meaning } : {}) });
  expect(describeGithubLogTransportFailure(failure)).toBe(
    `the log request returned HTTP ${status}${meaning ? ` (${meaning})` : ''}`,
  );
});

it.each([
  'gh: Request denied for unexpected.example with sig=SECRET (HTTP 403)\n',
  'gh: see https://unexpected.example/a?sig=SECRET&token=SECRET for details (HTTP 403)\n',
  'gh: token ghp_SECRET was rejected by unexpected.example (HTTP 401)\n',
  `gh: ${'SECRET '.repeat(2000)}(HTTP 403)\n`,
  `${'SECRET\n'.repeat(1000)}gh: HTTP 403\n`,
  'gh: <Error><Code>AuthenticationFailed</Code><Message>sig=SECRET unexpected.example</Message></Error> (HTTP 403)\n',
])('never passes free-form API message text through (%#)', (stderr) => {
  const failure = classifyGithubLogTransportFailure(stderr);
  const reported = JSON.stringify(failure) + describeGithubLogTransportFailure(failure);
  expect(failure.reason).toBe('http_status');
  expect(reported).not.toMatch(/SECRET|sig=|token|ghp_|unexpected|example|\?|<|Error>/);
});

it.each(['gh: HTTP/1.1 transport connection broken\n', 'gh: HTTP 9999\n', 'gh: HTTP 099\n'])(
  'does not invent an HTTP status from %j',
  (stderr) => {
    expect(classifyGithubLogTransportFailure(stderr).reason).not.toBe('http_status');
  },
);

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

it('strips terminal controls before filtering and paging while retaining original source bytes', () => {
  const body = '\u001b[31mFAIL\u001b[0m first\n\u001b]52;c;clipboard\u0007FAIL last\n';
  const first = githubLogPage(body, { query: 'FAIL', limit: 8 });
  const rest = githubLogPage(body, { query: 'FAIL', offset: first.nextOffset! });
  expect(first.content + rest.content).toBe('FAIL first\nFAIL last');
  expect(first.sourceBytes).toBe(Buffer.byteLength(body));
  expect(rest.nextOffset).toBeNull();
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

import console from 'node:console';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BrowserFailureReporter from '../ci-browser-failure-reporter.mjs';

beforeEach(() => vi.stubEnv('GITHUB_ACTIONS', ''));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('records an unexpectedly passing expected-failure case as a real suite failure', () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  new BrowserFailureReporter().onTestEnd(
    { id: 'unexpected-pass', expectedStatus: 'failed' },
    { status: 'passed' },
  );
  expect(output).toHaveBeenCalledExactlyOnceWith(
    'CI_BROWSER_TEST_FAILURE {"status":"passed","testId":"unexpected-pass"}',
  );
});
it.each(['failed', 'timedOut'])(
  'immediately records an unexpected %s case before any suite summary',
  (status) => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reporter = new BrowserFailureReporter();
    reporter.onTestEnd({ id: 'case-id', expectedStatus: 'passed' }, { status });
    expect(output).toHaveBeenCalledExactlyOnceWith(
      'CI_BROWSER_TEST_FAILURE ' + JSON.stringify({ status, testId: 'case-id' }),
    );
  },
);
it('records a global test error without relying on shutdown or final reporting', () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  new BrowserFailureReporter().onError();
  expect(output).toHaveBeenCalledWith('CI_BROWSER_TEST_FAILURE {"status":"error"}');
});
it('annotates the first failure message on GitHub Actions so it is readable without job logs', () => {
  vi.stubEnv('GITHUB_ACTIONS', 'true');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  new BrowserFailureReporter().onTestEnd(
    {
      id: 'case-id',
      title: 'inspects, context',
      expectedStatus: 'passed',
      location: { file: `${process.cwd()}/tests/offline/example.spec.ts`, line: 12 },
      parent: { project: () => ({ name: 'mobile-webkit' }) },
    },
    {
      status: 'failed',
      errors: [{ message: '\u001b[31mexpected\u001b[39m 50%\nreceived: 1' }],
    },
  );
  expect(output).toHaveBeenNthCalledWith(
    2,
    '::error file=tests/offline/example.spec.ts,line=12,title=mobile-webkit › inspects%2C context::expected 50%25%0Areceived: 1',
  );
  output.mockClear();
  new BrowserFailureReporter().onError({ message: 'worker crashed' });
  expect(output).toHaveBeenNthCalledWith(2, '::error title=Browser suite error::worker crashed');
});
it('does not label successful, intentionally failing, skipped or interrupted cases as real failures', () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const reporter = new BrowserFailureReporter();
  for (const status of ['passed', 'skipped', 'interrupted'])
    reporter.onTestEnd({ id: 'case', expectedStatus: 'passed' }, { status });
  reporter.onTestEnd({ id: 'expected-failure', expectedStatus: 'failed' }, { status: 'failed' });
  expect(output).not.toHaveBeenCalled();
});

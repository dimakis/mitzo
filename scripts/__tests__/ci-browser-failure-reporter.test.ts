import console from 'node:console';
import { afterEach, expect, it, vi } from 'vitest';
import BrowserFailureReporter from '../ci-browser-failure-reporter.mjs';

afterEach(() => vi.restoreAllMocks());
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
it('does not label successful, intentionally failing, skipped or interrupted cases as real failures', () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const reporter = new BrowserFailureReporter();
  for (const status of ['passed', 'skipped', 'interrupted'])
    reporter.onTestEnd({ id: 'case', expectedStatus: 'passed' }, { status });
  reporter.onTestEnd({ id: 'expected-failure', expectedStatus: 'failed' }, { status: 'failed' });
  expect(output).not.toHaveBeenCalled();
});

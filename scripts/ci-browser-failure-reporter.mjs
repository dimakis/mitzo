import console from 'node:console';

// Emit completed failures immediately, before a later host shutdown can prevent
// Playwright's final summary. Expected failures and interruption are distinct.
export default class BrowserFailureReporter {
  onTestEnd(test, result) {
    if (['failed', 'timedOut'].includes(result.status) && result.status !== test.expectedStatus)
      console.log(
        'CI_BROWSER_TEST_FAILURE ' + JSON.stringify({ status: result.status, testId: test.id }),
      );
  }
  onError() {
    console.log('CI_BROWSER_TEST_FAILURE {"status":"error"}');
  }
}

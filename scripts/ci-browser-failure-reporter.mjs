import console from 'node:console';

// Emit unexpected completed outcomes immediately, before a host shutdown can prevent
// Playwright's final summary. Expected failures and interruption are distinct.
export default class BrowserFailureReporter {
  onTestEnd(test, result) {
    if (
      !['skipped', 'interrupted'].includes(result.status) &&
      result.status !== test.expectedStatus
    )
      console.log(
        'CI_BROWSER_TEST_FAILURE ' + JSON.stringify({ status: result.status, testId: test.id }),
      );
  }
  onError() {
    console.log('CI_BROWSER_TEST_FAILURE {"status":"error"}');
  }
}

import console from 'node:console';
import { relative } from 'node:path';
import process from 'node:process';

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const escapeData = (value) =>
  value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (value) => escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** GitHub annotations stay readable through the checks API when job logs are not. */
function annotate(test, result) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const error = result.errors?.[0] ?? result.error;
  const message = String(error?.message ?? error?.value ?? result.status)
    .replace(ANSI, '')
    .slice(0, 4000);
  const title = [test.parent?.project?.()?.name, test.title].filter(Boolean).join(' › ');
  const location = test.location
    ? `file=${escapeProperty(relative(process.cwd(), test.location.file))},line=${test.location.line},`
    : '';
  console.log(
    `::error ${location}title=${escapeProperty(title || 'Browser test failure')}::${escapeData(message)}`,
  );
}

// Emit unexpected completed outcomes immediately, before a host shutdown can prevent
// Playwright's final summary. Expected failures and interruption are distinct.
export default class BrowserFailureReporter {
  onTestEnd(test, result) {
    if (
      !['skipped', 'interrupted'].includes(result.status) &&
      result.status !== test.expectedStatus
    ) {
      console.log(
        'CI_BROWSER_TEST_FAILURE ' + JSON.stringify({ status: result.status, testId: test.id }),
      );
      annotate(test, result);
    }
  }
  onError(error) {
    console.log('CI_BROWSER_TEST_FAILURE {"status":"error"}');
    if (process.env.GITHUB_ACTIONS === 'true')
      console.log(
        `::error title=Browser suite error::${escapeData(
          String(error?.message ?? 'unknown')
            .replace(ANSI, '')
            .slice(0, 4000),
        )}`,
      );
  }
}

// Preserve the required check across parallel suites. Missing, cancelled and
// unexpectedly skipped work must never turn into a successful aggregate.
const needs = JSON.parse(process.env.CI_BROWSER_NEEDS ?? '{}');
if (needs.changes?.result !== 'success') {
  console.error('CI job selection did not succeed');
  process.exit(1);
}
const selection = needs.changes.outputs?.browser;
const expected = selection === 'true' ? 'success' : selection === 'false' ? 'skipped' : null;
if (!expected || [needs.browser, needs.offline].some((job) => job?.result !== expected)) {
  console.error('Browser validation incomplete: every selected suite must succeed');
  process.exit(1);
}
console.log(expected === 'success' ? 'All browser suites passed' : 'No dependent browser changes');

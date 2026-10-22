import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Keep `ci` required: matrix success alone cannot prove every shard ran.
try {
  const needs = JSON.parse(process.env.CI_CORE_NEEDS ?? '{}');
  for (const job of ['static', 'unit']) {
    if (needs[job]?.result !== 'success') throw Error(`Required ${job} job did not succeed`);
  }
  const directory = process.argv[2];
  if (!directory) throw Error('Unit evidence directory is required');
  const read = (name) => JSON.parse(readFileSync(join(directory, name), 'utf8'));
  let expected;
  let passed = 0;
  const seen = new Set();
  for (let shard = 1; shard <= 4; shard++) {
    const manifest = read(`files-${shard}.json`);
    if (!Array.isArray(manifest) || !manifest.length) throw Error('Empty test discovery');
    const files = manifest.map((entry) => entry.file).sort();
    if (files.some((file) => typeof file !== 'string') || new Set(files).size !== files.length)
      throw Error('Invalid test discovery');
    if (expected && JSON.stringify(expected) !== JSON.stringify(files))
      throw Error('Shards discovered different full test suites');
    expected = files;
    const report = read(`report-${shard}.json`);
    if (
      report.success !== true ||
      report.numFailedTests !== 0 ||
      report.numFailedTestSuites !== 0 ||
      !Number.isSafeInteger(report.numPassedTests) ||
      report.numPassedTests < 0 ||
      !Array.isArray(report.testResults) ||
      !report.testResults.length
    )
      throw Error(`Shard ${shard} has incomplete or unsuccessful test evidence`);
    passed += report.numPassedTests;
    for (const result of report.testResults) {
      if (
        !expected.includes(result.name) ||
        seen.has(result.name) ||
        !['passed', 'pending', 'skipped'].includes(result.status)
      )
        throw Error(`Missing, duplicate or unsuccessful test coverage: ${result.name}`);
      seen.add(result.name);
    }
  }
  if (seen.size !== expected.length) throw Error('Unit shards did not cover the full test suite');
  if (passed < 250) throw Error(`Test count dropped below 250 (got ${passed})`);
  const summary = `${passed} passed tests across ${seen.size} files; all 4 shards and static checks passed`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Unit tests\n\n${summary}\n`);
} catch (error) {
  console.error(`Core CI incomplete: ${error.message}`);
  process.exit(1);
}

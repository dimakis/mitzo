import process from 'node:process';
import console from 'node:console';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { preparedConsumerCases } from './ci-prepared-consumers.mjs';

// Final `ci` requires this validation: matrix success alone cannot prove every shard ran.
try {
  const needs = JSON.parse(process.env.CI_CORE_NEEDS ?? '{}');
  for (const job of ['core', 'unit']) {
    if (needs[job]?.result !== 'success') throw Error(`Required ${job} job did not succeed`);
  }
  const directory = process.argv[2];
  if (!directory) throw Error('Unit evidence directory is required');
  const read = (name) => JSON.parse(readFileSync(join(directory, name), 'utf8'));
  let expected;
  let discovery;
  let passed = 0;
  const seen = new Set();
  for (let shard = 1; shard <= 4; shard++) {
    const manifest = read(`files-${shard}.json`);
    if (!Array.isArray(manifest) || !manifest.length) throw Error('Empty test discovery');
    const files = manifest.map((entry) => entry.file).sort();
    if (files.some((file) => typeof file !== 'string') || new Set(files).size !== files.length)
      throw Error('Invalid test discovery');
    if (discovery && JSON.stringify(discovery) !== JSON.stringify(files))
      throw Error('Shards discovered different full test suites');
    discovery = files;
    for (const selected of preparedConsumerCases)
      if (files.filter((file) => file.endsWith('/' + selected.file)).length !== 1)
        throw Error('Full discovery must retain each transferred prepared consumer file');
    expected = files.filter(
      (file) => !preparedConsumerCases.some((selected) => file.endsWith('/' + selected.file)),
    );
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
  if (seen.size !== expected.length)
    throw Error('Unit shards did not cover every Linux-owned file');
  if (passed < 250) throw Error(`Test count dropped below 250 (got ${passed})`);
  const summary = `${passed} passed tests across ${seen.size} files; all 4 shards and core checks passed; 2 composed files require their separate owner`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Unit tests\n\n${summary}\n`);
} catch (error) {
  console.error(`Core CI incomplete: ${error.message}`);
  process.exit(1);
}

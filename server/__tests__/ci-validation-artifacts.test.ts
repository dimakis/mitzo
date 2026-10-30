import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it('retains source pins for every CI execution owner and extracted native qualification fixture', async () => {
  const artifacts: Readonly<Record<string, string>> = reviewedHandlerSourceArtifacts;
  for (const file of [
    '../../.github/workflows/ci-recovery.yml',
    '../../.github/workflows/ci.yml',
    '../../package.json',
    '../../playwright.config.ts',
    '../../playwright.offline.config.ts',
    '../../scripts/__tests__/browser-failure-evidence.test.ts',
    '../../scripts/__tests__/ci-browser-failure-reporter.test.ts',
    '../../scripts/__tests__/ci-browser-run.test.ts',
    '../../scripts/__tests__/ci-browser-batches.test.ts',
    '../../scripts/__tests__/ci-cancellation.test.ts',
    '../../scripts/__tests__/ci-joined-shards.test.ts',
    '../../scripts/__tests__/ci-recovery.test.ts',
    '../../scripts/__tests__/ci-required-gate.test.ts',
    '../../scripts/__tests__/ci-source-preflight.test.ts',
    '../../scripts/__tests__/ci-unit-sequencer.test.ts',
    '../../scripts/ci-selection.mjs',
    '../../scripts/__tests__/ci-selection.test.ts',
    '../../scripts/ci-build-output.py',
    '../../scripts/test-ci-build-output.py',
    '../../scripts/__tests__/ci-build-output.test.ts',
    '../../scripts/check-reviewed-handler-artifacts.mjs',
    '../../scripts/ci-browser-failure-reporter.mjs',
    '../../scripts/ci-browser-run.mjs',
    '../../scripts/ci-browser-batches.mjs',
    '../../scripts/ci-browser-batch-reporter.mjs',
    '../../scripts/ci-joined-gate.mjs',
    '../../scripts/ci-recovery.mjs',
    '../../scripts/ci-required-gate.mjs',
    '../../scripts/ci-unit-sequencer.ts',
    '../../scripts/ci-unit-shards.mjs',
    '../__tests__/ci-validation-artifacts.test.ts',
    '../__tests__/fixtures/prepared-repository-native-consumer.ts',
    '../__tests__/fixtures/prepared-repository-native-public.ts',
    '../__tests__/prepared-repository-native-cold-resume.test.ts',
    '../__tests__/prepared-repository-native-consumer.test.ts',
    '../__tests__/prepared-repository-native-owner-guards.test.ts',
    '../__tests__/prepared-repository-native-public-completed.test.ts',
    '../__tests__/prepared-repository-native-public-interrupted.test.ts',
    '../__tests__/prepared-repository-native-public-partial-adoption.test.ts',
    '../__tests__/prepared-repository-native-public-retained-http.test.ts',
    '../__tests__/prepared-repository-native-public-untransferred.test.ts',
    '../__tests__/prepared-repository-native-recovery.test.ts',
    '../../tests/integration/telos-s9/integrated-candidate/joined-shards.mjs',
    '../../tests/integration/telos-s9/integrated-candidate/run-joined-ci.mjs',
    '../../vitest.config.ts',
  ]) {
    const source = await readFile(
      new URL(file, new URL('../connections/', import.meta.url)),
      'utf8',
    );
    expect(artifacts[file], file).toBe(reviewedHandlerSourceFingerprint(source));
  }
});

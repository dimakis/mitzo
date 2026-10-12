#!/usr/bin/env node
import process from 'node:process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectContainedNativeBootstrap,
  preflightContainedNativeReplica,
  containedNativePreflightSummary,
} from './lib/staging-contained-native-controller.mjs';
try {
  if (
    process.platform !== 'darwin' ||
    process.send ||
    process.argv.length !== 7 ||
    process.argv[2] !== 'check' ||
    process.argv[3] !== '--bootstrap' ||
    process.argv[5] !== '--expected-bootstrap' ||
    !/^[a-f0-9]{64}$/.test(process.argv[6])
  )
    throw Error('Exact prepared canonical native preflight invocation required');
  const inspection = await inspectContainedNativeBootstrap({
    sourceRoot: dirname(dirname(fileURLToPath(import.meta.url))),
    bootstrapPath: process.argv[4],
    expectedBootstrap: process.argv[6],
  });
  await preflightContainedNativeReplica(inspection);
  process.stdout.write(JSON.stringify(containedNativePreflightSummary(inspection)) + '\n');
} catch (error) {
  process.stderr.write(
    'Canonical native preflight refused; no authentication, registration or native action.' +
      (typeof error?.nativeDiagnostic === 'string' ? ' ' + error.nativeDiagnostic : '') +
      '\n',
  );
  process.exitCode = 1;
}

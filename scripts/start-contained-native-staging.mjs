#!/usr/bin/env node
import process from 'node:process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runContainedNativeCanonicalLauncher } from './lib/staging-contained-native-controller.mjs';
try {
  if (
    process.platform !== 'darwin' ||
    process.send ||
    process.argv.length !== 5 ||
    process.argv[3] !== '--expected-bootstrap' ||
    !/^[a-f0-9]{64}$/.test(process.argv[4])
  )
    throw Error('Exact registered canonical native launcher invocation required');
  await runContainedNativeCanonicalLauncher({
    sourceRoot: dirname(dirname(fileURLToPath(import.meta.url))),
    bootstrapPath: process.argv[2],
    expectedBootstrap: process.argv[4],
  });
} catch (error) {
  const diagnostic = error?.nativeDiagnostic;
  process.stderr.write(
    'Canonical native launcher refused; retain original uncertainty, archive, registrations and any new guard.' +
      (typeof diagnostic === 'string' ? ' ' + diagnostic : '') +
      '\n',
  );
  process.exitCode = 1;
}

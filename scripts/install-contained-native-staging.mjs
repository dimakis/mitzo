#!/usr/bin/env node
import process from 'node:process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectContainedNativeBootstrap } from './lib/staging-contained-native-controller.mjs';
import { createContainedNativeInstallationHost } from './lib/staging-native-installation-host.mjs';
let host;
try {
  const command = process.argv[2],
    apply = command === 'apply';
  if (
    process.platform !== 'darwin' ||
    process.send ||
    !['plan', 'apply'].includes(command) ||
    process.argv.length !== (apply ? 9 : 7) ||
    process.argv[3] !== '--bootstrap' ||
    process.argv[5] !== '--expected-bootstrap' ||
    !/^[a-f0-9]{64}$/.test(process.argv[6]) ||
    (apply && (process.argv[7] !== '--expected-plan' || !/^[a-f0-9]{64}$/.test(process.argv[8])))
  )
    throw Error('Exact prepared canonical installation invocation required');
  process.umask(0o077);
  const inspection = await inspectContainedNativeBootstrap({
    sourceRoot: dirname(dirname(fileURLToPath(import.meta.url))),
    bootstrapPath: process.argv[4],
    expectedBootstrap: process.argv[6],
  });
  host = await createContainedNativeInstallationHost({ inspection });
  const result = apply ? await host.apply(process.argv[8]) : host.proposal;
  if (!apply) host.close();
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write(
    'Canonical native installation refused or uncertain; preserve original controls, incident evidence and any own guard.' +
      (typeof error?.nativeDiagnostic === 'string' ? ' ' + error.nativeDiagnostic : '') +
      '\n',
  );
  process.exitCode = 1;
}

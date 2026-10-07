#!/usr/bin/env node
import { reportLostSymposiumCustody } from '../../dist/symposium-lost-custody-report.js';

if (process.argv.length !== 4) {
  process.stderr.write(
    'Usage: node scripts/symposium/report-lost-custody.mjs ABS_EVENTS_DB ABS_STATE_PARENT\n',
  );
  process.exitCode = 2;
} else {
  try {
    const report = reportLostSymposiumCustody({
      eventDb: process.argv[2],
      stateParent: process.argv[3],
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch {
    process.stderr.write(
      'Lost-custody assessment unavailable; retain all resources and inspect the private ledgers.\n',
    );
    process.exitCode = 1;
  }
}

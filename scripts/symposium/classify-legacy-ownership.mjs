#!/usr/bin/env node
import { classifyLegacyNullOwnership } from '../../dist/symposium-legacy-ownership-report.js';

if (process.argv.length !== 4) {
  process.stderr.write(
    'Usage: node scripts/symposium/classify-legacy-ownership.mjs ABS_CONVERSATIONS_DB ABS_EVENTS_DB\n',
  );
  process.exitCode = 2;
} else {
  try {
    const report = classifyLegacyNullOwnership({
      conversationDb: process.argv[2],
      eventDb: process.argv[3],
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch {
    process.stderr.write('Legacy ownership report unavailable; retain NULL ownership fence.\n');
    process.exitCode = 1;
  }
}

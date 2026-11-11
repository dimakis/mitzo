#!/usr/bin/env node
import 'dotenv/config';
import { maintenanceMain } from '../dist/deployment-maintenance-cli.js';
import { maintenanceFailureDiagnostic } from '../dist/deployment-maintenance-format.js';
try {
  await maintenanceMain(process.argv.slice(2));
} catch (error) {
  // Private source records, JWTs, command bodies and process argv are not printed.
  console.error(JSON.stringify(maintenanceFailureDiagnostic(error)));
  process.exitCode = 1;
}

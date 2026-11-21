import 'dotenv/config';
import {
  migrateCompletedMaintenanceIdentity,
  validateMaintenanceBootstrap,
} from '../dist/deployment-maintenance-bootstrap.js';
import { maintenanceFailureDiagnostic } from '../dist/deployment-maintenance-format.js';
try {
  const args = process.argv.slice(2);
  if (!args.length) {
    validateMaintenanceBootstrap();
  } else if (args.length === 4 && args[0] === '--migrate-completed-identity') {
    migrateCompletedMaintenanceIdentity(args[1], [args[2], args[3]]);
    console.log(JSON.stringify({ ok: true, databaseIdentity: 'verified' }));
  } else {
    throw Error(
      'Usage: deployment-maintenance-bootstrap.mjs [--migrate-completed-identity PLAN_SHA256 EVENTS_VOLUME_UUID NATIVE_VOLUME_UUID]',
    );
  }
} catch (error) {
  console.error(JSON.stringify(maintenanceFailureDiagnostic(error)));
  process.exitCode = 1;
}

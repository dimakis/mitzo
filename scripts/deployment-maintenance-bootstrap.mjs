import 'dotenv/config';
import { validateMaintenanceBootstrap } from '../dist/deployment-maintenance-bootstrap.js';
import { maintenanceFailureDiagnostic } from '../dist/deployment-maintenance-format.js';
try {
  validateMaintenanceBootstrap();
} catch (error) {
  console.error(JSON.stringify(maintenanceFailureDiagnostic(error)));
  process.exitCode = 1;
}

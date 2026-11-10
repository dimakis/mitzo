// Production and development HTTP-server entry points import index.ts.
// Configuration precedes retained-proof checks.
import 'dotenv/config';
import { validateMaintenanceBootstrap } from './deployment-maintenance-bootstrap.js';
import { maintenanceFailureDiagnostic } from './deployment-maintenance-format.js';

try {
  validateMaintenanceBootstrap();
} catch (error) {
  // Stop synchronously during dependency evaluation, before sibling app imports.
  // Parser snippets, private rows and continuation capabilities stay private.
  console.error(JSON.stringify(maintenanceFailureDiagnostic(error)));
  process.exit(1);
}

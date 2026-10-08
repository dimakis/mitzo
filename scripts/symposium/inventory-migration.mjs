#!/usr/bin/env node
import {
  inventorySymposiumMigration,
  rehearseApplicationRollback,
} from '../../dist/symposium-migration-inventory.js';

if (process.argv.length !== 7) {
  process.stderr.write(
    'Usage: node scripts/symposium/inventory-migration.mjs ABS_CONVERSATIONS_DB ABS_EVENTS_DB ABS_SESSION_ARTIFACTS_DB ABS_ARTIFACT_LEASES_DB ABS_CAPABILITIES_DB\n',
  );
  process.exitCode = 2;
} else {
  try {
    const inventory = inventorySymposiumMigration({
      conversationDb: process.argv[2],
      eventDb: process.argv[3],
      artifactDb: process.argv[4],
      leaseDb: process.argv[5],
      capabilityDb: process.argv[6],
    });
    process.stdout.write(
      `${JSON.stringify({ inventory, applicationRollback: rehearseApplicationRollback(inventory) }, null, 2)}\n`,
    );
  } catch {
    process.stderr.write(
      'Migration inventory unavailable; retain current data and rollback fence.\n',
    );
    process.exitCode = 1;
  }
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import {
  joinedShards,
  selectJoinedShard,
  requireJoinedReport,
} from '../tests/integration/telos-s9/integrated-candidate/joined-shards.mjs';

try {
  const needs = JSON.parse(process.env.CI_JOINED_NEEDS ?? '{}');
  if (needs['ordinary-joined']?.result !== 'success')
    throw Error('Every joined acceptance shard must succeed');
  const root = process.argv[2];
  for (const shard of Object.keys(joinedShards)) {
    const selected = selectJoinedShard(shard);
    const summary = JSON.parse(
      readFileSync(join(root, `required-summary-${shard.replace('/', '-of-')}.json`), 'utf8'),
    );
    if (
      summary.length !== selected.length ||
      new Set(summary.map((entry) => entry.name)).size !== selected.length ||
      selected.some(
        (entry) => !summary.some((value) => value.name === entry.name && value.status === 'passed'),
      )
    )
      throw Error('Incomplete or duplicated joined shard: ' + shard);
    for (const entry of selected)
      requireJoinedReport(
        JSON.parse(readFileSync(join(root, entry.name, 'run.json'), 'utf8')),
        entry,
      );
  }
  console.log('All twelve joined groups and fourteen actual App cases passed exactly once');
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import {
  joinedShards,
  selectJoinedShard,
  requireJoinedReport,
} from '../tests/integration/telos-s9/integrated-candidate/joined-shards.mjs';

export function requireJoinedEvidence(root, needs) {
  const selection = needs.changes?.outputs?.ordinary;
  if (needs.changes?.result !== 'success' || !['true', 'false'].includes(selection))
    throw Error('Joined acceptance selection did not succeed');
  if (selection === 'false') {
    if (needs['ordinary-joined']?.result !== 'skipped')
      throw Error('Unselected joined acceptance must be skipped');
    return false;
  }
  if (needs['ordinary-joined']?.result !== 'success')
    throw Error('Every joined acceptance shard must succeed');
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
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const selected = requireJoinedEvidence(
      process.argv[2],
      JSON.parse(process.env.CI_JOINED_NEEDS ?? '{}'),
    );
    console.log(
      selected
        ? 'All twelve joined groups and fourteen actual App cases passed exactly once'
        : 'Joined acceptance was explicitly unselected',
    );
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}

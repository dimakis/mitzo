import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { preparedConsumerCases, requirePreparedConsumerReport } from './ci-prepared-consumers.mjs';

export function requirePreparedConsumerEvidence(root, needs) {
  if (
    needs.changes?.result === 'success' &&
    needs.changes.outputs?.prepared === 'false' &&
    needs['prepared-consumers']?.result === 'skipped'
  )
    return false;
  if (needs['prepared-consumers']?.result !== 'success')
    throw Error('Every composed prepared consumer group must succeed');
  const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
  for (const selected of preparedConsumerCases) {
    const summary = read(`summary-${selected.name}.json`);
    if (
      !Array.isArray(summary) ||
      summary.length !== 1 ||
      summary[0].name !== selected.name ||
      summary[0].file !== selected.file ||
      summary[0].cases !== selected.cases.length ||
      summary[0].status !== 'passed'
    )
      throw Error('Incomplete or duplicated prepared consumer group: ' + selected.name);
    const exit = read(`${selected.name}/exit.json`);
    if (exit.code !== 0 || exit.signal || exit.error || exit.interruptedBy)
      throw Error('Prepared consumer process did not complete: ' + selected.name);
    requirePreparedConsumerReport(read(`${selected.name}/run.json`), selected);
  }
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const selected = requirePreparedConsumerEvidence(
      process.argv[2],
      JSON.parse(process.env.CI_PREPARED_NEEDS ?? '{}'),
    );
    console.log(
      selected
        ? 'All seven composed prepared repository cases passed exactly once'
        : 'Prepared consumers were explicitly unselected',
    );
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
import process from 'node:process';
import console from 'node:console';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  constants,
} from 'node:fs';
import { assessStagingReplicaProfiles } from './lib/staging-replica-profiles.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { StagingPipelineStore } from './lib/staging-pipeline-store.mjs';
import { runStagingPipelineRequest } from './lib/staging-pipeline-worker.mjs';
import {
  runStagingHostCommand,
  createStagingPipelineEffects,
  observeMacStagingResources,
} from './lib/staging-pipeline-host.mjs';
import { assessStagingResources, STAGING_RESOURCE_BUDGET } from './lib/staging-resource-budget.mjs';
import { assertVisibleTrackedIndex } from './lib/staging-files.mjs';

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export function parseStagingPipelineArguments(args) {
  const [command, ...rest] = args;
  if (['--help', 'status', 'host-resources', 'run-next'].includes(command) && !rest.length)
    return { command };
  if (
    command === 'replica-check' &&
    rest.length === 4 &&
    rest[0] === '--reference' &&
    rest[2] === '--stage'
  )
    return { command, reference: rest[1], stage: rest[3] };
  if (
    ['cancel', 'receipt'].includes(command) &&
    rest.length === 2 &&
    rest[0] === '--id' &&
    identifier.test(rest[1])
  )
    return { command, id: rest[1] };
  if (command === 'enqueue' && rest.length === 4) {
    const flags = {};
    for (let i = 0; i < rest.length; i += 2) {
      if (!['--pr', '--task'].includes(rest[i]) || flags[rest[i]])
        throw Error('Unsupported staging arguments');
      flags[rest[i]] = rest[i + 1];
    }
    const pr = Number(flags['--pr']);
    if (Number.isSafeInteger(pr) && pr > 0 && identifier.test(flags['--task']))
      return { command, pr, taskId: flags['--task'] };
  }
  throw Error('Unsupported staging arguments');
}
export function enqueueMergedStagingRequest(store, { pr, taskId }, run = runStagingHostCommand) {
  const info = JSON.parse(
    run('gh', ['pr', 'view', String(pr), '--repo', 'dimakis/mitzo', '--json', 'state,mergeCommit']),
  );
  const acceptedCommit = info.mergeCommit?.oid;
  if (info.state !== 'MERGED' || !/^[a-f0-9]{40}$/.test(acceptedCommit ?? ''))
    throw Error('Only an accepted merged PR can enter staging');
  const id = createHash('sha256')
    .update(JSON.stringify([pr, taskId, acceptedCommit, 'http-readiness']))
    .digest('hex');
  store.enqueue({ id, pr, taskId, acceptedCommit, suite: 'http-readiness' });
  return { requestId: id, acceptedCommit, state: 'queued', suite: 'http-readiness' };
}
export function readStagingPipelineReceipt(database, id) {
  if (!identifier.test(id)) throw Error('Exact request identifier required');
  if (!lstatSync(database, { throwIfNoEntry: false }))
    return { version: 1, requestId: id, state: 'missing' };
  const store = new StagingPipelineStore(database, { readOnly: true });
  try {
    return store.receipt(id);
  } finally {
    store.close();
  }
}
function assertAcceptedController(sourceRoot) {
  const git = (args) =>
    runStagingHostCommand('git', [
      '-C',
      sourceRoot,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ]);
  const main = JSON.parse(
    runStagingHostCommand('gh', ['api', 'repos/dimakis/mitzo/commits/main']),
  ).sha;
  if (
    git(['rev-parse', '--show-toplevel']) !== sourceRoot ||
    git(['rev-parse', 'HEAD']) !== main ||
    git(['remote', 'get-url', 'origin']) !== 'https://github.com/dimakis/mitzo.git' ||
    git(['status', '--porcelain', '--untracked-files=all'])
  )
    throw Error('Clean exact accepted pipeline controller required');
  assertVisibleTrackedIndex(git(['ls-files', '-v']));
}
export function checkStagingReplicaSnapshots(referencePath, stagePath) {
  const read = (path) => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 65536) throw Error('Bounded public snapshot required');
      const bytes = readFileSync(fd);
      if (bytes.length > 65536) throw Error('Bounded public snapshot required');
      return JSON.parse(bytes.toString('utf8'));
    } finally {
      closeSync(fd);
    }
  };
  return assessStagingReplicaProfiles(read(referencePath), read(stagePath));
}
async function main() {
  const args = parseStagingPipelineArguments(process.argv.slice(2));
  if (args.command === '--help') {
    console.log(
      'staging-pipeline enqueue --pr NUMBER --task SESSION_ID\nstaging-pipeline status\nstaging-pipeline receipt --id REQUEST_ID\nstaging-pipeline host-resources\nstaging-pipeline run-next\nstaging-pipeline cancel --id REQUEST_ID\nstaging-pipeline replica-check --reference PUBLIC_REFERENCE_JSON --stage PUBLIC_STAGE_JSON',
    );
    return;
  }
  if (args.command === 'replica-check') {
    const result = checkStagingReplicaSnapshots(args.reference, args.stage);
    console.log(JSON.stringify(result));
    if (!result.configurationMatches) process.exitCode = 2;
    return;
  }
  if (args.command === 'host-resources') {
    const observation = observeMacStagingResources();
    console.log(
      JSON.stringify({
        observation,
        budget: STAGING_RESOURCE_BUDGET,
        ...assessStagingResources(observation),
      }),
    );
    return;
  }
  const root = join(homedir(), '.local/share/mitzo-staging-pipeline'),
    database = join(root, 'queue.db');
  if (args.command === 'receipt') {
    console.log(JSON.stringify(readStagingPipelineReceipt(database, args.id)));
    return;
  }
  if (args.command === 'status' && !existsSync(database)) {
    console.log(JSON.stringify({ reservation: { state: 'idle' }, requests: [] }));
    return;
  }
  if (args.command === 'run-next')
    assertAcceptedController(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  const store = new StagingPipelineStore(database);
  try {
    let result;
    if (args.command === 'enqueue') result = enqueueMergedStagingRequest(store, args);
    else if (args.command === 'cancel') {
      store.cancel(args.id);
      result = { requestId: args.id, state: 'cancelled' };
    } else if (args.command === 'status') result = store.status();
    else
      result = await runStagingPipelineRequest(
        store,
        createStagingPipelineEffects(),
        'controller-' + process.pid + '-' + randomUUID(),
      );
    console.log(JSON.stringify(result));
  } finally {
    store.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('Staging pipeline refused or uncertain; inspect queue and canonical evidence.');
    process.exitCode = 1;
  });

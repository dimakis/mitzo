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
import { reconcileStagingSourceMerge } from './lib/staging-source-merge.mjs';

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export function parseStagingPipelineArguments(args) {
  const [command, ...rest] = args;
  if (['merge-admit', 'merge-dispatch', 'merge-release', 'merge-reconcile'].includes(command)) {
    const names =
      command === 'merge-reconcile'
        ? ['--pr']
        : command === 'merge-admit'
          ? ['--pr', '--head']
          : ['--pr', '--head', '--epoch', '--nonce'];
    if (rest.length !== names.length * 2 || names.some((name, i) => rest[i * 2] !== name))
      throw Error('Exact source merge arguments required');
    const pr = Number(rest[1]),
      head = rest[3],
      epoch = Number(rest[5]),
      nonce = rest[7];
    if (
      !Number.isSafeInteger(pr) ||
      pr < 1 ||
      (command !== 'merge-reconcile' && !/^[a-f0-9]{40}$/.test(head)) ||
      (names.length === 4 &&
        (!Number.isSafeInteger(epoch) || epoch < 1 || !/^[a-f0-9-]{36}$/.test(nonce)))
    )
      throw Error('Exact source merge arguments required');
    return {
      command,
      pr,
      ...(head ? { head } : {}),
      ...(names.length === 4 ? { epoch, nonce } : {}),
    };
  }
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
    ['cancel', 'receipt', 'feature-plan'].includes(command) &&
    rest.length === 2 &&
    rest[0] === '--id' &&
    identifier.test(rest[1])
  )
    return { command, id: rest[1] };
  if (
    command === 'run-next' &&
    rest.length === 2 &&
    rest[0] === '--feature-plan' &&
    /^[a-f0-9]{64}$/.test(rest[1])
  )
    return { command, featurePlanSha256: rest[1] };
  const feature = command === 'enqueue-feature';
  if ((command === 'enqueue' && rest.length === 4) || (feature && rest.length === 6)) {
    const flags = {};
    for (let i = 0; i < rest.length; i += 2) {
      if (
        !(feature ? ['--pr', '--task', '--profile'] : ['--pr', '--task']).includes(rest[i]) ||
        flags[rest[i]]
      )
        throw Error('Unsupported staging arguments');
      flags[rest[i]] = rest[i + 1];
    }
    const pr = Number(flags['--pr']);
    if (
      Number.isSafeInteger(pr) &&
      pr > 0 &&
      identifier.test(flags['--task']) &&
      (!feature || identifier.test(flags['--profile']))
    )
      return {
        command,
        pr,
        taskId: flags['--task'],
        ...(feature ? { profileId: flags['--profile'] } : {}),
      };
  }
  throw Error('Unsupported staging arguments');
}
export async function enqueueMergedFeatureRequest(
  store,
  { pr, taskId, profileId },
  effects,
  run = runStagingHostCommand,
) {
  const info = JSON.parse(
    run('gh', ['pr', 'view', String(pr), '--repo', 'dimakis/mitzo', '--json', 'state,mergeCommit']),
  );
  const acceptedCommit = info.mergeCommit?.oid;
  if (info.state !== 'MERGED' || !/^[a-f0-9]{40}$/.test(acceptedCommit ?? ''))
    throw Error('Only an accepted merged PR can enter feature staging');
  const enrollment = await effects.lookupEnrollment(profileId);
  if (enrollment?.profileId !== profileId || !/^[a-f0-9]{64}$/.test(enrollment.enrollmentRevision))
    throw Error('Fresh reviewed staging profile enrollment required');
  const request = {
    version: 2,
    pr,
    taskId,
    acceptedCommit,
    suite: 'profile-tools-v1',
    profileId,
    enrollmentRevision: enrollment.enrollmentRevision,
  };
  const id = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  store.enqueue({ ...request, id });
  return {
    version: 2,
    requestId: id,
    acceptedCommit,
    state: 'queued',
    suite: request.suite,
    profileId,
    enrollmentRevision: request.enrollmentRevision,
  };
}
export async function readStagingFeaturePlan(database, id, effects) {
  const receipt = readStagingPipelineReceipt(database, id);
  if (receipt.state !== 'queued' || receipt.suite !== 'profile-tools-v1')
    throw Error('Exact queued feature request required');
  const request = {
    version: 2,
    id: receipt.requestId,
    pr: receipt.pr,
    taskId: receipt.taskId,
    acceptedCommit: receipt.acceptedCommit,
    suite: receipt.suite,
    profileId: receipt.profileId,
    enrollmentRevision: receipt.enrollmentRevision,
  };
  const source = await effects.baseline(request.acceptedCommit);
  const current = await effects.check();
  if (!current.safe || current.expected !== source)
    throw Error('Exact accepted feature stage source required');
  const plan = await effects.featurePlan(request, source);
  return {
    version: 1,
    requestId: id,
    state: 'queued',
    featurePlan: plan.publicPlan,
    featurePlanSha256: plan.planSha256,
  };
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
function assertAcceptedController(sourceRoot, { current = true } = {}) {
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
  const source = git(['rev-parse', 'HEAD']);
  if (!current) {
    const ancestry = JSON.parse(
      runStagingHostCommand('gh', ['api', `repos/dimakis/mitzo/compare/${source}...main`]),
    );
    if (!['ahead', 'identical'].includes(ancestry.status) || ancestry.base_commit?.sha !== source)
      throw Error('Accepted source fence controller required');
  }
  if (
    git(['rev-parse', '--show-toplevel']) !== sourceRoot ||
    (current && source !== main) ||
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
      'staging-pipeline enqueue --pr NUMBER --task SESSION_ID\nstaging-pipeline enqueue-feature --pr NUMBER --task SESSION_ID --profile STAGE_PROFILE_ID\nstaging-pipeline feature-plan --id REQUEST_ID\nstaging-pipeline status\nstaging-pipeline receipt --id REQUEST_ID\nstaging-pipeline host-resources\nstaging-pipeline run-next [--feature-plan SHA256]\nstaging-pipeline cancel --id REQUEST_ID\nstaging-pipeline replica-check --reference PUBLIC_REFERENCE_JSON --stage PUBLIC_STAGE_JSON',
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
  if (args.command === 'feature-plan') {
    assertAcceptedController(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
    console.log(
      JSON.stringify(
        await readStagingFeaturePlan(database, args.id, createStagingPipelineEffects()),
      ),
    );
    return;
  }
  if (args.command === 'status' && !existsSync(database)) {
    console.log(JSON.stringify({ reservation: { state: 'idle' }, requests: [] }));
    return;
  }
  if (args.command === 'run-next')
    assertAcceptedController(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  if (args.command.startsWith('merge-'))
    assertAcceptedController(resolve(dirname(fileURLToPath(import.meta.url)), '..'), {
      current: false,
    });
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  const store = new StagingPipelineStore(database);
  try {
    let result;
    if (args.command === 'merge-admit')
      result = { version: 1, ...store.claimSourceMerge({ pr: args.pr, head: args.head }) };
    else if (args.command === 'merge-dispatch' || args.command === 'merge-release') {
      const token = { pr: args.pr, head: args.head, epoch: args.epoch, nonce: args.nonce };
      if (args.command === 'merge-dispatch') store.markSourceMergeDispatched(token);
      else store.releaseSourceMerge(token);
      result = {
        version: 1,
        state: args.command === 'merge-dispatch' ? 'dispatched' : 'released',
        pr: args.pr,
        head: args.head,
      };
    } else if (args.command === 'merge-reconcile')
      result = { version: 1, ...reconcileStagingSourceMerge(store, args.pr) };
    else if (args.command === 'enqueue') result = enqueueMergedStagingRequest(store, args);
    else if (args.command === 'enqueue-feature')
      result = await enqueueMergedFeatureRequest(store, args, createStagingPipelineEffects());
    else if (args.command === 'cancel') {
      store.cancel(args.id);
      result = { requestId: args.id, state: 'cancelled' };
    } else if (args.command === 'status') result = store.status();
    else
      result = await runStagingPipelineRequest(
        store,
        createStagingPipelineEffects(),
        'controller-' + process.pid + '-' + randomUUID(),
        { featurePlanSha256: args.featurePlanSha256 },
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

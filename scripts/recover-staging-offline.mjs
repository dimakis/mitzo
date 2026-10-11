#!/usr/bin/env node
import process from 'node:process';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, basename, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  observeOfflineContainment,
  qualifyOfflineContainmentController,
} from './lib/staging-offline-containment-observation.mjs';
import {
  createOfflineContainmentPlan,
  offlineContainmentDigest,
} from './lib/staging-offline-containment-contract.mjs';
import {
  createOfflineOrdinaryRestorationPlan,
  createOfflineRecoveryProposal,
} from './lib/staging-offline-ordinary-restore.mjs';
import { privateJson } from './lib/staging-files.mjs';
import { verifyPreparedController } from './lib/staging-cold-control.mjs';
import {
  createOfflineRecoveryPreparation,
  createOfflineRecoveryPreparationEffects,
} from './lib/staging-offline-prepare.mjs';

const root = join(homedir(), '.local/share/mitzo-staging');
const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function blocked() {
  return {
    version: 1,
    status: 'blocked',
    executable: false,
    fenced: false,
    capacityGrant: false,
    nativeCleanupConfirmed: false,
    blockedReasons: ['unsupported_read_only_command'],
  };
}
function parse(args) {
  const command = args[0];
  const names = {
    audit: ['--operation'],
    plan: ['--operation'],
    'prepare-release': ['--commit', '--dependency-source', '--expected-dependency-fingerprint'],
    apply: ['--plan', '--expected-plan'],
  }[command];
  if (!names || args.length % 2 !== 1) return;
  const flags = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!names.includes(args[i]) || flags[args[i]] !== undefined || !args[i + 1]) return;
    flags[args[i]] = args[i + 1];
  }
  if (flags['--operation'] && !uuid.test(flags['--operation'])) return;
  if (
    command === 'prepare-release' &&
    (!/^[a-f0-9]{40}$/.test(flags['--commit'] ?? '') ||
      !/^[a-f0-9]{64}$/.test(flags['--expected-dependency-fingerprint'] ?? '') ||
      !isAbsolute(flags['--dependency-source'] ?? ''))
  )
    return;
  if (
    command === 'apply' &&
    (!/^[a-f0-9]{64}$/.test(flags['--expected-plan'] ?? '') || !isAbsolute(flags['--plan'] ?? ''))
  )
    return;
  return { command, flags };
}
async function preparedSource() {
  await qualifyOfflineContainmentController({ canonicalRoot: root, sourceRoot });
  const receipt = privateJson(join(sourceRoot, 'staging-release.json'));
  return verifyPreparedController(root, sourceRoot, receipt.sourceCommit);
}
async function collectProposal(operationId, deps) {
  const observation = await (deps.observe ?? observeOfflineContainment)({
    canonicalRoot: root,
    sourceRoot,
    operationId,
  });
  if (observation.status !== 'proposal') return observation;
  const containmentPlan = createOfflineContainmentPlan(observation.facts);
  const collect =
    deps.collectOrdinaryFacts ??
    (async ({ containmentPlan }) => {
      const receipt = await preparedSource();
      const { collectOfflineOrdinaryRestorationFacts } =
        await import('./lib/staging-offline-ordinary-effects.mjs');
      return collectOfflineOrdinaryRestorationFacts({
        containmentPlan,
        sourceCommit: receipt.sourceCommit,
        assertAcceptedPreparedSource: preparedSource,
      });
    });
  const facts = await collect({ containmentPlan });
  return createOfflineRecoveryProposal({
    containmentPlan,
    ordinaryPlan: createOfflineOrdinaryRestorationPlan(facts),
  });
}

/** Command dependencies are original-controller/test capabilities. The CLI never
 * reads callbacks, authentication or permissions from proposal JSON. */
export async function runOfflineRecovery(args, deps = {}) {
  const parsed = parse(args);
  if (!parsed) return blocked();
  const { command, flags } = parsed;
  if (command === 'prepare-release') {
    const input = {
      target: flags['--commit'],
      dependencySource: flags['--dependency-source'],
      dependencyFingerprint: flags['--expected-dependency-fingerprint'],
    };
    const receipt = await (
      deps.prepare ??
      ((facts) =>
        createOfflineRecoveryPreparation(
          createOfflineRecoveryPreparationEffects({ sourceRoot }),
        ).prepare(facts))
    )(input);
    return deps.prepare
      ? receipt
      : {
          version: 1,
          prepared: receipt.release,
          source: receipt.sourceCommit,
          started: false,
          modelCalls: 0,
          productionActions: [],
        };
  }
  if (command === 'audit')
    return (deps.observe ?? observeOfflineContainment)({
      canonicalRoot: root,
      sourceRoot,
      operationId: flags['--operation'] ?? randomUUID(),
    });
  if (command === 'plan') return collectProposal(flags['--operation'] ?? randomUUID(), deps);
  const selected = await (deps.readPlan ?? privateJson)(flags['--plan']);
  const proposal = createOfflineRecoveryProposal(selected);
  if (
    offlineContainmentDigest(proposal) !== offlineContainmentDigest(selected) ||
    proposal.sha256 !== flags['--expected-plan']
  )
    throw Error('Exact reviewed combined proposal required');
  const current = await collectProposal(basename(proposal.containmentPlan.facts.archiveRoot), deps);
  if (
    current.sha256 !== proposal.sha256 ||
    offlineContainmentDigest(current) !== offlineContainmentDigest(proposal)
  )
    throw Error('Recovery evidence changed; regenerate and review proposal before authentication');
  const apply =
    deps.apply ??
    (async (plan) => {
      const { applyOfflineRecoveryProposal } = await import('./lib/staging-offline-controller.mjs');
      return applyOfflineRecoveryProposal({
        proposal: plan,
        sourceRoot,
        verifySource: preparedSource,
      });
    });
  return apply(proposal);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runOfflineRecovery(process.argv.slice(2));
    console.log(JSON.stringify(result));
    if (result.status === 'blocked') process.exitCode = 1;
  } catch {
    console.error(
      'Canonical offline recovery refused or uncertain. Preserve original state, proposal, archive, intent and deployment guard; no automatic replay.',
    );
    process.exitCode = 1;
  }
}

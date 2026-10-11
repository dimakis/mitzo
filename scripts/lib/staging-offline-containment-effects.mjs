import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createOfflineContainmentPlan } from './staging-offline-containment-contract.mjs';
import {
  qualifyOfflineContainmentController,
  assertOfflineContainmentBeforeMove,
  assertOfflineContainmentContained,
} from './staging-offline-containment-observation.mjs';

/** Original-controller constructor. Dependencies are review/test capabilities,
 * never observations or grants parsed from operator input. No VM command is run. */
export async function createOfflineContainmentEffects(
  { plan: selected, sourceRoot, assertAuthorityCurrent, inspectionOwner, assertGuardContinuation },
  deps = {},
) {
  const plan = createOfflineContainmentPlan(selected.facts);
  if (
    plan.sha256 !== selected.sha256 ||
    typeof assertAuthorityCurrent !== 'function' ||
    !sourceRoot
  )
    throw Error('Exact proposal, qualified source and original live authority required');
  const io = deps.io ?? fs;
  const qualify = deps.qualify ?? qualifyOfflineContainmentController;
  const run =
    deps.command ??
    ((program, args) =>
      spawnSync(program, args, {
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
      }));
  const before =
    inspectionOwner?.assertBeforeMove ??
    deps.assertBeforeMove ??
    assertOfflineContainmentBeforeMove;
  const contained =
    inspectionOwner?.assertContained ?? deps.assertContained ?? assertOfflineContainmentContained;
  let invalidatedControls = [];
  const current = () => {
    if (assertAuthorityCurrent(plan.sha256) !== true)
      throw Error('Original live containment authority refused');
  };
  const qualified = async () => {
    current();
    await qualify({ canonicalRoot: plan.facts.canonicalRoot, sourceRoot });
    current();
  };
  const selectedControl = (input) => {
    const control = plan.facts.controls.find((c) => c.kind === input?.kind);
    if (!control || JSON.stringify(input) !== JSON.stringify(control))
      throw Error('Exact original control required');
    return control;
  };
  const inspectJob = (control) => {
    const result = run('/bin/launchctl', [
      'print',
      `gui/${plan.facts.operatorUid}/${control.label}`,
    ]);
    if (result.error || result.signal) throw Error('Original job observation unavailable');
    return result;
  };
  const absent = (control) => {
    const result = inspectJob(control);
    const diagnostic = result.stderr?.trim();
    const expected = `Could not find service "${control.label}" in domain for user gui: ${plan.facts.operatorUid}`;
    if (
      result.status !== 113 ||
      result.stdout ||
      (diagnostic !== expected && diagnostic !== `Bad request.\n${expected}`)
    )
      throw Error('Original job absence unconfirmed');
  };
  const hashFile =
    deps.hashFile ?? ((path) => createHash('sha256').update(io.readFileSync(path)).digest('hex'));
  const exactFile = (control) => {
    const stat = io.lstatSync(control.path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== control.uid ||
      (stat.mode & 0o777) !== control.mode ||
      io.realpathSync(control.path) !== control.path ||
      hashFile(control.path) !== control.sha256
    )
      throw Error('Original control bytes or metadata changed');
  };
  // Construction qualifies code only; the transaction consumes the private
  // original authority before the first effect. Every effect requalifies both.
  await qualify({ canonicalRoot: plan.facts.canonicalRoot, sourceRoot });
  return Object.freeze({
    assertGuardContinuation,
    async assertBeforeMove(requested, phase) {
      if (requested.sha256 !== plan.sha256) throw Error('Containment proposal changed');
      await qualified();
      await before(plan, phase);
      current();
      invalidatedControls = [...phase.invalidatedControls];
    },
    async assertContained(requested, intent) {
      if (requested.sha256 !== plan.sha256) throw Error('Containment proposal changed');
      await qualified();
      await contained(plan, intent);
      current();
    },
    async assertControlAbsent(input) {
      const control = selectedControl(input);
      await qualified();
      absent(control);
      current();
    },
    async invalidateControl(input) {
      const control = selectedControl(input);
      await qualified();
      await before(plan, { invalidatedControls: [...invalidatedControls] });
      current();
      exactFile(control);
      if (control.kind === 'app') {
        absent(control);
        current();
        return;
      }
      const result = inspectJob(control);
      const field = (name) =>
        result.stdout?.match(new RegExp(`^\\s*${name} = (.+)$`, 'm'))?.[1]?.trim();
      if (
        result.status !== 0 ||
        result.stderr ||
        field('path') !== control.path ||
        field('state') !== 'not running' ||
        field('runs') !== '0' ||
        field('pid')
      )
        throw Error('Exact stopped original VM supervisor required');
      current();
      // Normal removal of the exact already-stopped registration. Never signal a
      // PID, start a VM, destroy native resources or infer retirement from success.
      exactFile(control);
      const stopped = run('/bin/launchctl', [
        'bootout',
        `gui/${plan.facts.operatorUid}/${control.label}`,
      ]);
      current();
      if (stopped.error || stopped.signal || stopped.status !== 0 || stopped.stderr)
        throw Error('Original VM supervisor unload unconfirmed');
      await qualified();
      exactFile(control);
      absent(control);
      current();
    },
  });
}

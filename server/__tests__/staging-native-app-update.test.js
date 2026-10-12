import { expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
const effects = vi.hoisted(() => ({ guard: vi.fn(), completion: vi.fn() }));
vi.mock('../../scripts/lib/staging-native-app-update-guard.mjs', () => ({
  acquireOriginalNativeAppUpdateGuard: effects.guard,
}));
vi.mock('../../scripts/lib/staging-source-acceptance-witness.mjs', () => ({
  SOURCE_HISTORY_SCRATCH_BYTES: 64 * 1024 ** 2,
  createStagingSourceAcceptanceWitness: () => ({
    admit: async () => Object.freeze({}),
    assertCurrent: async () => {},
    close() {},
  }),
}));
vi.mock('../../scripts/lib/staging-cold-control.mjs', () => ({
  verifyPreparedController: () => ({}),
}));
import { createOriginalNativeAppUpdateController } from '../../scripts/lib/staging-native-app-update.mjs';
import { createOriginalNativeAppSourceBridge } from '../../scripts/lib/staging-native-app-source.mjs';

async function fixture() {
  effects.guard.mockReset();
  effects.completion.mockReset();
  const root = join(homedir(), '.local/share/mitzo-staging');
  const original = {
    sourceCommit: 'a'.repeat(40),
    sourceRoot: join(root, 'releases', 'a'.repeat(12)),
    runtimeArtifactsSha256: '1'.repeat(64),
    dependenciesSha256: '2'.repeat(64),
    workspaceDependenciesSha256: '3'.repeat(64),
    controllerSourceSha256: '4'.repeat(64),
    packageInputsSha256: '5'.repeat(64),
    frontendArtifactsSha256: '6'.repeat(64),
  };
  const candidate = {
    ...original,
    sourceCommit: 'b'.repeat(40),
    sourceRoot: join(root, 'releases', 'b'.repeat(12)),
    frontendArtifactsSha256: '7'.repeat(64),
  };
  const inspect = (selected) => (selected === original.sourceCommit ? original : candidate);
  const bridge = createOriginalNativeAppSourceBridge({
    nativeSource: original,
    assertOriginalCustodianCurrent() {},
    inspectSource: inspect,
    assertAcceptedCandidate: async () => {},
  });
  const identity = {
    instanceId: 'actual-original',
    custodianPid: process.pid,
    controllerPid: process.pid + 1,
    epoch: 1,
  };
  bridge.observeChild(await bridge.qualify(original.sourceCommit), identity, () => {});
  let resourceAdmitted = true;
  const lifecycle = [];
  effects.guard.mockImplementation(() => ({
    assertCurrent() {},
    complete(observe) {
      const child = observe();
      effects.completion(child);
      lifecycle.push('durable-original-completion');
    },
  }));
  const replace = vi.fn(async () => {
    lifecycle.push('positive-original-exit');
    const next = { ...identity, controllerPid: process.pid + 2, epoch: 2 };
    bridge.observeChild(controller.observeReadyCandidate(), next, () => {});
    lifecycle.push('actual-new-child-ready');
    return next;
  });
  const controller = createOriginalNativeAppUpdateController({
    root,
    allocation: '11111111-1111-1111-1111-111111111111',
    nativeSourceCommit: original.sourceCommit,
    sourceInspector: { original, inspect },
    appSourceBridge: bridge,
    vmOwner: {
      assertOriginalRunningCurrent() {},
      assertRunningCurrent() {
        if (!resourceAdmitted) throw Error('new work pressure');
        return { aggregateGiB: 30, growthGiB: 1, diskFreeGiB: 40 };
      },
    },
    observeRegisteredOriginal: () => ({}),
    assertOriginalCurrent() {},
    createChildSelection: (input) => input,
    replaceOriginalChild: replace,
  });
  const input = {
    version: 1,
    operation: 'plan',
    expectedCurrent: original.sourceCommit,
    target: candidate.sourceCommit,
    planSha256: null,
    queueProof: 'original-private-run',
  };
  return {
    controller,
    input,
    bridge,
    lifecycle,
    replace,
    pressure() {
      resourceAdmitted = false;
    },
  };
}

it('updates only the accepted app under its new guard and positive higher child identity, preserving original native source', async () => {
  const f = await fixture();
  const planned = await f.controller.plan(f.input, () => {});
  const applied = await f.controller.apply(
    { ...f.input, operation: 'apply', planSha256: planned.planSha256 },
    () => {},
  );
  expect(applied).toMatchObject({
    nativeSourceCommit: f.input.expectedCurrent,
    nativeAllocationChanged: false,
    nativeRetirementClaim: false,
    acceptedAppSource: { acceptedAppCommit: f.input.target, epoch: 2 },
  });
  expect(f.lifecycle).toEqual([
    'positive-original-exit',
    'actual-new-child-ready',
    'durable-original-completion',
  ]);
  expect(effects.guard).toHaveBeenCalledTimes(1);
  expect(effects.completion).toHaveBeenCalledTimes(1);
  await expect(
    f.controller.apply(
      { ...f.input, operation: 'apply', planSha256: planned.planSha256 },
      () => {},
    ),
  ).rejects.toThrow();
  expect(f.replace).toHaveBeenCalledTimes(1);
});
it('keeps the existing actual app when resource admission is lost before any replacement effect and refuses replay', async () => {
  const f = await fixture();
  const planned = await f.controller.plan(f.input, () => {});
  f.pressure();
  const apply = { ...f.input, operation: 'apply', planSha256: planned.planSha256 };
  await expect(f.controller.apply(apply, () => {})).rejects.toThrow();
  await expect(f.controller.apply(apply, () => {})).rejects.toThrow();
  expect(f.bridge.capture().acceptedAppCommit).toBe(f.input.expectedCurrent);
  expect(effects.guard).not.toHaveBeenCalled();
  expect(f.replace).not.toHaveBeenCalled();
  expect(effects.completion).not.toHaveBeenCalled();
});

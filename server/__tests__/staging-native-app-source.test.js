import { expect, it, vi } from 'vitest';
import {
  assertByteCompatibleNativeApp,
  createOriginalNativeAppSourceBridge,
} from '../../scripts/lib/staging-native-app-source.mjs';

const native = {
  sourceCommit: 'a'.repeat(40),
  sourceRoot: '/canonical/releases/' + 'a'.repeat(12),
  runtimeArtifactsSha256: '1'.repeat(64),
  dependenciesSha256: '2'.repeat(64),
  workspaceDependenciesSha256: '3'.repeat(64),
  controllerSourceSha256: '4'.repeat(64),
  packageInputsSha256: '5'.repeat(64),
  frontendArtifactsSha256: '6'.repeat(64),
};
const candidate = {
  ...native,
  sourceCommit: 'b'.repeat(40),
  sourceRoot: '/canonical/releases/' + 'b'.repeat(12),
  frontendArtifactsSha256: '7'.repeat(64),
};
const child = { instanceId: 'original', epoch: 1, custodianPid: 100, controllerPid: 101 };

it('accepts changed frontend only while refusing every retained native/dependency/control difference', () => {
  expect(() => assertByteCompatibleNativeApp(native, candidate)).not.toThrow();
  for (const field of [
    'runtimeArtifactsSha256',
    'dependenciesSha256',
    'workspaceDependenciesSha256',
    'controllerSourceSha256',
    'packageInputsSha256',
  ])
    expect(() =>
      assertByteCompatibleNativeApp(native, { ...candidate, [field]: '9'.repeat(64) }),
    ).toThrow();
});

it('binds accepted app source to original actual child lifetime without rewriting the native source', async () => {
  let alive = true,
    current = true;
  const inspect = vi.fn((commit) => (commit === native.sourceCommit ? native : candidate));
  const bridge = createOriginalNativeAppSourceBridge({
    nativeSource: native,
    assertOriginalCustodianCurrent() {
      if (!alive) throw Error('original custodian lost');
    },
    inspectSource: inspect,
    assertAcceptedCandidate: async () => {},
  });
  const nativeToken = await bridge.qualify(native.sourceCommit);
  bridge.observeChild(nativeToken, child, () => {
    if (!current) throw Error('child lost');
  });
  expect(bridge.capture()).toMatchObject({
    nativeSourceCommit: native.sourceCommit,
    acceptedAppCommit: native.sourceCommit,
    epoch: 1,
  });
  const target = await bridge.qualify(candidate.sourceCommit);
  expect(() =>
    bridge.observeChild(JSON.parse(JSON.stringify(target)), { ...child, epoch: 2 }, () => {}),
  ).toThrow();
  bridge.observeChild(target, { ...child, epoch: 2, controllerPid: 102 }, () => {});
  expect(bridge.capture()).toMatchObject({
    nativeSourceCommit: native.sourceCommit,
    acceptedAppCommit: candidate.sourceCommit,
    epoch: 2,
    controllerPid: 102,
  });
  expect(() => bridge.observeChild(target, { ...child, epoch: 3 }, () => {})).toThrow();
  alive = false;
  expect(() => bridge.capture()).toThrow('original custodian lost');
});

it('refuses source drift, failed acceptance, previous child reuse and failed physical original owner', async () => {
  let inspected = candidate;
  const accepted = vi.fn(async () => {});
  const bridge = createOriginalNativeAppSourceBridge({
    nativeSource: native,
    assertOriginalCustodianCurrent() {},
    inspectSource: (commit) => (commit === native.sourceCommit ? native : inspected),
    assertAcceptedCandidate: accepted,
  });
  const target = await bridge.qualify(candidate.sourceCommit);
  inspected = { ...candidate, frontendArtifactsSha256: '9'.repeat(64) };
  await expect(bridge.assertCandidateCurrent(target)).rejects.toThrow();
  accepted.mockRejectedValue(Error('initially stale main'));
  await expect(bridge.qualify(candidate.sourceCommit)).rejects.toThrow('initially stale main');
  expect(() => bridge.capture()).toThrow();
});
it('expires a pending replacement token while retaining a qualified actual child source after admission expiry', async () => {
  let now = 0;
  const bridge = createOriginalNativeAppSourceBridge({
    nativeSource: native,
    assertOriginalCustodianCurrent() {},
    now: () => now,
    inspectSource: (commit) => (commit === native.sourceCommit ? native : candidate),
    assertAcceptedCandidate: async () => {},
  });
  const initial = await bridge.qualify(native.sourceCommit);
  bridge.observeChild(initial, child, () => {});
  const target = await bridge.qualify(candidate.sourceCommit);
  now = 12 * 60 * 1000;
  expect(() => bridge.observeChild(target, { ...child, epoch: 2 }, () => {})).toThrow();
  await expect(bridge.assertCandidateCurrent(target)).rejects.toThrow();
  expect(bridge.capture().acceptedAppCommit).toBe(native.sourceCommit);
});

it('uses admitted original held source continuity for repeated live child bindings without whole release inspection', async () => {
  const inspect = vi.fn((selected) => (selected === native.sourceCommit ? native : candidate));
  let held = true;
  const close = vi.fn();
  const bridge = createOriginalNativeAppSourceBridge({
    nativeSource: native,
    assertOriginalCustodianCurrent() {},
    inspectSource: inspect,
    assertAcceptedCandidate: async () => {},
    captureSourceContinuity: () => ({
      assertCurrent() {
        if (!held) throw Error('original held source lost');
      },
      closeAfterReplacement: close,
    }),
  });
  bridge.observeChild(await bridge.qualify(native.sourceCommit), child, () => {});
  inspect.mockClear();
  for (let index = 0; index < 100; index++) expect(bridge.capture().epoch).toBe(1);
  expect(inspect).not.toHaveBeenCalled();
  const next = await bridge.qualify(candidate.sourceCommit);
  bridge.observeChild(next, { ...child, epoch: 2, controllerPid: 102 }, () => {});
  expect(close).toHaveBeenCalledTimes(1);
  held = false;
  expect(() => bridge.capture()).toThrow('original held source lost');
});

it('rejects missing continuity capture and nonvoid or asynchronous current assertions', async () => {
  for (const current of [() => true, async () => {}]) {
    const bridge = createOriginalNativeAppSourceBridge({
      nativeSource: native,
      assertOriginalCustodianCurrent() {},
      inspectSource: () => native,
      assertAcceptedCandidate: async () => {},
    });
    const token = await bridge.qualify(native.sourceCommit);
    expect(() => bridge.observeChild(token, child, current)).toThrow();
  }
  const bridge = createOriginalNativeAppSourceBridge({
    nativeSource: native,
    assertOriginalCustodianCurrent() {},
    inspectSource: () => native,
    assertAcceptedCandidate: async () => {},
    captureSourceContinuity: () => undefined,
  });
  const token = await bridge.qualify(native.sourceCommit);
  expect(() => bridge.observeChild(token, child, () => {})).toThrow();
});
